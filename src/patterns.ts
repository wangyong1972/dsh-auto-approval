import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Learned-allowance persistence for dsh-auto-approval.
 *
 * When a human approves an operation the plugin flagged (deny-list hit or
 * uncertain), the plugin learns the operation's target as a glob pattern.
 * Future requests matching a learned pattern are auto-approved without
 * prompting.
 *
 * @module dsh-auto-approval/patterns
 */

/** One learned allowance: a glob pattern over file paths or command text. */
export interface LearnedPattern {
  /** The glob pattern matched against the extracted target. */
  pattern: string;
  /** How many times this pattern was approved. */
  count: number;
  /** ISO timestamp of the last approval. */
  lastApprovedAt: string;
}

/** The on-disk pattern file: a map of learned glob patterns. */
export interface PatternFile {
  /** Tool name → learned patterns for that tool. */
  [toolName: string]: LearnedPattern[];
}

/**
 * Load the pattern file. Returns an empty object when the file does not
 * exist or is unreadable — a missing file is the normal first-run state.
 */
export function loadPatterns(file: string): PatternFile {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as PatternFile;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist the pattern file, creating parent directories as needed.
 * Failures are logged and swallowed — learning must never break approval.
 */
export function savePatterns(file: string, data: PatternFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error(`[auto-approval] failed to save patterns: ${String(error)}`);
  }
}

/**
 * Check whether a target matches any learned pattern for the tool.
 * @returns the matching pattern, or undefined.
 *
 * bash matching is two-staged:
 * - **Fuzzy stage (all entries)**: skeleton equality — both sides are
 *   normalized (quoted content becomes `**`) and must be *string-equal*.
 *   Only quoted wording may differ (e.g. `echo "写入成功"` vs
 *   `echo "写入完成"`); structural differences (extra commands, different
 *   paths, different quote counts) never match. This covers both skeleton
 *   entries and legacy verbatim entries.
 * - **Legacy glob stage (entries without `**` only)**: literal glob match
 *   of the raw target, so real `*`/`?` wildcards learned from commands
 *   still work. Skeleton entries (`**` placeholder) deliberately skip glob
 *   matching: an anchored glob would let a trailing `**` swallow appended
 *   command segments (`... || echo "x" && ls`), which fuzzy equality
 *   correctly rejects.
 */
export function matchPatterns(
  patterns: PatternFile,
  toolName: string,
  target: string,
): LearnedPattern | undefined {
  const list = patterns[toolName] ?? [];
  if (toolName === 'bash') {
    const skeleton = normalizeCommand(target);
    for (const learned of list) {
      if (normalizeCommand(learned.pattern) === skeleton) return learned;
      if (!learned.pattern.includes('**') && matchGlob(target, learned.pattern)) return learned;
    }
    return undefined;
  }
  for (const learned of list) {
    if (matchGlob(target, learned.pattern)) return learned;
  }
  return undefined;
}

/**
 * Learn a new allowance for a target: either bump an existing pattern or
 * append one. Returns the updated pattern file (caller persists it).
 *
 * bash commands are stored as a normalized **skeleton**: the content of
 * every quoted token (`"..."` / `'...'`) is replaced with `**`, so future
 * requests that differ only in quoted wording match the same learned
 * pattern. Other tools (file paths) are stored verbatim — fuzzy path
 * matching is deliberately not applied.
 */
export function learnPattern(
  patterns: PatternFile,
  toolName: string,
  target: string,
): PatternFile {
  const pattern = toolName === 'bash' ? normalizeCommand(target) : target;
  const list = patterns[toolName] ?? [];
  // Bump an existing entry whose normalized form equals the new pattern
  // (bash: also matches entries learned verbatim before fuzzy learning).
  const existing = list.find((learned) =>
    toolName === 'bash'
      ? normalizeCommand(learned.pattern) === pattern
      : learned.pattern === pattern,
  );
  if (existing) {
    existing.count += 1;
    existing.lastApprovedAt = new Date().toISOString();
  } else {
    list.push({
      pattern,
      count: 1,
      lastApprovedAt: new Date().toISOString(),
    });
  }
  // Cap the list so a long session cannot grow it unbounded.
  patterns[toolName] = list.slice(-50);
  return patterns;
}

/**
 * Normalize a bash command into a skeleton for fuzzy matching: the content
 * of every quoted token (`"..."` / `'...'`) is replaced with `**` (a
 * cross-segment glob wildcard). Unquoted text, command substitutions
 * (`$()`), and backticks are left verbatim — those are never generalized
 * because they can carry executable content.
 *
 * Examples:
 *   `echo "写入成功" > /a/b.txt`  →  `echo ** > /a/b.txt`
 *   `cd '/a b/c' && pnpm build`   →  `cd ** && pnpm build`
 */
export function normalizeCommand(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '**');
}

/**
 * Minimal glob matcher (same semantics as quick-check): `**` crosses
 * directories, `*` matches within one segment, `?` matches one character.
 * Every other character is escaped so pattern text (including shell
 * metacharacters like `||`, `&&`, quotes) matches literally.
 */
export function matchGlob(target: string, pattern: string): boolean {
  const t = target.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');

  const parts: string[] = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // Non-greedy: `**` matches as little as possible. With the
        // `^...$` anchor the overall match result is unchanged for path
        // globs, but a trailing `**` no longer swallows appended command
        // segments (e.g. a learned `... || echo **` must not match
        // `... || echo "x" && ls`).
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
      // Escape any regex metacharacter; all other text matches literally.
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
