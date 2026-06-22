/** route() — provider routing with fallback.
 *
 *  V2 (client-side): try each model in order; on a *retryable* failure
 *  (classified ErrorKind) fall over to the next; on a non-retryable failure
 *  (auth, invalid_request, content_filter, …) fail fast — another model won't
 *  fix a fundamentally bad request. Works across providers.
 *
 *  V1 (openrouter passthrough): when every model is openrouter, send ONE request
 *  with a `models` array and let OpenRouter route server-side (one round-trip;
 *  `response.model` reports who served). */

import type { ErrorKind } from '../network/errors';
import { LLMError } from '../network/errors';
import { complete, type CompleteOptions, type CompleteResult } from './one-shot';
import { isNamespacedModelId, parseModelId } from './client-resolver';

/** Failures worth trying another model for. Excludes auth / invalid_request /
 *  content_filter / context_overflow (model swap won't help) by default. */
const DEFAULT_FALLBACK_KINDS: readonly ErrorKind[] = [
  'rate_limit',
  'server_error',
  'model_not_found',
  'timeout',
  'network',
  'quota_exceeded',
  'unsupported',
];

export interface RouteOptions extends Omit<CompleteOptions, 'model' | 'provider'> {
  /** Ordered candidate models — "provider/model" (namespaced) preferred. */
  models: string[];
  /** Override which ErrorKinds trigger fallback. */
  fallbackOn?: ErrorKind[];
}

export interface RouteAttempt {
  model: string;
  error?: string;
  kind?: ErrorKind;
}

export interface RouteResult<T = unknown> extends CompleteResult<T> {
  /** The candidate model whose request produced this result. */
  servedBy: string;
  attempts: RouteAttempt[];
}

export async function route<T = unknown>(opts: RouteOptions): Promise<RouteResult<T>> {
  const { models, fallbackOn, ...completeOpts } = opts;
  if (!models?.length) throw new Error('route: `models` must be a non-empty array.');

  // V1 — native openrouter routing: one request with a `models` array, server
  // routes + falls over; response.model reports who served. (OpenRouter wants the
  // bare model ids, not the "openrouter/" namespace prefix.)
  if (models.length > 1 && models.every((m) => providerOf(m) === 'openrouter')) {
    const bare = models.map(stripProvider);
    const prevOpenrouter =
      (completeOpts.providerOptions?.openrouter as Record<string, unknown>) ?? {};
    const res = await complete<T>({
      ...(completeOpts as CompleteOptions),
      model: models[0],
      providerOptions: {
        ...(completeOpts.providerOptions ?? {}),
        openrouter: { ...prevOpenrouter, models: bare },
      },
    });
    return { ...res, servedBy: res.response.model || models[0], attempts: [{ model: models[0] }] };
  }

  // V2 — client-side sequential fallback.
  const fallbackKinds = new Set(fallbackOn ?? DEFAULT_FALLBACK_KINDS);
  const attempts: RouteAttempt[] = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await complete<T>({ ...(completeOpts as CompleteOptions), model });
      return { ...res, servedBy: model, attempts: [...attempts, { model }] };
    } catch (e) {
      const kind = e instanceof LLMError ? e.kind : undefined;
      attempts.push({ model, error: (e as Error).message, kind });
      const retryable = kind != null && fallbackKinds.has(kind);
      if (!retryable) throw e; // non-retryable → another model won't help
      // retryable: fall through to the next candidate (or exhaust below)
    }
  }
  throw new Error(
    `route: all ${models.length} model(s) failed:\n` +
      attempts.map((a) => `  ${a.model} [${a.kind ?? 'error'}]: ${a.error}`).join('\n'),
  );
}

function providerOf(model: string): string | undefined {
  return isNamespacedModelId(model) ? parseModelId(model)[0] : undefined;
}

/** Drop a leading "provider/" namespace, keeping the bare model id. */
function stripProvider(model: string): string {
  return isNamespacedModelId(model) ? parseModelId(model)[1] : model;
}
