/** Lazy tool loading: `tool_search` + `call_tool`.
 *
 *  A tool registered with `lazy: true` is NOT placed in the `tools` array. The model
 *  finds it by searching, and calls it through `call_tool`. The point is what does NOT
 *  move: the declared tool array never changes, so no discovery event can invalidate the
 *  cached prefix. Schemas travel as tool RESULTS, which land in history after the prefix.
 *
 *  Measured against declaring everything (308 tools, 6 tasks, 3 reps, both providers —
 *  `bench/lazy-tools-e2e`): identical correctness (72/72), −72% cost on claude-haiku-4.5
 *  and −97% on gpt-5.4-nano, at one extra round trip per task.
 *
 *  Three details here are load-bearing and each came from a measurement that failed
 *  first. They are not stylistic:
 *
 *  1. `call_tool` is SINGULAR. A batching form — `call_tools({ calls: [...] })` — is
 *     returned as a JSON *string* rather than an array by claude-haiku about half the
 *     time (19/30 vs 30/30), because a router's `input` must be open and an open object
 *     cannot be strict, so no grammar holds the shape. Batching is not lost: the model
 *     emits several parallel `call_tool` calls in one turn instead.
 *
 *  2. `tool_search` REPORTS QUERIES THAT MATCHED NOTHING. Merging results silently makes
 *     a failed lookup indistinguishable from one whose hits were folded in with the
 *     others, and the model then answers confidently from the tools it did get. Measured
 *     on colloquial phrasing: without this, 34/36 recall and 17/18 correct; with it,
 *     36/36 and 18/18.
 *
 *  3. Ranking is deliberately weak, and that is survivable only because the MODEL writes
 *     the query. Token overlap against raw user text scores 0–1 of 8 on indirect or
 *     colloquial phrasing (`bench/tool-ranking`). The model's rewriting is what carries
 *     it. Better ranking would reduce how far that rewriting has to reach; it is not what
 *     makes the feature work.
 */

import type { FunctionTool, Tool } from '../llm/types/tools';
import type { AgentTool, ToolExecutionContext } from './types';

/** Tuning for lazy tool exposure. Every field is optional; the defaults are what the
 *  measurements used. */
export interface LazyToolsConfig {
  /** Schemas returned per query. Default 5, capped at 20 — the cap is a real bound, not
   *  a formality: returning everything re-creates the cost the feature exists to avoid. */
  limit?: number;
  /** Searches allowed per run. Default 5. Exceeding it returns a tool result saying so
   *  and leaves the run alive: a model that loops on search should be told, not killed. */
  maxSearches?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_MAX_SEARCHES = 5;

/** The two names this module owns. Registered like any other tool, so the existing
 *  collision policy applies to them and there is no second registry. */
export const LAZY_SEARCH_TOOL = 'tool_search';
export const LAZY_CALL_TOOL = 'call_tool';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'it', 'that', 'this',
  'with', 'return', 'returns', 'my', 'me', 'do', 'we', 'i', 'how', 'many', 'much', 'what',
  'when', 'has', 'have', 'need', 'any', 'get', 'can', 'you', 'are', 'was', 'been', 'does',
  'did', 'should', 'from', 'by', 'at', 'as', 'be',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

const isFn = (t: Tool): t is FunctionTool => 'name' in t;
const nameOf = (t: AgentTool): string => (isFn(t.definition) ? t.definition.name : '');

/** Rank candidates by token overlap over name + description + parameter names, with name
 *  matches weighted double — a query naming the domain should beat a filler whose long
 *  description happens to share vocabulary. Local and dependency-free by design: no
 *  embeddings, no network call on the discovery path. */
export function rankTools(query: string, candidates: AgentTool[], limit: number): AgentTool[] {
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];

