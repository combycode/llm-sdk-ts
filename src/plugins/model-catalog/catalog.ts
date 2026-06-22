/** ModelCatalog — pricing, capabilities, and model info. Loaded from JSON. */

import anthropicCatalog from '../../llm/providers/anthropic/catalog.json';
import googleCatalog from '../../llm/providers/google/catalog.json';
import openaiCatalog from '../../llm/providers/openai/catalog.json';
import openrouterCatalog from '../../llm/providers/openrouter/catalog.json';
import xaiCatalog from '../../llm/providers/xai/catalog.json';

const PROVIDER_DEFAULT_CATALOGS: Record<string, unknown>[] = [
  anthropicCatalog as Record<string, unknown>,
  openaiCatalog as Record<string, unknown>,
  googleCatalog as Record<string, unknown>,
  xaiCatalog as Record<string, unknown>,
  openrouterCatalog as Record<string, unknown>,
];

export type ApiType = 'responses' | 'completions' | 'interactions' | 'generate' | 'messages';

export interface ModelPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  /** Audio token rates (realtime / audio models), per 1M tokens. */
  audioInputPerMTok?: number;
  audioOutputPerMTok?: number;
  perImage?: number;
  perSecond?: number;
  /** Speech-to-text transcription rate (USD per minute of audio). Used by
   *  whisper-class and gpt-4o-transcribe when the provider bills by duration,
   *  not by token. The cost engine multiplies by audio duration in minutes. */
  perMinute?: number;
  perMChars?: number;
  /** Per-unit rates keyed by a quality/resolution tier (e.g. video
   *  `{"720p":0.1,"1080p":0.12}`, image `{"1k":0.002,"2k":0.02}`). When the
   *  selected resolution matches a key, it overrides the flat perImage/perSecond. */
  perUnit?: Record<string, number>;
  /** Per-service-tier rate overrides, keyed by the provider's OWN billed tier
   *  name (the value the provider returns: anthropic `standard|priority|batch`,
   *  openai `flex|scale|priority|batch`). The flat fields above are the implicit
   *  `standard` tier. Cost looks up `tiers[usage.pricingTier]`, falling back to
   *  the flat fields — so models without tiers behave exactly as before. */
  tiers?: Record<string, TierRates>;
}

/** One service tier's rate overrides — same shape as the flat rates, no nesting. */
export type TierRates = Omit<ModelPricing, 'tiers'>;

export interface ModelCapabilities {
  toolUse: boolean;
  builtinTools?: string[];
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  imageGeneration: boolean;
  audioGeneration: boolean;
  videoGeneration: boolean;
}

/** One generation parameter a media model accepts, with its allowed values.
 *  Either an enum (`values` + `default`) or a numeric range (`min`/`max`).
 *  Keys are normalized (e.g. `aspectRatio`, `size`, `voice`, `duration`); each
 *  provider adapter maps the normalized key to its own wire param name. */
export interface MediaParamSpec {
  /** Enumerated allowed values for a string param. */
  values?: string[];
  /** Numeric bounds for an integer param (e.g. duration seconds, image count). */
  min?: number;
  max?: number;
  /** Default value (blank/omitted means "let the provider decide"). */
  default?: string | number;
  /** Where the allowed values came from + when last verified. */
  source?: string;
  verifiedOn?: string;
}

export interface ModelReasoning {
  supported: boolean;
  automatic: boolean;
  effortControl: boolean;
  effortValues?: string[];
  encryptedContent: boolean;
  summaryAvailable: boolean;
}

export interface TokenizerInfo {
  strategy: 'heuristic' | 'tiktoken' | 'count_api';
  charsPerTokenDefault: number;
  countApiAvailable: boolean;
  tiktokenEncoding?: string;
}

