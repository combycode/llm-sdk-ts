/** Core built-in tool library. Five tools every LLM app eventually needs:
 *
 *    summarize  — universal compaction primitive (used by ContextGuard, RAG, output)
 *    classify   — routing / intent / moderation
 *    structure  — extract typed structured data from prose
 *    score      — self-evaluation, judge-LLM patterns, ranking
 *    clarify    — interactive flows (mate to ask events)
 *
 *  Application-specific or domain-heavy tools (fact-extract, format-question,
 *  format-response, prompt-improve, enhance, variation, title) ship separately
 *  under `extensions/builtin-tools/` and must be registered manually if needed. */

import type { LocalBackend } from '../backends/local';
import { summarizeTool } from './summarize';
import { classifyTool } from './classify';
import { scoreTool } from './score';
import { structureTool } from './structure';
import { clarifyTool } from './clarify';

export { summarizeTool, type SummarizeInput, type SummarizeOutput } from './summarize';
export { classifyTool, type ClassifyInput, type ClassifyOutput } from './classify';
export { scoreTool, type ScoreInput, type ScoreOutput } from './score';
export { structureTool, type StructureInput, type StructureOutput } from './structure';
export { clarifyTool, type ClarifyInput, type ClarifyOutput } from './clarify';

/** Core built-in tools shipped with the SDK. */
export const BUILTIN_TOOLS = [
  summarizeTool,
  classifyTool,
  scoreTool,
  structureTool,
  clarifyTool,
] as const;

/** Register all SDK-core built-in tools on a LocalBackend. */
export function registerBuiltinTools(backend: LocalBackend): void {
  for (const tool of BUILTIN_TOOLS) {
    backend.register(tool);
  }
}