  const scored: Array<{ tool: AgentTool; score: number }> = [];
  for (const tool of candidates) {
    const def = tool.definition;
    if (!isFn(def)) continue;
    const props = Object.keys(
      (def.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    );
    let score = 0;
    for (const w of tokenize(`${def.name} ${def.description ?? ''} ${props.join(' ')}`)) {
      if (q.has(w)) score++;
    }
    for (const w of tokenize(def.name)) if (q.has(w)) score += 2;
    if (score > 0) scored.push({ tool, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.tool);
}

/** Per-run search budget. Reset at the start of each run, not shared across runs.
 *
 *  Internal: deliberately NOT exported from the package. It is wiring between this module
 *  and `AgentLoop`, and a consumer has no use for it — publishing it would put two types
 *  in the public API that can never be called usefully from outside. */
interface LazySearchState {
  searches: number;
}

/** Build the two built-in tools. Returned as ordinary `AgentTool`s so they register,
 *  dispatch, time out and report through exactly the same path as any other tool.
 *
 *  The dependency shape is inline rather than a named interface on purpose: a named type
 *  in an exported signature lands in the published `.d.ts`, and this one is wiring
 *  between here and `AgentLoop` that a consumer can never usefully call.
 *
 *  `lazyTools` and `eagerNames` are functions, not arrays, because tools can be added
 *  after construction and search must see them. */
export function createLazyTools(deps: {
  lazyTools: () => AgentTool[];
  eagerNames: () => string[];
  state: LazySearchState;
  config: LazyToolsConfig;
  onSearch?: (info: { queries: string[]; matched: string[]; unmatched: string[] }) => void;
}): AgentTool[] {
  const limit = Math.min(deps.config.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const maxSearches = deps.config.maxSearches ?? DEFAULT_MAX_SEARCHES;

  const search: AgentTool = {
    definition: {
      type: 'function',
      name: LAZY_SEARCH_TOOL,
      description:
        'Find the tools you need. Returns their exact names and full argument schemas. ' +
        'Pass every capability you need as a separate query in one call.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'One phrase per capability you need, in your own words.',
          },
        },
        required: ['queries'],
      },
    },
    execute: async (args) => {
      deps.state.searches++;
      if (deps.state.searches > maxSearches) {
        return JSON.stringify({
          error: `Search budget exhausted (${maxSearches} searches per run). Use the tools you already found.`,
        });
      }

      const raw = args.queries;
      const queries = (Array.isArray(raw) ? raw : [raw])
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
      if (queries.length === 0) {
        return JSON.stringify({ tools: [], error: 'Pass at least one query string in `queries`.' });
      }

      const candidates = deps.lazyTools();
      const hits = new Map<string, AgentTool>();
      const unmatched: string[] = [];
      for (const q of queries) {
        const found = rankTools(q, candidates, limit);
        if (found.length === 0) unmatched.push(q);
        for (const t of found) hits.set(nameOf(t), t);
      }

      deps.onSearch?.({ queries, matched: [...hits.keys()], unmatched });

      // A query that found nothing has to say so. Silence here is what turns a
      // multi-capability task into a confident partial answer.
      return JSON.stringify({
        tools: [...hits.values()].map((t) => t.definition),
        ...(unmatched.length > 0
          ? {
              unmatched,
              hint: 'These queries matched no tool. Search again for them using different words, or tell the user the capability is unavailable.',
            }
          : {}),
      });
    },
  };

  const call: AgentTool = {
    definition: {
      type: 'function',
      name: LAZY_CALL_TOOL,
      description:
        'Call one tool returned by tool_search. Pass its exact name and its own arguments as `input`. ' +
        'To use several tools, call this several times in the same turn.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name from tool_search.' },
          input: {
            type: 'object',
            description: "That tool's own arguments, as an object.",
            additionalProperties: true,
          },
        },
        required: ['name', 'input'],
      },
    },
    execute: async (args, ctx: ToolExecutionContext) => {
      const name = String(args.name ?? '');
      const target = deps.lazyTools().find((t) => nameOf(t) === name);

      if (!target) {
        // Eager tools are declared and callable directly; routing one through here is a
        // mistake worth naming precisely, rather than reporting as "no such tool".
        if (deps.eagerNames().includes(name)) {
          return `"${name}" is already available as a normal tool — call it directly, not through ${LAZY_CALL_TOOL}.`;
        }
        return `No tool named "${name}". Call ${LAZY_SEARCH_TOOL} first and use a name exactly as returned.`;
      }

      const input = args.input;
      if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
        return `\`input\` must be an object of ${name}'s arguments, not ${Array.isArray(input) ? 'an array' : typeof input}.`;
      }

      return target.execute((input ?? {}) as Record<string, unknown>, ctx);
    },
  };

  return [search, call];
}

/** The inner tool a `call_tool` invocation targeted, for reporting. Returns null for any
 *  other call. Traces that attribute every tool call to `call_tool` are useless, and this
 *  is the one real regression the design causes — so it is fixed at the source. */
export function unwrapLazyCall(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName !== LAZY_CALL_TOOL) return null;
  const inner = args.name;
  return typeof inner === 'string' && inner.length > 0 ? inner : null;
}