export interface ModelInfo {
  provider: string;
  /** Catalog key — our canonical (normalised) slug, e.g. `claude-opus-4.8`. */
  model: string;
  pricing: ModelPricing;
  preferredApi: ApiType;
  supportedApis: ApiType[];
  contextWindow?: number;
  maxOutput?: number;
  capabilities: ModelCapabilities;
  reasoning: ModelReasoning;
  mediaOnly?: boolean;
  tokenizer?: TokenizerInfo;
  requiresDedicatedClient?: boolean;
  supportsPreviousResponseId?: boolean;
  /** Exact id to SEND to the provider API (may differ from the slug + carry
   *  dates). When set, the SDK sends this; otherwise it sends `model`. */
  providerModelName?: string;
  /** Other callable ids that resolve to this model (dated snapshots, the bare
   *  callable form). Indexed for lookup + accepted as model strings. */
  aliases?: string[];
  /** Model role/modality: chat | code | image | video | tts | stt | embedding | … */
  type?: string;
  /** Content kinds the model ACCEPTS as input: text | image | audio | video |
   *  pdf. Use to decide whether prior media can be replayed to this model. */
  inputModalities?: string[];
  /** Content kinds the model PRODUCES: text | image | audio | video. */
  outputModalities?: string[];
  /** For media models: the generation params this model accepts + allowed
   *  values, keyed by normalized param name. Drives UI + validation. */
  mediaParams?: Record<string, MediaParamSpec>;
  family?: string;
  version?: string;
  /** Lifecycle: stable | preview | legacy. */
  status?: string;
  /** Callable from this account/SDK now (probe-verified). false = don't call. */
  active?: boolean;
  /** End-of-life signalled by a source. */
  deprecation?: { date?: string; shutdownDate?: string; source: string };
  /** Server-side state retention as a duration string ("30d", "72h"). null = none. */
  stateRetentionDuration?: string | null;
  /** Whether server-state continuation requires the SAME model (true) or works
   *  across models of the same provider (false). Safe default: true. */
  stateModelBound?: boolean;
}

// Provider-level server-state defaults (used when a model has no explicit value,
// or isn't in the catalog at all). These are global defaults baked in here.
const PROVIDER_STATE: Record<
  string,
  { supports: boolean; retention: string | null; modelBound: boolean }
> = {
  // OpenAI/xAI: previous_response_id survives most model swaps but can break at
  // reasoning-model boundaries -> treat as model-bound (safe).
  openai: { supports: true, retention: '30d', modelBound: true },
  xai: { supports: true, retention: '30d', modelBound: true },
  // Google: server-state via the Interactions API; docs + live test confirm it
  // works ACROSS models of the same provider -> not model-bound. ~72h retention.
  google: { supports: true, retention: '72h', modelBound: false },
  anthropic: { supports: false, retention: null, modelBound: true },
  openrouter: { supports: false, retention: null, modelBound: true },
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolUse: true,
  streaming: true,
  structuredOutput: true,
  vision: false,
  audio: false,
  video: false,
  imageGeneration: false,
  audioGeneration: false,
  videoGeneration: false,
};

const DEFAULT_REASONING: ModelReasoning = {
  supported: false,
  automatic: false,
  effortControl: false,
  encryptedContent: false,
  summaryAvailable: false,
};

export class ModelCatalog {
  private models = new Map<string, ModelInfo>();
  /** `provider/alias` → `provider/canonical-slug`. Lets get()/resolveModelId
   *  accept any callable id (providerModelName, dated snapshot) AND the slug. */
  private aliasIndex = new Map<string, string>();

  private key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  set(
    provider: string,
    model: string,
    info: Partial<Omit<ModelInfo, 'provider' | 'model'>> & { pricing: ModelPricing },
  ): void {
    const canonical = this.key(provider, model);
    this.models.set(canonical, {
      provider,
      model,
      pricing: info.pricing,
      preferredApi: info.preferredApi ?? 'completions',
      supportedApis: info.supportedApis ?? [info.preferredApi ?? 'completions'],
      contextWindow: info.contextWindow,
      maxOutput: info.maxOutput,
      capabilities: { ...DEFAULT_CAPABILITIES, ...info.capabilities },
      reasoning: { ...DEFAULT_REASONING, ...info.reasoning },
      mediaOnly: info.mediaOnly,
      tokenizer: info.tokenizer,
      requiresDedicatedClient: info.requiresDedicatedClient,
      supportsPreviousResponseId: info.supportsPreviousResponseId,
      stateRetentionDuration: info.stateRetentionDuration,
      stateModelBound: info.stateModelBound,
      providerModelName: info.providerModelName,
      aliases: info.aliases,
      type: info.type,
      inputModalities: info.inputModalities,
      outputModalities: info.outputModalities,
      mediaParams: info.mediaParams,
      family: info.family,
      version: info.version,
      status: info.status,
      active: info.active,
      deprecation: info.deprecation,
    });
    // Index callable ids → this slug (don't shadow a real slug key).
    for (const alias of [info.providerModelName, ...(info.aliases ?? [])]) {
      if (alias && !this.models.has(this.key(provider, alias))) {
        this.aliasIndex.set(this.key(provider, alias), canonical);
      }
    }
  }

