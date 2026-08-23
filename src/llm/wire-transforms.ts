/** The named-code registry the wire specs delegate to.
 *
 *  Everything here is bound to the REAL library internals, never reimplemented —
 *  if the interpreter's output matches the adapter's, it is because the spec
 *  drove the same code, not because I wrote a second copy that happens to agree.
 *
 *  What lands in this file is the honest answer to "what cannot be data":
 *  structural message/content transformation, schema-shape rules, and one
 *  variant rule that is arithmetic rather than a pattern.
 */
import type { Ctx, Registry } from '../wire/interpreter';
import { ensureAdditionalProperties, strictSupport } from './types/schema-utils';
import { resolveVoice } from './audio/voices';
import { buildNativeModeration } from './moderation/native';
import { anthropicThinkingShape } from './providers/anthropic/constants';
import { googleRequestTier } from './providers/google/tiers';
import { openaiRequestTier } from './providers/openai/tiers';
import { xaiRequestTier } from './providers/xai/tiers';
import { bytesToBase64 } from '../util/base64';
import { fnv1a32Hex } from '../util/hash';
import {
  googleImagePart,
  googleVeoImage,
  normalizeImageSource,
  openaiImageRef,
  toDataUrl,
  xaiImageRef,
  xaiVideoRef,
} from '../util/source-image';

const isFunctionToolValue = (t: any): boolean => !t?.type || t.type === 'function';

/** Adapters whose private message builders we reuse. Instantiated once; the
 *  builders are pure with respect to the request. */
/** The hand-written adapter methods the specs cannot express as data.
 *
 *  All optional: a registry built by ONE adapter to drive its own spec carries only
 *  its own handle, and each transform below is reached only from that provider's
 *  spec. Requiring the full set would force every adapter to import every other
 *  adapter just to build its own request. */
export interface AdapterHandles {
  anthropic?: any;
  google?: any;
  openaiResponses?: any;
  openaiCompletions?: any;
  googleInteractions?: any;
  openrouterMedia?: any;
}

