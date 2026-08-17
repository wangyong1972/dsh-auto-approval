import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Auto-approval audit trail.
 *
 * Every request the plugin auto-approves is appended as one JSON line to an
 * audit file, recording *what* was approved and *on what basis* (learned
 * pattern, allow-list, or LLM judge). A `/autoapprove stats` command reads
 * the file to show how many manual approvals were saved.
 *
 * @module dsh-auto-approval/audit
 */

/** The decision path that auto-approved a request. */
export type AuditBasis = 'learned' | 'allow' | 'judge';

/** One auto-approval record. */
export interface AuditEntry {
  /** ISO timestamp of the decision. */
  time: string;
  /** Tool that requested approval (e.g. `bash`, `edit`). */
  tool: string;
  /** The extracted target (command or file path), truncated for storage. */
  target: string;
  /** Why it was auto-approved: learned pattern / allow-list / judge. */
  basis: AuditBasis;
  /** Classifier latency in ms (only for `judge` decisions). */
  latencyMs?: number;
}

/** Rolled-up statistics over audit entries. */
export interface AuditStats {
  /** Total auto-approvals recorded. */
  total: number;
  /** Auto-approvals grouped by basis. */
  byBasis: Record<string, number>;
  /** Auto-approvals recorded today (UTC date). */
  today: number;
  /** Most recent entries, newest first. */
  latest: AuditEntry[];
}

/** Trim the audit file once it exceeds this size. */
const MAX_AUDIT_BYTES = 1_000_000;
/** Lines kept after a trim. */
const MAX_AUDIT_LINES = 2000;
/** Target text is truncated to this length when stored. */
const TARGET_MAX = 120;

/**
 * Resolve the audit file path: an explicit `auditFile` config wins,
 * otherwise `~/.dsh/auto-approval-audit.jsonl`.
 */
export function resolveAuditFile(auditFile: string | undefined): string {
  if (auditFile) return auditFile;
  return join(homedir(), '.dsh', 'auto-approval-audit.jsonl');
}

/**
 * Append one auto-approval record. Failures are logged and swallowed —
 * auditing must never break approval.
 */
export function recordAudit(file: string, entry: AuditEntry): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({
        ...entry,
        target: entry.target.length > TARGET_MAX ? `${entry.target.slice(0, TARGET_MAX)}…` : entry.target,
      }) + '\n',
      'utf8',
    );
    trimIfOversized(file);
  } catch (error) {
    console.error(`[auto-approval] failed to write audit: ${String(error)}`);
  }
}

/** Rewrite the file keeping only the most recent lines once it grows too large. */
function trimIfOversized(file: string): void {
  try {
    if (statSync(file).size <= MAX_AUDIT_BYTES) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, lines.slice(-MAX_AUDIT_LINES).join('\n') + '\n', 'utf8');
  } catch {
    /* swallowing trim failures keeps auditing non-fatal */
  }
}

/** Read all audit entries (skipping any corrupt lines). */
export function readAudit(file: string): AuditEntry[] {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Summarize audit entries: totals, per-basis counts, today's count, latest. */
export function summarizeAudit(entries: AuditEntry[]): AuditStats {
  const byBasis: Record<string, number> = {};
  const todayStr = new Date().toISOString().slice(0, 10);
  let today = 0;
  for (const entry of entries) {
    byBasis[entry.basis] = (byBasis[entry.basis] ?? 0) + 1;
    if (entry.time.slice(0, 10) === todayStr) today++;
  }
  return {
    total: entries.length,
    byBasis,
    today,
    latest: entries.slice(-8).reverse(),
  };
}

/** Render the stats summary as the `/autoapprove stats` command output. */
export function renderStats(stats: AuditStats, enabled: boolean): string {
  const basis = Object.entries(stats.byBasis)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ') || 'none yet';
  const lines = [
    `auto-approval: ${enabled ? 'ON' : 'OFF'} — audit total=${stats.total}, today=${stats.today}`,
    `  basis: ${basis}`,
  ];
  if (stats.latest.length > 0) {
    lines.push('  latest:');
    for (const entry of stats.latest) {
      const t = entry.time.slice(11, 19);
      const lat = entry.latencyMs !== undefined ? ` (${entry.latencyMs}ms)` : '';
      lines.push(`    ${t} ${entry.tool} ${entry.basis}${lat}: ${entry.target}`);
    }
  }
  return lines.join('\n');
}
