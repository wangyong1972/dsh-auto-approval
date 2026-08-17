import { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { DEFAULTS, type Config as PluginConfig, type ToolCallEvent } from './types.ts';
import { quickCheck } from './quick-check.ts';
import { judge } from './judge.ts';
import { loadPatterns, savePatterns, matchPatterns, learnPattern } from './patterns.ts';
import { compileDangerPatterns, findDangerMatch } from './danger-patterns.ts';
import { loadState, resolveStateFile, saveState, type ApprovalState } from './state.ts';
import {
  readAudit,
  recordAudit,
  renderStats,
  resolveAuditFile,
  summarizeAudit,
} from './audit.ts';

export const name = 'auto-approval';

/** Schemastery validation for {@link PluginConfig}. Omitted fields fall back to DEFAULTS. */
export const Config: z<PluginConfig> = z.object({
  baseUrl: z.string().default(DEFAULTS.baseUrl),
  modelName: z.string().default(DEFAULTS.modelName),
  allowedPatterns: z.array(z.string()).default(['$WORKSPACE/**']),
  deniedPatterns: z.array(z.string()).default([
    '**/.ssh/**',
    '**/etc/shadow',
    '**/etc/passwd',
    '**/.gitconfig',
    '**/.aws/**',
    '**/.kube/**',
  ]),
  confidenceThreshold: z.number().default(DEFAULTS.confidenceThreshold),
  // Path to the learned-patterns file. Omit to disable learning.
  patternFile: z.string().default(''),
  // Danger-command regexes. null keeps the built-in list.
  dangerPatterns: z.union([z.array(z.string()), z.const(null)]).default(null),
  extraDangerPatterns: z.array(z.string()).default([]),
  timeoutMs: z.number().min(1).default(DEFAULTS.timeoutMs),
  // On/off switch file toggled by `/autoapprove on|off` (runtime, no restart).
  stateFile: z.string().default(''),
  // Audit trail: every auto-approval is appended here (what + basis).
  auditFile: z.string().default(''),
});

export function apply(ctx: Context, config: PluginConfig): void {
  // Schema defaults guarantee these are present at runtime.
  const baseUrl = config.baseUrl!;
  const modelName = config.modelName!;
  const threshold = config.confidenceThreshold!;
  const allowed = config.allowedPatterns!;
  const denied = config.deniedPatterns!;
  const patternFile = config.patternFile!;
  const timeoutMs = config.timeoutMs!;

  // Deterministic danger rules compiled once; a match always defers to human.
  const dangerRules = compileDangerPatterns(config.dangerPatterns ?? null, config.extraDangerPatterns ?? []);

  // Runtime on/off switch (`/autoapprove on|off`). When off, every request
  // passes straight through to the normal human approval flow — the plugin is
  // inert, exactly as if it were not loaded. Persisted across restarts.
  const stateFile = resolveStateFile(
    config.stateFile ? { stateFile: config.stateFile, patternFile } : { patternFile },
  );
  const state: ApprovalState = loadState(stateFile);

  // Audit trail of auto-approvals (`/autoapprove stats` reads this).
  const auditFile = resolveAuditFile(config.auditFile);

  // Learned allowances (human-approved operations), keyed by tool name.
  const patterns = loadPatterns(patternFile);
  // Requests the plugin deferred to the human, keyed by approval id, so the
  // decided-event handler knows which approvals to learn from.
  const deferred = new Map<string, { toolName: string; target: string }>();

  if (patternFile) {
    ctx.on(
      'session/event',
      (_session: Session, event: SessionEvent) => {
        if (event.type !== 'approval/decided') return;
        if (event.data.outcome !== 'allowed-once') return;
        const pending = deferred.get(event.data.id);
        if (!pending) return;
        deferred.delete(event.data.id);
        learnPattern(patterns, pending.toolName, pending.target);
        savePatterns(patternFile, patterns);
        console.log(
          `[auto-approval] learned pattern for ${pending.toolName}: ${pending.target.slice(0, 80)}`,
        );
      },
    );
  }

  ctx.on(
    'approval/request',
    async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      // Switch is off: route every request to the human approval flow.
      if (!state.enabled) {
        return next();
      }

      // Only intercept tool-related approvals
      if (!req.toolName) {
        return next();
      }

      // Try to recover the tool call arguments from the session log via callId.
      // This gives us the full file paths, command strings, etc.
      const session = (req.agent as unknown as { session?: Session }).session;
      let toolArgs: string | undefined;
      if (req.callId && session) {
        toolArgs = recoverToolArgs(session, req.callId as unknown as string);
      }

      // The real workspace root for this session: the session header's cwd
      // (the project directory the session was created in). Falling back to
      // process.cwd() would widen the allow-list to the DSH process's working
      // directory (often the whole home directory), silently auto-approving
      // every write under it.
      const workspaceRoot = session?.header?.cwd ?? process.cwd();

      // Extract the pure file path or command from toolArgs (the raw JSON
      // string may contain content that mentions deny keywords like ".ssh"
      // or "/etc/" and would falsely trigger the deny-list).
      const target = extractTarget(req.toolName, toolArgs) ?? req.reason ?? req.toolName;

      // 0. Deterministic danger-command check on the raw tool arguments.
      //    A match defers to the human; the classifier AND learned patterns
      //    can never override it — a one-time approval of a destructive
      //    command must not become a permanent exemption.
      const danger = findDangerMatch(`${req.reason ?? ''}\n${toolArgs ?? ''}`, dangerRules);
      if (danger !== undefined) {
        console.log(`[auto-approval] danger pattern matched: ${danger.source}`);
        const approvalId = pendingApprovalId(session, req.callId);
        if (approvalId && patternFile) {
          deferred.set(approvalId, { toolName: req.toolName, target });
        }
        return next();
      }

      // 1. Learned patterns: the human already approved this kind of
      //    operation, so approve without prompting or judging.
      if (patternFile) {
        const learned = matchPatterns(patterns, req.toolName, target);
        if (learned) {
          recordAudit(auditFile, { time: new Date().toISOString(), tool: req.toolName, target, basis: 'learned' });
          return 'allowed-once' as ApprovalOutcome;
        }
      }

      // 2. Quick-path check (glob matching — no LLM call)
      const quick = quickCheck(req.toolName, target, workspaceRoot, allowed, denied);
      if (quick === 'deny' || quick === 'allow') {
        if (quick === 'allow') {
          recordAudit(auditFile, { time: new Date().toISOString(), tool: req.toolName, target, basis: 'allow' });
          return 'allowed-once' as ApprovalOutcome;
        }
        // Deny-list hit: do NOT silently reject — defer to the human so they
        // keep the final say. The approval UI shows the tool and reason.
        const approvalId = pendingApprovalId(session, req.callId);
        if (approvalId && patternFile) {
          deferred.set(approvalId, { toolName: req.toolName, target });
        }
        return next();
      }

      // 3. LLM judge via LM Studio (strict two-value verdict, timeout-guarded)
      const judgeStart = Date.now();
      const verdict = await judge(
        req.toolName,
        toolArgs,
        req.reason,
        baseUrl,
        modelName,
        req.signal,
        timeoutMs,
      );
      const judgeLatencyMs = Date.now() - judgeStart;

      if (verdict !== undefined && verdict.verdict === 'approve') {
        recordAudit(auditFile, {
          time: new Date().toISOString(),
          tool: req.toolName,
          target,
          basis: 'judge',
          latencyMs: judgeLatencyMs,
        });
        return 'allowed-once' as ApprovalOutcome;
      }

      // 4. Anything else (ask, timeout, malformed, error) → delegate to human.
      //    If they approve, the decided-event handler learns the target.
      const approvalId = pendingApprovalId(session, req.callId);
      if (approvalId && patternFile) {
        deferred.set(approvalId, { toolName: req.toolName, target });
      }
      return next();
    },
    // Prepend: approval/request is a waterfall; the apiproxy UI answerer is
    // registered earlier and consumes requests without calling next(), so
    // this listener must run first to see the request at all.
    { prepend: true },
  );

  // Runtime `/autoapprove on|off|status` command. Registered through an
  // injected child so the approval responder never depends on the commands
  // service being loaded; the register disposer unregisters on teardown.
  ctx.inject(['commands'], (commandCtx) =>
    commandCtx.commands.register({
      name: 'autoapprove',
      description: 'Turn auto-approval on or off, or show audit stats, at runtime',
      input: { hint: 'on | off | status | stats' },
      handler: (invocation: CommandInvocation): CommandResult =>
        executeAutoapproveCommand(invocation, state, stateFile, auditFile),
    }),
  );

  console.log(
    `[auto-approval] Active (state=${state.enabled ? 'on' : 'off'}, model=${modelName}, threshold=${threshold}${patternFile ? `, patterns=${patternFile}` : ''}, danger=${dangerRules.length} rules, stateFile=${stateFile}, auditFile=${auditFile})`,
  );
}

