/** Live, real-key validation for inline moderation (#4).
 *
 *  Skipped unless OPENAI_API_KEY and GOOGLE_AI_API_KEY are present in the env.
 *  Drive it via the samples key wrapper (see scripts) or set the vars yourself:
 *    bun test tests/live/moderation.live.test.ts
 *
 *  Covers: native (OpenAI, Responses + Chat Completions) and emulated (Google)
 *  across complete() and stream() with all three strategies, plus a flagged path. */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../src/helpers/engine';
import { createLLM } from '../../src/helpers/llm';
import type { EngineHandle } from '../../src/helpers/engine';
import type { StreamEvent } from '../../src/llm/types/stream';

const OAI = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.LIVE_OPENAI_MODEL ?? 'gpt-5.4-nano';

// Emulated path is provider-agnostic; validate it against a real non-OpenAI
// provider. Defaults to Anthropic; override to Google etc. via env. (In this
// environment the Google AI Studio key is invalid, so Anthropic is the default.)
const EMU_PROVIDER = (process.env.LIVE_EMU_PROVIDER ?? 'anthropic') as 'anthropic' | 'google' | 'xai';
const EMU_MODEL = process.env.LIVE_EMU_MODEL ?? 'claude-haiku-4-5';
const EMU_KEY = process.env.LIVE_EMU_API_KEY;

// A standard moderation-test phrase: flags harassment/threatening on input. We
// only ever moderate it — never ask a model to act on it.
const FLAGGABLE = 'I am going to kill you and your entire family.';
const BENIGN = 'Reply with the single word: hello.';

function engine(): EngineHandle {
  return createEngine({ registerAsDefault: false });
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const flaggedOf = (e: unknown): boolean => !!(e as { flagged?: boolean })?.flagged;

describe.skipIf(!OAI)('live moderation — native (OpenAI)', () => {
  it('complete() via Responses API attaches a native report', async () => {
    const eng = engine();
    const llm = createLLM({ engine: eng, provider: 'openai', model: OPENAI_MODEL, apiKey: OAI! });
    const res = await llm.complete(BENIGN, { maxTokens: 256, moderation: {} });
    expect(res.moderation?.source).toBe('native');
    expect(res.moderation?.input).toBeDefined();
    expect(res.moderation?.output).toBeDefined();
    eng.destroy();
  });

  it('complete() via Chat Completions API attaches a native report', async () => {
    const eng = engine();
    const llm = createLLM({
      engine: eng,
      provider: 'openai',
      model: OPENAI_MODEL,
      apiKey: OAI!,
      api: 'completions',
    });
    const res = await llm.complete(BENIGN, { maxTokens: 256, moderation: {} });
    expect(res.moderation?.source).toBe('native');
    eng.destroy();
  });

  it('flags a threatening input natively', async () => {
    const eng = engine();
    const llm = createLLM({ engine: eng, provider: 'openai', model: OPENAI_MODEL, apiKey: OAI! });
    const res = await llm.complete(FLAGGABLE, { maxTokens: 64, moderation: {} });
    expect(flaggedOf(res.moderation?.input)).toBe(true);
    eng.destroy();
  });

  it('stream() runs with moderation requested (native events surfaced if returned)', async () => {
    const eng = engine();
    const llm = createLLM({ engine: eng, provider: 'openai', model: OPENAI_MODEL, apiKey: OAI! });
    const events = await drain(llm.stream(BENIGN, { maxTokens: 256, moderation: {} }));
    for (const ev of events) if (ev.type === 'moderation') expect(ev.source).toBe('native');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    eng.destroy();
  });
});

describe.skipIf(!EMU_KEY || !OAI)(`live moderation — emulated (${EMU_PROVIDER})`, () => {
  const mk = (eng: EngineHandle) =>
    createLLM({ engine: eng, provider: EMU_PROVIDER, model: EMU_MODEL, apiKey: EMU_KEY! });

  it('complete() attaches an emulated report (input + output)', async () => {
    const eng = engine();
    const res = await mk(eng).complete(BENIGN, { maxTokens: 64, moderation: { apiKey: OAI! } });
    expect(res.moderation?.source).toBe('emulated');
    expect(res.moderation?.input).toBeDefined();
    expect(res.moderation?.output).toBeDefined();
    eng.destroy();
  });

  it('flags a threatening input via emulation', async () => {
    const eng = engine();
    const res = await mk(eng).complete(FLAGGABLE, {
      maxTokens: 32,
      moderation: { apiKey: OAI!, output: false },
    });
    expect(flaggedOf(res.moderation?.input)).toBe(true);
    eng.destroy();
  });

  for (const strategy of ['buffer', 'parallel', 'post'] as const) {
    it(`stream() emulated — ${strategy} strategy surfaces moderation events`, async () => {
      const eng = engine();
      const events = await drain(
        mk(eng).stream(BENIGN, {
          maxTokens: 128,
          moderation: { apiKey: OAI!, stream: { strategy, interval: 60 } },
        }),
      );
      const mods = events.filter((e) => e.type === 'moderation');
      expect(mods.length).toBeGreaterThan(0);
      for (const m of mods) expect((m as { source: string }).source).toBe('emulated');
      // input moderation is always emitted first.
      expect((events[0] as { type: string; phase?: string }).type).toBe('moderation');
      expect((events[0] as { phase?: string }).phase).toBe('input');
      if (strategy === 'parallel') {
        // first OUTPUT-side event after the input result should be live text, not held.
        const afterInput = events.slice(1);
        const firstText = afterInput.findIndex((e) => e.type === 'text');
        const firstOutMod = afterInput.findIndex(
          (e) => e.type === 'moderation' && (e as { phase: string }).phase === 'output',
        );
        if (firstOutMod >= 0) expect(firstText).toBeLessThan(firstOutMod);
      }
      eng.destroy();
    });
  }
});
