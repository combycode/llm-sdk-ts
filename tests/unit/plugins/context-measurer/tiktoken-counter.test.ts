/** TiktokenCounter — exact OpenAI tokenization, and the estimate that stands in
 *  for it before an encoder has been loaded.
 *
 *  Two distinct numbers live in this class and they must not be confused:
 *
 *    - `estimate*` is SYNCHRONOUS. It may not await the wasm encoder, so until
 *      a `measure*` call has warmed the cache it falls back to chars/3.8.
 *    - `measure*` is the exact count and always loads the encoder.
 *
 *  A port that made `estimate` load the encoder would turn every token check
 *  into a 5.6 MB wasm import; one that made `measure` fall back to the
 *  heuristic would report an estimate as if it were exact.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import {
  isTiktokenUnavailable,
  TiktokenCounter,
  TIKTOKEN_MISSING,
  tiktokenUnavailableError,
} from '../../../../src/plugins/context-measurer/counter/tiktoken';
import type { Message } from '../../../../src/llm/types/messages';

const gpt4o = { provider: 'openai', model: 'gpt-4o' } as const;
const gpt4 = { provider: 'openai', model: 'gpt-4-turbo' } as const;

/** Loading a tiktoken encoding costs about a second and several MB of wasm, so
 *  every case that needs a warm encoder shares one counter. Cases about the
 *  COLD cache build their own. */
const exact = new TiktokenCounter();

/** A cold encoder is a 5.6 MB wasm import, which does not reliably finish
 *  inside bun's 5s default when the machine is busy -- and it is busy exactly
 *  when the whole gate runs, so this failed there while passing on its own.
 *  The wait is real work, not a flaky assertion, so it gets a real budget. */
const COLD_ENCODER_MS = 30_000;

// Paid once, up front, for every case that wants a warm encoder. Both
// encodings, because the cases below compare o200k against cl100k and a
// half-warmed counter would make the second one pay the load inside its own
// timeout, whichever happened to run first.
beforeAll(async () => {
  await exact.measure('warm', gpt4o);
  await exact.measure('warm', gpt4);
}, COLD_ENCODER_MS);

describe('TiktokenCounter — exact measurement', () => {
  it('measure() counts with the real o200k encoder', async () => {
    expect(await exact.measure('hello world', gpt4o)).toBe(2);
  });

  it('measureMessage() over string content equals measure() of that string', async () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(await exact.measureMessage({ role: 'user', content: text }, gpt4o)).toBe(
      await exact.measure(text, gpt4o),
    );
  });

  it('measureMessage() sums text parts exactly', async () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'hello world' },
      ],
    };
    expect(await exact.measureMessage(msg, gpt4o)).toBe(4);
  });

  it('measureMessage() charges a tool call its name + arguments, plus 4 for the framing', async () => {
    const args = { city: 'Prague' };
    const bare = await exact.measure(`lookup${JSON.stringify(args)}`, gpt4o);
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: args }],
    };
    expect(await exact.measureMessage(msg, gpt4o)).toBe(bare + 4);
  });

  it('measureMessage() counts a string tool result as its text', async () => {
    const msg: Message = {
      role: 'tool',
      content: [{ type: 'tool_result', id: 'c1', content: 'hello world' }],
    };
    expect(await exact.measureMessage(msg, gpt4o)).toBe(2);
  });

  it('measureMessage() counts a structured tool result as its JSON', async () => {
    const parts: Message['content'] = [{ type: 'text', text: 'hello world' }];
    const msg: Message = {
      role: 'tool',
      content: [{ type: 'tool_result', id: 'c1', content: parts }],
    };
    expect(await exact.measureMessage(msg, gpt4o)).toBe(
      await exact.measure(JSON.stringify(parts), gpt4o),
    );
  });

  it('measureMessage() charges any non-text part a flat 250', async () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
        { type: 'text', text: 'hello world' },
      ],
    };
    expect(await exact.measureMessage(msg, gpt4o)).toBe(252);
  });

  it('picks an encoding by model prefix, defaulting to o200k for unknown models', async () => {
    // "ünïcödé" tokenizes differently under cl100k (gpt-4) than o200k (gpt-4o).
    const legacy = await exact.measure('ünïcödé', gpt4);
    const modern = await exact.measure('ünïcödé', gpt4o);
    const unknown = await exact.measure('ünïcödé', {
      provider: 'openai',
      model: 'brand-new-model',
    });
    expect(legacy).not.toBe(modern);
    expect(unknown).toBe(modern);
  });

  it('a missing model in the context still counts, via the default encoding', async () => {
    expect(await exact.measure('hello world')).toBe(2);
  });
});

