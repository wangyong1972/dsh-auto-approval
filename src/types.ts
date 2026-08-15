/**
 * Types for dsh-auto-approval.
 *
 * @module dsh-auto-approval
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

/**
 * Plugin configuration.
 */
export interface Config {
  /**
   * Base URL for the LM Studio OpenAI-compatible API.
   * @default 'http://127.0.0.1:1234/v1'
   */
  baseUrl?: string;

  /**
   * Model name as shown in LM Studio.
   * @default 'gemma-4-e4b-it-mlx'
   */
  modelName?: string;

  /**
   * Globs for targets that are always allowed (bypass LLM).
   * The current workspace root is automatically included.
   */
  allowedPatterns?: string[];

  /**
   * Globs for targets that are always denied (bypass LLM).
   */
  deniedPatterns?: string[];

  /**
   * Confidence threshold (0.0–1.0). The LLM must report `safe: true` AND
   * `confidence >= threshold` for auto-approval.
   * @default 0.7
   */
  confidenceThreshold?: number;

  /**
   * Path to the learned-patterns JSON file. When set, operations the human
   * approves after the plugin deferred (deny-list hit or uncertain) are
   * remembered and auto-approved in the future. Omit or leave empty to
   * disable learning.
   */
  patternFile?: string;
}

/**
 * The structured response we ask the local LLM to produce.
 */
export interface JudgeVerdict {
  /** Whether the operation is considered safe. */
  safe: boolean;
  /** Confidence in the judgement, 0.0–1.0. */
  confidence: number;
}

/**
 * The three outcomes from the quick-path check.
 */
export type QuickResult = 'allow' | 'deny' | 'unsure';

/**
 * The tool-call event variant we search for in the session log to recover
 * the full arguments of the call being approved.
 */
export type ToolCallEvent = Extract<SessionEvent, { type: 'tool/call' }>;

/** Default config values. */
export const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  modelName: 'gemma-4-e4b-it-mlx',
  confidenceThreshold: 0.7,
} as const;
