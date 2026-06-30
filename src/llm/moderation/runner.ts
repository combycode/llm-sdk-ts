/** Emulated-moderation runner + streaming strategy wrappers.
 *
 *  The emulated path runs OpenAI's moderations endpoint around a call for any
 *  provider. This module owns:
 *    - mode resolution (native vs emulate, by provider)
 *    - input-text extraction (the last user message)
 *    - a single moderation call (errors → an `{error}` entry, report-only)
 *    - the buffer / parallel / post stream wrappers
 *
 *  It depends only on Layer-2 primitives (the OpenAI moderations adapter + the
 *  injected fetch) — never on the helpers layer — so the client can use it
 *  without an upward import. */

import type { HookBus } from '../../bus/hook-bus';
import type { CostEntry } from '../../bus/hook-map';
import type { EngineFetch } from '../../network/types';
import type { ModerationResult } from '../../helpers/moderate-types';
import { contentText } from '../types/messages';
import type { Message } from '../types/messages';
import type { ProviderName } from '../types/provider';
import type { StreamEvent } from '../types/stream';
import { OpenAIModerationAdapter } from '../providers/openai/moderations';
import type { ModerationEntry, ModerationRequest, ModerationStreamStrategy } from './types';
import { MODERATION_DEFAULT_INTERVAL, MODERATION_DEFAULT_MODEL } from './types';

/** Native for OpenAI, emulated for everyone else — unless explicitly forced. */
export function resolveModerationMode(
  provider: ProviderName,
  mod: ModerationRequest,
): 'native' | 'emulate' {
  if (mod.mode) return mod.mode;
  return provider === 'openai' ? 'native' : 'emulate';
}

/** Text of the last user message — what input moderation runs on. */
export function moderationInputText(messages: Message[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return '';
  return typeof lastUser.content === 'string' ? lastUser.content : contentText(lastUser.content);
}

export interface EmulationConfig {
  apiKey: string;
  model: string;
  fetch: EngineFetch;
}

function emptyResult(): ModerationResult {
  return {
    flagged: false,
    categories: {} as unknown as ModerationResult['categories'],
    categoryScores: {} as unknown as ModerationResult['categoryScores'],
  };
}

/** One moderation call. Empty text → an un-flagged empty result (nothing to check).
 *  A moderation-infra failure → an `{error}` entry (report-only; never throws so a
 *  flaky moderations endpoint can't take down the primary call). */
export async function runModeration(text: string, cfg: EmulationConfig): Promise<ModerationEntry> {
  if (!text) return emptyResult();
  try {
    const adapter = new OpenAIModerationAdapter({ apiKey: cfg.apiKey });
    const results = await adapter.moderate(text, cfg.model, cfg.fetch);
    return results[0] ?? emptyResult();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function moderationModel(mod: ModerationRequest): string {
  return mod.model ?? MODERATION_DEFAULT_MODEL;
}

/** Emit an honest-zero cost entry for one emulated moderation call (the
 *  moderations endpoint is free) so the cost ledger has no gaps. */
export function emitModerationZeroCost(hooks: HookBus, model: string): void {
  const entry: CostEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    provider: 'openai',
    model,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, source: 'calculated' },
    providerEvidence: { note: 'free: moderations endpoint not billed' },
    tags: { provider: 'openai', model, type: 'moderation' },
  };
  hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
}

// ─── Streaming strategy wrappers ──────────────────────────────────────────────

type Moderate = (text: string) => Promise<ModerationEntry>;

function outputEvent(result: ModerationEntry): StreamEvent {
  return { type: 'moderation', phase: 'output', result, source: 'emulated' };
}

/** Dispatch to the chosen strategy. `interval` defaults applied by the caller. */
export function wrapModeratedStream(
  raw: AsyncIterable<StreamEvent>,
  strategy: ModerationStreamStrategy,
  interval: number,
  moderate: Moderate,
): AsyncIterable<StreamEvent> {
  const step = interval > 0 ? interval : MODERATION_DEFAULT_INTERVAL;
  if (strategy === 'post') return wrapPost(raw, moderate);
  if (strategy === 'parallel') return wrapParallel(raw, step, moderate);
  return wrapBuffer(raw, step, moderate);
}

/** post: forward everything, then one moderation pass on the full text. */
async function* wrapPost(raw: AsyncIterable<StreamEvent>, moderate: Moderate): AsyncIterable<StreamEvent> {
  let acc = '';
  for await (const ev of raw) {
    if (ev.type === 'text') acc += ev.text;
    yield ev;
  }
  if (acc) yield outputEvent(await moderate(acc));
}

/** buffer: hold chunks, moderate cumulative text at each boundary, emit the result
 *  BEFORE releasing the held chunks so the flag never trails the text. */
async function* wrapBuffer(
  raw: AsyncIterable<StreamEvent>,
  interval: number,
  moderate: Moderate,
): AsyncIterable<StreamEvent> {
  let acc = '';
  let checkedAt = 0;
  let hold: StreamEvent[] = [];
  for await (const ev of raw) {
    hold.push(ev);
    if (ev.type === 'text') {
      acc += ev.text;
      if (acc.length - checkedAt >= interval || ev.text.includes('\n')) {
        checkedAt = acc.length;
        yield outputEvent(await moderate(acc));
        for (const h of hold) yield h;
        hold = [];
      }
    }
  }
  // Tail: moderate any text produced since the last check, then flush the rest.
  if (acc.length > checkedAt) yield outputEvent(await moderate(acc));
  for (const h of hold) yield h;
}

/** parallel: forward chunks immediately; moderate concurrently; surface each result
 *  as soon as it resolves (merged into the live stream via a race). */
async function* wrapParallel(
  raw: AsyncIterable<StreamEvent>,
  interval: number,
  moderate: Moderate,
): AsyncIterable<StreamEvent> {
  const iter = raw[Symbol.asyncIterator]();
  const pending = new Set<Promise<{ tag: 'mod'; event: StreamEvent }>>();
  let acc = '';
  let checkedAt = 0;
  let rawDone = false;
  let rawNext = iter.next();

  const schedule = (text: string): void => {
    const p = moderate(text).then((result) => {
      pending.delete(p);
      return { tag: 'mod' as const, event: outputEvent(result) };
    });
    pending.add(p);
  };

  while (!rawDone || pending.size > 0) {
    const racers: Promise<{ tag: 'raw'; result: IteratorResult<StreamEvent> } | { tag: 'mod'; event: StreamEvent }>[] =
      [];
    if (!rawDone) racers.push(rawNext.then((result) => ({ tag: 'raw' as const, result })));
    for (const p of pending) racers.push(p);

    const winner = await Promise.race(racers);
    if (winner.tag === 'mod') {
      yield winner.event;
      continue;
    }
    // raw chunk
    if (winner.result.done) {
      rawDone = true;
      if (acc.length > checkedAt) schedule(acc); // final pass on the tail
      continue;
    }
    const ev = winner.result.value;
    yield ev;
    if (ev.type === 'text') {
      acc += ev.text;
      if (acc.length - checkedAt >= interval) {
        checkedAt = acc.length;
        schedule(acc);
      }
    }
    rawNext = iter.next();
  }
}