describe('TiktokenCounter — the synchronous estimate', () => {
  it('estimate() before any encoder is loaded uses the chars/3.8 fallback', () => {
    const cold = new TiktokenCounter();
    // 39 characters: ceil(39 / 3.8) = 11. A 4-chars-per-token fallback would
    // say 10, and the exact tokenizer says something else again.
    expect(cold.estimate('x'.repeat(39), gpt4o)).toBe(11);
  });

  it('estimateMessage() over string content delegates to estimate()', () => {
    const cold = new TiktokenCounter();
    expect(cold.estimateMessage({ role: 'user', content: 'x'.repeat(39) }, gpt4o)).toBe(11);
  });

  // Its own counter, deliberately cold, so it pays the wasm load itself.
  it(
    'measure() warms exactly one encoding, and estimate() then uses it',
    async () => {
      const counter = new TiktokenCounter();
      expect(counter.estimate('hello world', gpt4o)).toBe(3); // ceil(11 / 3.8)

      await counter.measure('warm it up', gpt4o); // loads o200k only

      expect(counter.estimate('hello world', gpt4o)).toBe(2); // the real encoder
      // gpt-4 routes to cl100k, which was never loaded → still the fallback.
      expect(counter.estimate('hello world', gpt4)).toBe(3);
    },
    COLD_ENCODER_MS,
  );

  it('estimateMessage() applies the same per-part rules as measureMessage', async () => {
    const args = { city: 'Prague' };
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'tool_call', id: 'c1', name: 'lookup', arguments: args },
        { type: 'tool_result', id: 'c1', content: 'hello world' },
        { type: 'tool_result', id: 'c2', content: [{ type: 'text', text: 'hello world' }] },
        { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
      ],
    };
    // `exact` already holds a warm o200k encoder, so the two agree exactly.
    expect(exact.estimateMessage(msg, gpt4o)).toBe(await exact.measureMessage(msg, gpt4o));
  });

  it('learn() is inert — an exact tokenizer has nothing to calibrate', () => {
    const cold = new TiktokenCounter();
    cold.learn({
      provider: 'openai',
      model: 'gpt-4o',
      bytesSent: 1000,
      actualTokens: 250,
      timestamp: 0,
    });
    expect(cold.estimate('x'.repeat(39), gpt4o)).toBe(11);
  });
});

describe('the optional peer being ABSENT', () => {
  it('the error names the package, the install command, and the way out', () => {
    const cause = new Error('Cannot find module "tiktoken"');
    const err = tiktokenUnavailableError(cause);
    expect(err.message).toContain('"tiktoken"');
    expect(err.message).toContain('npm i tiktoken');
    expect(err.message).toContain('heuristic');
    expect(err.cause).toBe(cause);
  });

  it('is recognised by a marker, not by its message text', () => {
    const err = tiktokenUnavailableError(new Error('x'));
    expect(isTiktokenUnavailable(err)).toBe(true);
    // Rewording the message must not turn a graceful fallback into a throw.
    err.message = 'something else entirely';
    expect(isTiktokenUnavailable(err)).toBe(true);
    expect((err as unknown as Record<symbol, unknown>)[TIKTOKEN_MISSING]).toBe(true);
  });

  it('any OTHER failure is NOT the missing peer', () => {
    expect(isTiktokenUnavailable(new Error('connection reset'))).toBe(false);
    expect(isTiktokenUnavailable(undefined)).toBe(false);
    expect(isTiktokenUnavailable(null)).toBe(false);
    expect(isTiktokenUnavailable('a string')).toBe(false);
    expect(isTiktokenUnavailable({ [TIKTOKEN_MISSING]: false })).toBe(false);
    expect(isTiktokenUnavailable({ tiktokenMissing: true })).toBe(false);
  });
});
