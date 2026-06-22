/** Tool catalog types — InternalTool, backends, filters, compatibility.
 *
 *  Ported from llm-sdk/src/tools/types.ts. The `execute` signature still
 *  takes a free-form context bag; the runner populates `client`, `modelId`,
 *  `counter`, `recordLLMResponse` at execution time. */

import type { JsonSchema } from '../../llm/types/tools';
import type { HookBus } from '../../bus/hook-bus';
import type { CompletionResponse } from '../../llm/types/response';
import type { TokenCounter } from '../../agent/types';

// ─── InternalTool ──────────────────────────────────────────────────────────

export interface InternalTool {
  id: string;
  namespace: string;
  name: string;
  version: string;

  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;

  execute: (input: unknown, ctx: InternalToolContext) => Promise<unknown>;

  modelPreference?: ModelPreference;

  /** Minimum average benchmark score (0-100) for a model to enter the tool's
   *  compat `recommended` chain. Defaults to 100. */
  recommendedThreshold?: number;

  signature?: string;
  signedBy?: string;

  tags?: string[];
}

export interface ModelPreference {
  preferredModel?: string;
  fallbackModels?: string[];
  maxTokens?: number;
  temperature?: number;
}

export interface InternalToolContext {
  hooks?: HookBus;
  /** LLMClient pinned to the chosen model — populated by the runner. */
  client?: unknown;
  /** "provider/model" string for the chosen model — populated by the runner. */
  modelId?: string;
  /** Tool ID under execution. */
  toolId?: string;
  /** Token counter — populated by the runner (defaults to HybridTokenCounter). */
  counter?: TokenCounter;
  /** Tool implementations (e.g. defineLLMTool) invoke this after each LLM call
   *  so the runner can capture usage/latency for cost tracking and benchmarks. */
  recordLLMResponse?: (response: CompletionResponse) => void;
  [key: string]: unknown;
}

// ─── Backends ──────────────────────────────────────────────────────────────

export interface ToolBackend {
  readonly name: string;
  list(): Promise<InternalTool[]>;
  get(id: string): Promise<InternalTool | null>;
}

// ─── Search / Filter ───────────────────────────────────────────────────────

export interface ToolFilter {
  namespace?: string;
  prefix?: string;
  tag?: string;
  model?: { provider: string; model: string; minScore?: number };
}

export interface SearchOptions {
  namespace?: string;
  limit?: number;
}

// ─── Catalog compat ────────────────────────────────────────────────────────

export interface ToolCompatScore {
  score: number;
  testedAt: number;
  version?: string;
}

/** Per-tool benchmark record used by InternalToolRunner to pick a recommended
 *  chain. The runner ships without a bench subsystem, so the shape is declared
 *  inline so consumers can pass a CompatFile from elsewhere (or omit it
 *  entirely). */
export interface ToolCompat {
  /** Models that scored at/above the threshold, ordered by est. cost (cheapest first). */
  recommended: string[];
}

export type CompatFile = Record<string, ToolCompat>;
