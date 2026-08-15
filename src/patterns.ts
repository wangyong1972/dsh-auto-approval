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
 */
export function matchPatterns(
  patterns: PatternFile,
  toolName: string,
  target: string,
): LearnedPattern | undefined {
  const list = patterns[toolName] ?? [];
  for (const learned of list) {
    if (matchGlob(target, learned.pattern)) return learned;
  }
  return undefined;
}

/**
 * Learn a new allowance for a target: either bump an existing pattern or
 * append one. Returns the updated pattern file (caller persists it).
 */
export function learnPattern(
  patterns: PatternFile,
  toolName: string,
  target: string,
): PatternFile {
  const list = patterns[toolName] ?? [];
  // Exact-match bump first.
  const existing = list.find((learned) => learned.pattern === target);
  if (existing) {
    existing.count += 1;
    existing.lastApprovedAt = new Date().toISOString();
  } else {
    list.push({
      pattern: target,
      count: 1,
      lastApprovedAt: new Date().toISOString(),
    });
  }
  // Cap the list so a long session cannot grow it unbounded.
  patterns[toolName] = list.slice(-50);
  return patterns;
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
        parts.push('.*');
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
