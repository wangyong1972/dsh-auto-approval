/**
 * Deterministic danger-command vocabulary for dsh-auto-approval.
 *
 * A compiled list of regular expressions matched against the tool arguments
 * (the raw command text) BEFORE any LLM judgment. A match defers the request
 * to the human — the classifier can never override a danger hit.
 *
 * @module dsh-auto-approval/danger-patterns
 */

/** The built-in danger patterns. Each entry is a case-insensitive regex source. */
export const DEFAULT_DANGER_PATTERNS: readonly string[] = Object.freeze([
  // Destructive recursive delete of a root-ish path: rm -rf /, rm -rf ~, etc.
  String.raw`\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(?:--\s+)?["']?(?:/|~)(?:[^\s"';&|]*)["']?`,
  // Device / block write: dd if=... of=/dev/...
  String.raw`\bdd\b[^\n;&|]*\bof\s*=\s*["']?/dev/`,
  // Filesystem formatting: mkfs, mkfs.ext4, ...
  String.raw`\bmkfs(?:\.[a-z0-9_-]+)?\b`,
  // Force-push variants: git push --force, -f, --mirror, +refspec
  String.raw`\bgit(?:\s+(?!push\b)[^\s;&|]+)*\s+push\b[^\n;&|]*(?:--force\b|-f\b|--mirror\b|(?:^|[\s"'])\+[^\s"';&|]+)`,
  // Download-to-shell pipeline: curl ... | sh, wget ... | bash
  String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*(?:/usr/bin/env\s+)?(?:ba|z|da|k)?sh\b`,
  // Destructive SQL
  String.raw`\bdrop\s+(?:database|table)\b`,
  String.raw`\btruncate\b`,
  // Host lifecycle
  String.raw`(?:^|[\s;&|])(?:shutdown|reboot|halt)\b`,
  // Root-wide chmod
  String.raw`\bchmod\s+-R\s+777\s+["']?/`,
  // Shell fork bomb
  String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
  // Infrastructure destruction
  String.raw`\bterraform\s+destroy\b`,
  String.raw`\bpulumi\s+destroy\b`,
  // Obfuscated destructive commands via command substitution / process substitution
  String.raw`(?=[^\n]*\b(?:rm|dd|mkfs(?:\\.[a-z0-9_-]+)?|chmod|chown)\b)(?=[^\n]*(?:\$\(|` + '`' + `|<\(\)))`,
]);

/** One compiled danger rule: the source text and its case-insensitive regex. */
export interface DangerRule {
  /** The original pattern source, for logging and user-facing messages. */
  source: string;
  /** Compiled case-insensitive regex. */
  regexp: RegExp;
}

/**
 * Compile danger patterns once at plugin load. Invalid regex sources throw so
 * the misconfiguration fails loud instead of silently disabling protection.
 * @param configured - user-configured list (overrides built-ins), or null to use built-ins.
 * @param extra - additional patterns appended to the effective list.
 */
export function compileDangerPatterns(
  configured: readonly string[] | null | undefined,
  extra: readonly string[] = [],
): readonly DangerRule[] {
  const primary = configured ?? DEFAULT_DANGER_PATTERNS;
  return [...primary, ...extra].map((source) => {
    try {
      return Object.freeze({ source, regexp: new RegExp(source, 'i') });
    } catch (error) {
      throw new Error(
        `dsh-auto-approval: invalid danger pattern ${JSON.stringify(source)}: ${String(error)}`,
      );
    }
  });
}

/**
 * Return the first danger rule matching the text, or undefined.
 * @param text - the raw tool arguments / command text to inspect.
 */
export function findDangerMatch(
  text: string,
  patterns: readonly DangerRule[],
): DangerRule | undefined {
  return patterns.find(({ regexp }) => regexp.test(text));
}
