/** Every recorded provider response still parses to the same thing.
 *
 *  The request corpora answer "do we still SEND what we sent?". This answers the
 *  other half — "do we still UNDERSTAND what comes back?" — and it is the half
 *  that had no evidence at all: `parseResponse` was exercised only against
 *  literals written by hand in the test files, which is a test of what the author
 *  believed a provider returns.
 *
 *  These bodies are real. `scripts/record-responses.ts` drove seven adapters
 *  against live providers and captured the pre-parse HTTP body, or the ordered SSE
 *  events, straight off the bus. Replay needs no network and no stub: the same
 *  adapter, the same `parseResponse` / `createStreamParser`, the same bytes.
 *
 *  What a failure here means:
 *    - a PARSER change altered what consumers receive. Intended or not, it is now
 *      visible instead of silent.
 *    - re-running the recorder with --refresh moves `raw` too, and then the diff
 *      shows what the PROVIDER changed.
 */
import { describe, expect, it } from 'bun:test';
import {
  adapterFor,
  cellId,
  REPLAY_KEY,
  RESPONSE_SCENARIOS,
  RESPONSE_TARGETS,
  type ResponseCell,
} from './response-corpus';
import type { SSEEvent } from '../../../src/network/types';
import golden from '../../fixtures/response-golden.json' with { type: 'json' };

const corpus = golden as unknown as Record<string, ResponseCell>;

/** The recorder fixes latency at 0 for the same reason: it is wall-clock, and a
 *  corpus that depended on it would fail at random. */
const LATENCY = 0;

function replay(cell: ResponseCell): unknown {
  const target = RESPONSE_TARGETS.find((t) => t.key === cell.target);
  if (!target) throw new Error(`no target definition for "${cell.target}"`);
  const adapter = adapterFor(target, REPLAY_KEY);

  if (cell.streaming) {
    const parse = adapter.createStreamParser();
    return (cell.raw as SSEEvent[]).flatMap((event) => parse(event));
  }
  return adapter.parseResponse(cell.raw, LATENCY);
}

describe('recorded provider responses', () => {
  const ids = Object.keys(corpus);

  it('covers every target and every scenario', () => {
    // A corpus that quietly shrinks proves less each time it runs. Anything the
    // recorder could not capture has to be visible here, not absent.
    const missing: string[] = [];
    for (const target of RESPONSE_TARGETS) {
      for (const scenario of RESPONSE_SCENARIOS) {
        const id = cellId(target.key, scenario.name);
        if (!corpus[id]) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
    expect(ids.length).toBe(RESPONSE_TARGETS.length * RESPONSE_SCENARIOS.length);
  });

  it('carries no credential', () => {
    // Response bodies should never echo a key back, but the corpus is committed
    // and a recording is only as safe as what the provider chose to include.
    const text = JSON.stringify(corpus);
    for (const pattern of [/sk-[a-zA-Z0-9]{20}/, /sk-or-v1-[a-zA-Z0-9]{16}/, /AIza[0-9A-Za-z_-]{20}/]) {
      expect(text).not.toMatch(pattern);
    }
  });

  for (const id of Object.keys(corpus)) {
    const cell = corpus[id] as ResponseCell;

    it(`${id} parses to the same result`, () => {
      expect(JSON.parse(JSON.stringify(replay(cell)))).toEqual(cell.parsed as never);
    });
  }

  it('every non-streaming cell yields usage and a finish reason', () => {
    // The two fields whose silent loss costs money and breaks agent loops, checked
    // across every provider at once rather than one adapter test at a time.
    const withoutUsage: string[] = [];
    const withoutFinish: string[] = [];
    for (const [id, cell] of Object.entries(corpus)) {
      if (cell.streaming) continue;
      const parsed = cell.parsed as { usage?: { inputTokens?: number }; finishReason?: string };
      if (!parsed.usage || typeof parsed.usage.inputTokens !== 'number') withoutUsage.push(id);
      if (!parsed.finishReason) withoutFinish.push(id);
    }
    expect(withoutUsage).toEqual([]);
    expect(withoutFinish).toEqual([]);
  });

  it('every streaming cell produces at least one text delta and one terminal event', () => {
    const broken: string[] = [];
    for (const [id, cell] of Object.entries(corpus)) {
      if (!cell.streaming) continue;
      const events = cell.parsed as Array<{ type?: string }>;
      const kinds = new Set(events.map((e) => e.type));
      // `stream.tools` may legitimately emit no text — a model that only calls a
      // tool says nothing — so the terminal event is what every stream must have.
      const terminal = [...kinds].some((k) => k === 'done' || k === 'finish' || k === 'error');
      if (!terminal) broken.push(`${id} (kinds: ${[...kinds].join(', ')})`);
    }
    expect(broken).toEqual([]);
  });
});
