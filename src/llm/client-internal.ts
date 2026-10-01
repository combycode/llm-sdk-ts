/** LLMClient internals — request normalization, system extraction, context
 *  building, provider/adapter resolution, and structured-output parsing.
 *  Split out of client.ts to keep the class file focused on the public surface. */

import type { RequestContext } from '../types/request-context';
import type { LLMClient } from './client';
import type { LLMClientConfig } from './client-config';
import type { ContentPart, Message } from './types/messages';
import type { ExecuteOptions } from './types/options';
import type { ApiType, ProviderAdapter, ProviderName } from './types/provider';
import type { CompletionResponse } from './types/response';
import type { FunctionTool, FunctionToolInput, Tool, ToolInput } from './types/tools';
import type { SchemaSource } from './types/standard-schema';
import { isStandardSchema, toJsonSchema, validateStandardSchema } from './types/standard-schema';
import { validateJsonSchema } from '../util/json-schema';
import { InvalidFinalOutputError } from './output-errors';

export const PRIORITY_INTERACTIVE = 1;
export const PRIORITY_BACKGROUND = 2;

/** Build a history assistant message from a response, stamped with provenance
 *  (id, createdAt, origin). On a stateful API (responses / interactions) the origin
 *  carries the server-state id so a later turn can continue server-side instead of
 *  resending the transcript. Shared by `LLMClient.assistantMessage` (manual multi-turn)
 *  and the agent loop (so its tool turns also chain server-side). */
export function buildAssistantMessage(
  response: CompletionResponse,
  origin: { provider: ProviderName; model: string; api: ApiType },
): Message {
  const stateful = origin.api === 'responses' || origin.api === 'interactions';
  return {
    role: 'assistant',
    content: response.content,
    id: response.id || crypto.randomUUID(),
    createdAt: Date.now(),
    origin: {
      provider: origin.provider,
      model: origin.model,
      ...(stateful && response.id ? { serverStateId: response.id } : {}),
      // Opaque and provider-bound: copied, never read. The adapter that
      // produced it is the only one allowed to send it back.
      ...(response.signatures ? { signatures: response.signatures } : {}),
    },
  };
}

export function normalizeInput(input: string | ContentPart[] | Message[]): Message[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input) && input.length > 0 && 'role' in input[0]) {
    return input as Message[];
  }
  return [{ role: 'user', content: input as ContentPart[] }];
}

/** Lift any role:'system' messages out of the input array.
 *  Anthropic and some other providers expect `system` as a top-level
 *  parameter, not as a message role. By extracting here in the client we
 *  give callers a single, provider-neutral way to set per-call system text:
 *  either pass `options.system`, or include role:'system' messages in the
 *  input (they get concatenated). Adapters never see role:'system'. */
export function extractSystem(messages: Message[]): { system?: string; messages: Message[] } {
  const systemTexts: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      if (text) systemTexts.push(text);
    } else {
      rest.push(m);
    }
  }
  return {
    system: systemTexts.length ? systemTexts.join('\n\n') : undefined,
    messages: rest,
  };
}