/**
 * Handler for `/autoapprove on|off|status|stats`. Flips the runtime switch,
 * persists it, or renders the audit roll-up. Unknown input reports status
 * with usage rather than failing.
 */
function executeAutoapproveCommand(
  invocation: CommandInvocation,
  state: ApprovalState,
  stateFile: string,
  auditFile: string,
): CommandResult {
  const arg = invocation.rawInput.trim().toLowerCase();
  const statusText = `auto-approval is currently ${state.enabled ? 'ON' : 'OFF'}`;

  if (arg === 'on' || arg === 'enable') {
    state.enabled = true;
    saveState(stateFile, state);
    return {
      kind: 'success',
      text: 'auto-approval is now ON — safe permission requests are auto-approved by the local judge. (persisted, no restart needed)',
    };
  }
  if (arg === 'off' || arg === 'disable') {
    state.enabled = false;
    saveState(stateFile, state);
    return {
      kind: 'success',
      text: 'auto-approval is now OFF — every permission request goes to the human approval UI. (persisted, no restart needed)',
    };
  }
  if (arg === 'stats' || arg === 'log' || arg === 'audit') {
    const stats = summarizeAudit(readAudit(auditFile));
    return {
      kind: 'success',
      text: renderStats(stats, state.enabled),
    };
  }

  // No argument or unknown input: report status and usage.
  return {
    kind: 'success',
    text: `${statusText}. Usage: /autoapprove on|off|status|stats`,
  };
}

