/** createMediaOutput — convenience wrapper around MediaOutput.
 *
 *  Pass a `model: 'provider/...'` string and a `dir`; the helper:
 *    - builds a FileMediaStore at `dir`,
 *    - threads engine.fetch + hooks + catalog,
 *    - auto-registers the right MediaProviderAdapter for the model's
 *      provider (using engine.apiKeys[provider] for credentials),
 *    - returns a MediaOutputHandle whose `generateImage / generateAudio /
 *      generateVideo` methods don't repeat provider+model — the configured
 *      defaults flow through.
 *
 *  Override the auto-built adapter via `providers` if you need a custom
 *  baseURL or shared instance. */

import { GoogleMediaAdapter } from '../llm/providers/google/media';
import { OpenAIMediaAdapter } from '../llm/providers/openai/media';
import { OpenRouterMediaAdapter } from '../llm/providers/openrouter/media';
import { XAIMediaAdapter } from '../llm/providers/xai/media';
import type { ProviderName } from '../llm/types/provider';
import { FileMediaStore } from '../plugins/media/file-store';
import { MediaOutput, type MediaOutputInit } from '../plugins/media/output';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  MediaProviderAdapter,
  MediaResult,
  MediaStore,
  VideoGenRequest,
} from '../plugins/media/types';
import { isNamespacedModelId, parseModelId } from './client-resolver';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

type ProviderAdapterMap = Partial<Record<string, MediaProviderAdapter>>;

export interface CreateMediaOutputOptions {
  /** Directory where generated media bytes + metadata land (Node/Bun). Provide
   *  this OR `store`. */
  dir?: string;
  /** Bring your own MediaStore. Use `new MemoryMediaStore()` in the browser
   *  (FileMediaStore needs a filesystem). Takes precedence over `dir`. */
  store?: MediaStore;
  /** Default model. Either bare (`gpt-image-1`, paired with `provider`) or
   *  namespaced (`openai/gpt-image-1`). The helper builds the matching
   *  adapter automatically when not overridden via `providers`. */
  model?: string;
  /** Required when `model` is bare or omitted. */
  provider?: ProviderName;
  /** Optional — falls back to `engine.apiKeys[provider]`. */
  apiKey?: string;
  /** Override or extend the auto-built provider adapter map. */
  providers?: ProviderAdapterMap;
  engine?: EngineHandle;
  config?: MediaOutputInit['config'];
}

export interface MediaOutputHandle {
  /** Underlying MediaOutput, in case you need to register more providers
   *  or call methods that don't have a defaulting wrapper here. */
  raw: MediaOutput;
  /** Generate one or more images. `provider` and `model` default to the
   *  ones passed to `createMediaOutput`. */
  generateImage(req?: PartialMediaReq<ImageGenRequest>): Promise<MediaResult[]>;
  generateAudio(req?: PartialMediaReq<AudioGenRequest>): Promise<MediaResult>;
  editImage(req: PartialMediaReq<ImageEditRequest>): Promise<MediaResult[]>;
  generateVideo(req?: PartialMediaReq<VideoGenRequest>): Promise<MediaResult>;
}

type PartialMediaReq<T extends { provider: string; model?: string }> = Omit<
  T,
  'provider' | 'model'
> & { provider?: string; model?: string };

const DEFAULT_MEDIA_ADAPTERS: Record<
  string,
  new (cfg: {
    apiKey: string;
  }) => MediaProviderAdapter
> = {
  openai: OpenAIMediaAdapter,
  google: GoogleMediaAdapter,
  xai: XAIMediaAdapter,
  openrouter: OpenRouterMediaAdapter,
};

export function createMediaOutput(opts: CreateMediaOutputOptions): MediaOutputHandle {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider: defaultProvider, model: defaultModel } = resolveDefaults(opts);

  if (!opts.store && !opts.dir) {
    throw new Error(
      'createMediaOutput: pass `dir` (Node/Bun) or `store` (e.g. new MemoryMediaStore() in the browser).',
    );
  }
  const mediaStore = opts.store ?? new FileMediaStore({ dir: opts.dir as string });
  const output = new MediaOutput({
    hooks: engine.hooks,
    mediaStore,
    fetch: engine.fetch,
    catalog: engine.catalog,
    config: opts.config,
    sessionId: engine.sessionId,
  });

  // Register caller-provided adapters first (they win if overlap).
  const overrides = opts.providers ?? {};
  for (const [name, adapter] of Object.entries(overrides)) {
    if (adapter) output.registerProvider(name, adapter);
  }
  // Auto-register the default model's provider when the caller didn't.
  if (defaultProvider && !overrides[defaultProvider]) {
    const ctor = DEFAULT_MEDIA_ADAPTERS[defaultProvider];
    if (ctor) {
      const apiKey = opts.apiKey ?? engine.apiKeys[defaultProvider as ProviderName];
      if (!apiKey) {
        throw new Error(
          `createMediaOutput: no API key for provider "${defaultProvider}". ` +
            `Pass apiKey or set engine.apiKeys["${defaultProvider}"], or pass a ` +
            `prebuilt adapter via \`providers\`.`,
        );
      }
      output.registerProvider(defaultProvider, new ctor({ apiKey }));
    }
  }

  const requireProvider = (req?: { provider?: string }): string => {
    const p = req?.provider ?? defaultProvider;
    if (!p) {
      throw new Error(
        'createMediaOutput: provider not set on call and no default `model` was configured',
      );
    }
    return p;
  };

  // Translate our normalised slug to the provider's callable id (e.g.
  // `gemini-3.1-flash-tts` -> `gemini-3.1-flash-tts-preview`) via the catalog,
  // the same way createLLM does. Unknown/callable ids pass through unchanged.
  const resolveModelId = (provider: string, model: string | undefined): string | undefined =>
    model ? engine.catalog.resolveModelId(provider, model) : model;

  return {
    raw: output,
    generateImage: (req) => {
      const provider = requireProvider(req);
      return output.generateImage({
        ...(req as ImageGenRequest),
        provider,
        model: resolveModelId(provider, req?.model ?? defaultModel),
        prompt: (req as ImageGenRequest)?.prompt ?? '',
      });
    },
    generateAudio: (req) => {
      const provider = requireProvider(req);
      return output.generateAudio({
        ...(req as AudioGenRequest),
        provider,
        model: resolveModelId(provider, req?.model ?? defaultModel),
        input: (req as AudioGenRequest)?.input ?? '',
      });
    },
    editImage: (req) => {
      const provider = requireProvider(req);
      return output.editImage({
        ...(req as ImageEditRequest),
        provider,
        model: resolveModelId(provider, req.model ?? defaultModel),
      });
    },
    generateVideo: (req) => {
      const provider = requireProvider(req);
      return output.generateVideo({
        ...(req as VideoGenRequest),
        provider,
        model: resolveModelId(provider, req?.model ?? defaultModel),
        prompt: (req as VideoGenRequest)?.prompt ?? '',
      });
    },
  };
}

function resolveDefaults(opts: CreateMediaOutputOptions): { provider?: string; model?: string } {
  if (!opts.model) {
    return { provider: opts.provider };
  }
  if (isNamespacedModelId(opts.model)) {
    const [p, m] = parseModelId(opts.model);
    return { provider: p, model: m };
  }
  return { provider: opts.provider, model: opts.model };
}