function contentToText(content: ContentPart[]): string {
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Strip leading/trailing markdown fences and JSON.parse. Exported so AgentLoop
 *  + helper can share the same parsing rules.
 *
 *  `schema` is optional and only does anything for a **Standard Schema**. A plain
 *  JSON Schema has already done its work on the provider's side, where the model
 *  was constrained by it; re-checking it here with a zero-dep validator would
 *  mostly find places where we and the provider disagree.
 *
 *  A Standard Schema is a different thing. It carries semantics no JSON Schema
 *  can express — refinements, branded types, cross-field rules — which the
 *  provider therefore never enforced, and `validate` may TRANSFORM what it is
 *  given. So its output, not the parsed object, is what the caller receives:
 *  returning the parsed one would hand back a value that looks right and skipped
 *  the schema's own work. */
export function parseStructured<T>(
  text: string,
  schema?: SchemaSource,
  options?: { validate?: boolean },
): T {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (cause) {
    // Typed, differentiated failure — callers can `instanceof InvalidFinalOutputError`
    // and inspect `.rawText`, instead of catching a bare SyntaxError.
    throw new InvalidFinalOutputError(text, { cause });
  }
  if (schema !== undefined && !isStandardSchema(schema) && options?.validate) {
    // A plain JSON Schema, checked on request. The provider already enforced it,
    // so this is for the cases where that enforcement is weaker than the schema:
    // a surface with no strict mode, a model ignoring the schema under load, a
    // `required` the provider treats as advisory.
    //
    // Opt-in because the bundled validator reads a subset of Draft 2020-12 --
    // always-on it would reject responses that are valid under a schema it cannot
    // fully read, and disagree with the provider that had just enforced it.
    const errors = validateJsonSchema(schema, parsed);
    if (errors.length > 0) {
      // The same error as a parse failure, so one `repairAttempts` budget covers
      // both: a value that parsed and was wrong is the case re-prompting helps
      // with, and the message the model is re-prompted with has to say WHAT was
      // wrong, which is why every error is listed rather than just the first.
      throw new InvalidFinalOutputError(text, { cause: new Error(errors.join('; ')) });
    }
  }
  if (schema !== undefined && isStandardSchema(schema)) {
    try {
      return validateStandardSchema(schema, parsed) as T;
    } catch (cause) {
      // The SAME error as a parse failure, deliberately. Both mean "the final
      // output did not match the requested schema", and that is what
      // `structuredComplete`'s repair loop re-prompts on. A separate type here
      // would have left the repair budget covering malformed JSON but not a
      // value that parsed and was wrong — which is the case a repair helps with.
      throw new InvalidFinalOutputError(text, { cause });
    }
  }
  return parsed as T;
}

/** Tools as the wire needs them: a Standard Schema in a function tool's
 *  `parameters` or `outputSchema`, converted to JSON Schema once, here.
 *
 *  Converting at the request boundary instead of widening the internal types is
 *  the design. Everything downstream — the wire specs, the strict-mode checks,
 *  the snapshots, every provider adapter — keeps reading a plain JSON Schema and
 *  never learns this protocol exists. The array is rebuilt only when something
 *  in it needs it, so the ordinary case allocates nothing. */
export function toWireTools(tools: ToolInput[] | undefined): Tool[] | undefined {
  // Nothing to convert: the declarations ARE normalized tools, and saying so
  // costs a cast that `hasStandardSchema` has just ruled out for every entry.
  if (!tools?.some(hasStandardSchema)) return tools as Tool[] | undefined;
  return tools.map((tool) => {
    if (!hasStandardSchema(tool)) return tool as Tool;
    const next: FunctionTool = {
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // The OUTPUT side: a transforming schema describes two different
      // documents, and a tool's return value is the one it produces.
      ...(tool.outputSchema !== undefined
        ? { outputSchema: toJsonSchema(tool.outputSchema, 'output') }
        : { outputSchema: undefined }),
    };
    if (next.outputSchema === undefined) delete next.outputSchema;
    return next;
  });
}

function hasStandardSchema(tool: ToolInput): tool is FunctionToolInput {
  if (!('parameters' in tool)) return false;
  const fn = tool as FunctionToolInput;
  return isStandardSchema(fn.parameters) || isStandardSchema(fn.outputSchema);
}

/** A `structured` option with its schema converted for the wire. The return type
 *  is the narrow one: past this point no Standard Schema remains. */
export function toWireStructured<T extends { schema: SchemaSource }>(
  structured: T | undefined,
): (Omit<T, 'schema'> & { schema: Record<string, unknown> }) | undefined {
  type Wire = Omit<T, 'schema'> & { schema: Record<string, unknown> };
  if (!structured) return undefined;
  if (!isStandardSchema(structured.schema)) return structured as Wire;
  return { ...structured, schema: toJsonSchema(structured.schema) } as Wire;
}

/** The routing names `buildContext` needs from a client.
 *
 *  These were read with `as unknown as { queueName: string }` casts straight into
 *  LLMClient's privates — which compiles, and silently returns `undefined` the
 *  day a field is renamed. LLMClient now exposes them deliberately as
 *  `client.routing`, so a rename is a type error instead. */
export interface ClientRouting {
  readonly queueName: string;
  readonly configName: string;
  readonly cacheName: string;
}

export function buildContext(client: LLMClient, options: ExecuteOptions): RequestContext {
  const provided = options.ctx ?? {};
  const ctx: RequestContext = {
    ...provided,
    sessionId: provided.sessionId ?? client.sessionId,
    clientId: provided.clientId ?? client.id,
    queueName: provided.queueName ?? client.routing.queueName,
    configName: options.configName ?? provided.configName ?? client.routing.configName,
    cacheName: options.cacheName ?? provided.cacheName ?? client.routing.cacheName,
    cacheKey: options.cacheKey ?? provided.cacheKey,
  };
  if (!ctx.callId) ctx.callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  // Mint-if-absent: server/agent set requestId upstream; a direct LLM call mints
  // it here so every request carries one (the request half of the trace id).
  if (!ctx.requestId) ctx.requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
  return ctx;
}

export function resolveApi(
  provider: ProviderName,
  api?: ApiType | 'auto',
  /** The catalog's per-model preference, when the model is a known one. */
  preferred?: ApiType | null,
): ApiType {
  if (api && api !== 'auto') return api;
  // A model's own preference beats the provider default. The catalog has carried
  // `preferredApi` per model from the start and nothing consulted it here, so
  // every OpenAI model routed to Responses — including the six that cannot use
  // it. `gpt-audio` came back "not supported with the Responses API"; the three
  // *-search models are Chat Completions-only for the same reason.
  if (preferred) return preferred;
  const defaults: Record<ProviderName, ApiType> = {
    anthropic: 'messages',
    openai: 'responses',
    // generateContent is Google's stable, production-recommended API. The
    // Interactions API (api:'interactions') is Beta with frequent breaking
    // schema changes (e.g. May 2026 turn_list->step_list) — opt in explicitly
    // when you need its server-side state / agentic steps.
    google: 'generate',
    xai: 'responses',
    openrouter: 'completions',
  };
  return defaults[provider] ?? 'completions';
}

export function resolveAdapter(config: LLMClientConfig, api: ApiType): ProviderAdapter {
  const a = config.adapter;
  if (!a) {
    throw new Error('LLMClient: adapter or AdapterFactory must be supplied');
  }
  if (typeof a === 'function') {
    return a(config.provider, config.apiKey, api, config.baseURL);
  }
  return a;
}