/**
 * Find the approval/asked event id for the current call, so a later
 * approval/decided event can be correlated for learning. Returns undefined
 * when the asked event is not yet in the log (dispatch runs on a microtask
 * after the asked append) or the call has no id.
 */
function pendingApprovalId(
  session: Session | undefined,
  callId: string | undefined,
): string | undefined {
  if (!session || !callId) return undefined;
  const events = session.events as readonly SessionEvent[];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'approval/asked' && ev.data.callId === callId) {
      return ev.data.id;
    }
  }
  return undefined;
}

/**
 * Extract the pure file path or command from JSON tool arguments, ignoring
 * any content payload. Returns undefined when nothing usable is found.
 */
function extractTarget(toolName: string, args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (toolName === 'bash') {
      const command = parsed.command;
      return typeof command === 'string' ? command : undefined;
    }
    const filePath = parsed.file_path ?? parsed.target ?? parsed.path;
    return typeof filePath === 'string' ? filePath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Search the session log for a tool/call event matching the given callId
 * and return its JSON-stringified arguments.
 */
function recoverToolArgs(session: Session, callId: string): string | undefined {
  const events = session.events as readonly ToolCallEvent[];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'tool/call' && ev.data.callId === callId) {
      return ev.data.arguments;
    }
  }
  return undefined;
}