export function makeRegistry(a: AdapterHandles): Registry {
  const transforms: Registry['transforms'] = {
    // ── schema shape rules ────────────────────────────────────────────────
    ensureAdditionalProperties: (v) => ensureAdditionalProperties(v as any),

    /** Anthropic: `input_schema` is hardened only on the strict path. */
    anthropicToolSchema: (tool: any) =>
      tool.strict === true ? ensureAdditionalProperties(tool.parameters) : tool.parameters,

    /** OpenAI chat-completions: same rule, different field. */
    openaiToolParams: (tool: any) =>
      tool.strict === true ? ensureAdditionalProperties(tool.parameters) : tool.parameters,

    /** OpenAI structured output: strict defaults to whatever the schema supports. */
    openaiStructuredStrict: (_v, ctx: Ctx) => {
      const s = ctx.req.structured;
      const schema = ensureAdditionalProperties(s.schema);
      return s.strict ?? strictSupport(schema, 'openai').ok;
    },
    openaiStructuredSchema: (_v, ctx: Ctx) => {
      const s = ctx.req.structured;
      const schema = ensureAdditionalProperties(s.schema);
      const strict = s.strict ?? strictSupport(schema, 'openai').ok;
      return strict ? schema : s.schema;
    },
    /** Responses always sends the hardened schema (differs from completions). */
    openaiResponsesStructuredSchema: (_v, ctx: Ctx) =>
      ensureAdditionalProperties(ctx.req.structured.schema),

    /** Responses tools: strict defaults from schema support, per tool. */
    openaiResponsesToolStrict: (tool: any) =>
      tool.strict ?? strictSupport(ensureAdditionalProperties(tool.parameters), 'openai').ok,

    // ── provider value maps that are already functions in the library ─────
    googleTier: (v) => googleRequestTier(v as any),
    openaiTier: (v) => openaiRequestTier(v as any),

    // ── audio ─────────────────────────────────────────────────────────────
    resolveVoiceOpenAI: (_v, ctx: Ctx) => resolveVoice('openai', ctx.req.audio?.voice) ?? 'alloy',
    resolveVoiceGoogle: (_v, ctx: Ctx) => resolveVoice('google', ctx.req.audio?.voice),
    openaiAudioFormat: (_v, ctx: Ctx) => {
      const f = ctx.req.audio?.format;
      return !f || f === 'aac' ? 'wav' : f;
    },

    // ── moderation ────────────────────────────────────────────────────────
    nativeModeration: (_v, ctx: Ctx) =>
      buildNativeModeration(ctx.req.moderation, ctx.req.providerOptions?.moderationPolicy as any),

    // ── model path ────────────────────────────────────────────────────────
    googleModelPath: (_v, ctx: Ctx) =>
      ctx.req.model.startsWith('models/') ? ctx.req.model : `models/${ctx.req.model}`,
    googleGeneratePath: (_v, ctx: Ctx) => {
      const m = ctx.req.model.startsWith('models/') ? ctx.req.model : `models/${ctx.req.model}`;
      return `/v1beta/${m}:generateContent`;
    },

    /** providerOptions.cachedContent is forwarded only when it is a non-empty string. */
    stringOnly: (v) => (typeof v === 'string' && v ? v : undefined),

    // ── media: structural parts, reusing the library's own normalisers ────
    /** Veo first-frame image. */
    googleVeoImagePart: (_v, ctx: Ctx) => googleVeoImage(normalizeImageSource(ctx.req.sourceImage)),
    /** Source image for an image-to-image edit. */
    googleSourceImagePart: (_v, ctx: Ctx) => googleImagePart(normalizeImageSource(ctx.req.sourceImage)),
    /** OpenAI image reference (data URL or file_id) for the source image. */
    openaiSourceImageRef: (_v, ctx: Ctx) => openaiImageRef(normalizeImageSource(ctx.req.sourceImage)),
    /** Same, for an edit mask. */
    openaiMaskRef: (_v, ctx: Ctx) => openaiImageRef(normalizeImageSource(ctx.req.mask)),
    /** OpenAI TTS voice. Reads `params.voice`, NOT the chat request's
     *  `audio.voice` — reusing the chat transform here silently produced the
     *  default, which the differential caught. */
    openaiTtsVoice: (_v, ctx: Ctx) => resolveVoice('openai', ctx.req.params?.voice) ?? 'alloy',
    /** Realtime audio goes on the wire base64-encoded. */
    realtimeAudioBase64: (_v, ctx: Ctx) => bytesToBase64(ctx.req.audio),
    /** turnComplete defaults to true; only an explicit `false` suppresses it. */
    realtimeTurnComplete: (_v, ctx: Ctx) => ctx.req.turnComplete !== false,

    /** xAI media refs, reusing the library's own normalisers. */
    xaiSourceImageRef: (_v, ctx: Ctx) => xaiImageRef(normalizeImageSource(ctx.req.sourceImage)),
    xaiSourceVideoRef: (_v, ctx: Ctx) => xaiVideoRef(ctx.req.sourceVideo),
    /** OpenRouter sends the source image as a data URL inside a chat part. */
    openrouterDataUrl: (_v, ctx: Ctx) => toDataUrl(normalizeImageSource(ctx.req.sourceImage)),
    /** image_config is built by the adapter's own private helper. */
    openrouterImageConfig: (_v, ctx: Ctx) => a.openrouterMedia.imageConfig(ctx.req.params),

    /** xAI names a batch from its contents; mirrors the adapter's batchName(). */
    xaiBatchName: (_v, ctx: Ctx) => {
      const reqs = ctx.req.requests ?? [];
      const ids = reqs.map((r: any) => r.customId).join(String.fromCharCode(0));
      return `batch_${reqs.length}_${fnv1a32Hex(ids)}`;
    },

    /** Embeddings: `input` is always an array on the wire. */
    asArray: (v) => (Array.isArray(v) ? v : [v]),
    /** Google batch names itself after the request count — deterministic, unlike xAI's. */
    requestCount: (_v, ctx: Ctx) => String((ctx.req.requests ?? []).length),

    /** Sora sends `seconds` as a string even though the unified param is a number. */
    stringify: (v) => String(v),

    /** Gemini TTS voice, with the adapter's default. */
    googleTtsVoice: (_v, ctx: Ctx) => resolveVoice('google', ctx.req.params?.voice) ?? 'Kore',

    // ── the variant rule a pattern cannot express (FINDING) ───────────────
    /** Version arithmetic: family-then-version ids compared against 4.6.
     *  This is the one variant that resists being data, and it is exactly the
     *  knowledge a catalog spec-pin would carry instead. */
    anthropicAdaptiveThinking: (model: any) => anthropicThinkingShape(String(model)) === 'adaptive',
  };

  const builders: Registry['builders'] = {
    // Structural message/content transformation — genuinely code, reused verbatim.
    anthropicMessages: (ctx) => {
      const req = ctx.req;
      const cacheAutoLast = req.cache === 'auto';
      const lastIdx = req.messages.length - 1;
      return req.messages.map((m: any, i: number) =>
        a.anthropic.buildMessage(m, req, cacheAutoLast && i === lastIdx),
      );
    },
    googleContents: (ctx) => {
      const out: unknown[] = [];
      for (const msg of ctx.req.messages) {
        if (msg.role === 'system') continue; // carried by systemInstruction
        out.push(a.google.buildContent(msg));
      }
      return out;
    },
    openaiChatMessages: (ctx) => {
      const out: Record<string, unknown>[] = [];
      if (ctx.req.system) out.push({ role: 'system', content: ctx.req.system });
      for (const msg of ctx.req.messages) out.push(...a.openaiCompletions.buildMessages(msg));
      return out;
    },
    googleInteractionsInput: (ctx) => {
      const out: unknown[] = [];
      for (const msg of ctx.req.messages) out.push(...a.googleInteractions.buildInputItems(msg));
      return out;
    },
    openaiResponsesInput: (ctx) => {
      const out: unknown[] = [];
      const toolNames = new Map<string, string>();
      for (const msg of ctx.req.messages) {
        out.push(...a.openaiResponses.buildInputItems(msg, toolNames));
      }
      return out;
    },
  };

  const predicates: Registry['predicates'] = {
    /** Realtime text is sent when it is non-null — an empty string still counts,
     *  which `truthy` would miss. */
    realtimeHasText: (ctx) => ctx.req.text !== null && ctx.req.text !== undefined,

    isFunctionTool: (ctx) => isFunctionToolValue(ctx.item?.value),
    toolChoiceIsString: (ctx) => typeof ctx.req.toolChoice === 'string',

    anthropicCacheSystem: (ctx) =>
      ctx.req.cache === 'auto' ||
      (typeof ctx.req.cache === 'object' && ctx.req.cache !== null && Boolean(ctx.req.cache.system)),
    anthropicCacheTools: (ctx) =>
      ctx.req.cache === 'auto' ||
      (typeof ctx.req.cache === 'object' && ctx.req.cache !== null && Boolean(ctx.req.cache.tools)),

    /** Content-derived: needs to look inside message parts. */
    hasFileRef: (ctx) =>
      ctx.req.messages.some((m: any) => {
        if (typeof m.content === 'string') return false;
        return m.content.some((p: any) => {
          const s = p?.source;
          return s?.type === 'provider_ref' || s?.type === 'file';
        });
      }),
    hasAudioInput: (ctx) =>
      ctx.req.messages.some(
        (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'audio'),
      ),
    usesCodeExec: (ctx) =>
      Boolean(ctx.req.tools?.some((t: any) => !isFunctionToolValue(t) && t.type === 'code_interpreter')),
    hasUserProfileId: (ctx) => {
      const v = ctx.req.providerOptions?.userProfileId;
      return typeof v === 'string' && v.length > 0;
    },
    /** image_config ships only when the adapter's helper produced something. */
    openrouterHasImageConfig: (ctx) =>
      Object.keys(a.openrouterMedia.imageConfig(ctx.req.params) ?? {}).length > 0,

    /** Google emits speechConfig only when a voice actually resolves. */
    googleHasVoice: (ctx) => Boolean(resolveVoice('google', ctx.req.audio?.voice)),

    /** Only the multi-agent grok uses reasoning.effort (as an agent count). */
    xaiMultiAgent: (ctx) => String(ctx.req.model).includes('multi-agent'),

    wantsNativeModeration: (ctx) =>
      Boolean(
        (ctx.req.moderation && ctx.req.moderation.mode !== 'emulate') ||
          ctx.req.providerOptions?.moderationPolicy,
      ),
  };

  const effects: Registry['effects'] = {
    // ── flavor overlays: the ops that need code rather than data ──────────
    /** xAI puts the system prompt in `input` as a role:system item. Structural,
     *  so it is code — but it is the ONLY structural op in four overlays. */
    xaiSystemIntoInput: (ctx) => {
      if (ctx.req.system && ctx.body.instructions) {
        (ctx.body.input as unknown[]).unshift({ role: 'system', content: ctx.req.system });
        delete ctx.body.instructions;
      }
    },
    /** xAI's tier enum is DEFAULT|PRIORITY, narrower than the inherited map. */
    xaiServiceTier: (ctx) => {
      const t = xaiRequestTier(ctx.req.serviceTier);
      if (t) ctx.body.service_tier = t;
      else delete ctx.body.service_tier;
    },
    /** Code-execution outputs are returned only when asked for by `include`. */
    xaiCodeExecInclude: (ctx) => {
      const uses = ctx.req.tools?.some(
        (t: any) => !isFunctionToolValue(t) && t.type === 'code_interpreter',
      );
      if (!uses) return;
      const include = new Set([
        ...((ctx.body.include as string[]) ?? []),
        'code_interpreter_call.outputs',
      ]);
      ctx.body.include = [...include];
    },
    /** OpenRouter expresses web search as a `:online` model suffix, not a tool. */
    openrouterOnline: (ctx) => {
      const uses = ctx.req.tools?.some((t: any) => !isFunctionToolValue(t) && t.type === 'web_search');
      if (!uses) return;
      const model = ctx.body.model as string | undefined;
      if (model && !model.endsWith(':online')) ctx.body.model = `${model}:online`;
      if (Array.isArray(ctx.body.tools) && ctx.body.tools.length === 0) delete ctx.body.tools;
    },

    /** Anthropic requires max_tokens > budget_tokens — a cross-field rule, so it
     *  cannot be a field mapping. One of only two effects in four specs. */
    liftMaxTokensAboveBudget: (ctx) => {
      const budget = (ctx.body.thinking as any)?.budget_tokens as number | undefined;
      if (budget === undefined) return;
      if ((ctx.body.max_tokens as number) <= budget) ctx.body.max_tokens = budget + 1024;
    },
  };

  return { transforms, builders, predicates, effects };
}
