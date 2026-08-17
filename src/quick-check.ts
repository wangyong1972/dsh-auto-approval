import type { QuickResult } from './types.ts';

/**
 * Quick-path check — no LLM call needed.
 *
 * Uses the tool name and the available context (reason text, or recovered
 * arguments from the session log) to make fast allow/deny decisions.
 *
 * Allow-list (auto-approve):
 * - `read`, `read_image` tools (read-only, no side effects)
 * - Any target under the workspace root
 *
 * Deny-list (auto-reject):
 * - Targets under sensitive system paths (~/.ssh, /etc, etc.)
 *
 * Everything else → unsure (delegate to LLM).
 */
export function quickCheck(
  toolName: string,
  /** Parsed target from tool arguments (JSON), or the raw reason text as fallback. */
  target: string,
  workspaceRoot: string,
  allowedPatterns: string[],
  deniedPatterns: string[],
): QuickResult {
  // 1. Deny-list check — must run BEFORE the read-only shortcut so that
  //    sensitive reads (e.g. ~/.ssh/id_rsa) are rejected, not auto-allowed.
  for (const pattern of deniedPatterns) {
    if (matchGlob(target, pattern)) {
      return 'deny';
    }
  }

  // 2. Read-only tools are safe (no side effects)
  if (toolName === 'read' || toolName === 'read_image') {
    return 'allow';
  }

  // 3. Allow-list check — workspace root is implicitly allowed
  if (matchGlob(target, `${workspaceRoot}/**`)) {
    return 'allow';
  }
  for (const pattern of allowedPatterns) {
    if (matchGlob(target, pattern)) {
      return 'allow';
    }
  }

  return 'unsure';
}

/**
 * Minimal glob matcher.
 * Supports `**` (cross-directory), `*` (within one segment), `?` (single char).
 * Every other character is escaped so pattern text (including shell
 * metacharacters like `||`, `&&`, quotes) matches literally.
 */
function matchGlob(target: string, pattern: string): boolean {
  const t = target.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');

  const parts: string[] = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // Non-greedy (see patterns.ts): identical overall result for
        // anchored path globs, but a trailing `**` no longer swallows
        // appended text.
        parts.push('.*?');
        i += 2;
        if (p[i] === '/') i++;
      } else {
        parts.push('[^/]*');
        i++;
      }
    } else if (ch === '?') {
      parts.push('[^/]');
      i++;
    } else {
      parts.push(escapeRegExp(ch));
      i++;
    }
  }

  return new RegExp(`^${parts.join('')}$`).test(t);
}

/** Escape one character for literal use inside a regular expression. */
function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}