  get(provider: string, model: string): ModelInfo | null {
    const direct = this.models.get(this.key(provider, model));
    if (direct) return direct;
    const canonical = this.aliasIndex.get(this.key(provider, model));
    return canonical ? (this.models.get(canonical) ?? null) : null;
  }

  /** The exact id to SEND to the provider for a given model string. Translates
   *  our slug → providerModelName; passes an already-callable id (alias) through
   *  verbatim (respects an explicit choice); unknown model → verbatim passthrough. */
  resolveModelId(provider: string, model: string): string {
    const direct = this.models.get(this.key(provider, model));
    if (direct) return direct.providerModelName ?? model; // model === slug → translate
    return model; // alias (already callable) or unknown → as-is
  }

  getPricing(provider: string, model: string): ModelPricing | null {
    return this.get(provider, model)?.pricing ?? null;
  }

  getPreferredApi(provider: string, model: string): ApiType | null {
    return this.get(provider, model)?.preferredApi ?? null;
  }

  supportsApi(provider: string, model: string, api: ApiType): boolean {
    const info = this.get(provider, model);
    return info ? info.supportedApis.includes(api) : false;
  }

  supportsTools(provider: string, model: string): boolean {
    return this.get(provider, model)?.capabilities.toolUse ?? false;
  }

  supportsPreviousResponseId(provider: string, model: string): boolean {
    const info = this.get(provider, model);
    // A model carries server-state only on a stateful API (responses / interactions).
    if (info && !info.supportedApis.some((a) => a === 'responses' || a === 'interactions')) {
      return false;
    }
    if (info?.supportsPreviousResponseId !== undefined) return info.supportsPreviousResponseId;
    return PROVIDER_STATE[provider]?.supports ?? false;
  }

  /** Server-state retention as a duration string ("30d", "72h"), or null if unsupported. */
  getStateRetention(provider: string, model: string): string | null {
    const info = this.get(provider, model);
    if (info?.stateRetentionDuration !== undefined) return info.stateRetentionDuration;
    return PROVIDER_STATE[provider]?.retention ?? null;
  }

  /** Whether server-state continuation requires the same model (true) or works
   *  across models of the same provider (false). Safe default: true. */
  isStateModelBound(provider: string, model: string): boolean {
    const info = this.get(provider, model);
    if (info?.stateModelBound !== undefined) return info.stateModelBound;
    return PROVIDER_STATE[provider]?.modelBound ?? true;
  }

  list(provider?: string): ModelInfo[] {
    const all = [...this.models.values()];
    return provider ? all.filter((m) => m.provider === provider) : all;
  }

  load(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const provider = key.slice(0, slash);
      const model = key.slice(slash + 1);
      const v = value as Record<string, unknown>;
      if ('inputPerMTok' in v) {
        this.set(provider, model, { pricing: v as unknown as ModelPricing });
      } else if ('pricing' in v) {
        this.set(provider, model, v as Partial<ModelInfo> & { pricing: ModelPricing });
      }
    }
  }

  /** Load every provider's `catalog.json` shipped with the SDK. Synchronous —
   *  the JSON files are bundled via static import so no I/O at runtime. */
  loadProviderDefaults(): void {
    for (const data of PROVIDER_DEFAULT_CATALOGS) {
      this.load(data);
    }
  }

  get size(): number {
    return this.models.size;
  }
}
