import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Runtime on/off switch persistence for dsh-auto-approval.
 *
 * The plugin's enable state is toggled at runtime with `/autoapprove on|off`
 * and persisted to a small JSON file so a DSH restart does not silently
 * re-enable auto-approval after the user turned it off.
 *
 * @module dsh-auto-approval/state
 */

/** The on-disk switch state. */
export interface ApprovalState {
  /** Whether auto-approval is active. `false` routes every request to the human. */
  enabled: boolean;
}

/** Config fields the state file path can be derived from. */
export interface StateFileConfig {
  /** Explicit state file path; empty derives one from the pattern file. */
  stateFile?: string;
  /** Learned-pattern file path; its directory hosts the derived state file. */
  patternFile?: string;
}

/** The default on/off state for a fresh install: auto-approval on. */
export const DEFAULT_STATE: ApprovalState = { enabled: true };

/**
 * Resolve the state file path: explicit `stateFile` wins, otherwise derive it
 * next to the pattern file, otherwise fall back to the DSH home directory.
 */
export function resolveStateFile(config: StateFileConfig): string {
  if (config.stateFile) return config.stateFile;
  if (config.patternFile) return join(dirname(config.patternFile), 'auto-approval-state.json');
  return join(homedir(), '.dsh', 'auto-approval-state.json');
}

/**
 * Load the on/off state. Missing or corrupt files (first run, partial write)
 * fall back to {@link DEFAULT_STATE}.
 */
export function loadState(file: string): ApprovalState {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as ApprovalState;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.enabled === 'boolean'
      ? { enabled: parsed.enabled }
      : { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Persist the on/off state, creating parent directories as needed.
 * Failures are logged and swallowed — the toggle must never crash the plugin.
 */
export function saveState(file: string, state: ApprovalState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error(`[auto-approval] failed to save state: ${String(error)}`);
  }
}

/** True when the state file already exists on disk. */
export function stateFileExists(file: string): boolean {
  return existsSync(file);
}
