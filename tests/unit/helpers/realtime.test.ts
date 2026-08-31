/** createRealtime() unit tests — in-memory socket, no network, no keys.
 *
 *  `createRealtime` is thin, and every line of it is a decision that is
 *  invisible until it is wrong on a live socket:
 *
 *    - the provider/model split, and the CATALOG TRANSLATION of the slug. This
 *      is the bug the helper was fixed for: realtime was the one path that sent
 *      our own slug to the provider verbatim.
 *    - key resolution, and the order of the two guards (a missing key is
 *      reported before an unsupported provider).
 *    - voice-alias resolution, including which of `audio.voice` / the deprecated
 *      `voice` wins.
 *    - metering: every provider `usage` event is re-emitted as an `onCompletion`
 *      so the CostCollector prices a realtime session like any other call, and a
 *      failing hook must not take the session down with it.
 *
 *  The engine is a stub whose `connect` hands back a fake RealtimeConnection —
 *  no WebSocket is opened and no port is bound. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { CompletionContext } from '../../../src/bus/hook-map';
import type { EngineHandle } from '../../../src/helpers/engine';
import { createRealtime } from '../../../src/helpers/realtime';
import type { RealtimeConnection, WsRequest } from '../../../src/network/types';
import type { Usage } from '../../../src/llm/types/response';

// ─── Fake socket ─────────────────────────────────────────────────────────────

interface FakeSocket {
  conn: RealtimeConnection;
  /** Text frames the session wrote to the wire. */
  sent: string[];
  closed: number;
  /** Drive an inbound lifecycle event or frame. */
  fire(type: 'open' | 'close'): void;
  fire(type: 'message', frame: { text: string }): void;
  fire(type: 'error', err: Error): void;
}

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, Array<(a?: unknown) => void>>();
  const sent: string[] = [];
  const state = { closed: 0 };
  const conn: RealtimeConnection = {
    send: (d) => {
      sent.push(String(d));
    },
    on: ((type: string, cb: (a?: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(cb);
      handlers.set(type, list);
      return () => {};
    }) as RealtimeConnection['on'],
    close: () => {
      state.closed++;
    },
    readyState: 1,
  };
  return {
    conn,
    sent,
    get closed() {
      return state.closed;
    },
    fire: ((type: string, arg?: unknown) => {
      for (const cb of handlers.get(type) ?? []) cb(arg);
    }) as FakeSocket['fire'],
  };
}

// ─── Stub engine ─────────────────────────────────────────────────────────────

interface Rig {
  engine: EngineHandle;
  socket: FakeSocket;
  requests: WsRequest[];
  /** Every (provider, model) pair the helper asked the catalog to translate. */
  translations: Array<[string, string]>;
  completions: CompletionContext[];
}

function makeRig(
  opts: {
    apiKeys?: Record<string, string>;
    /** Catalog translation table, keyed `provider/model`. */
    translate?: Record<string, string>;
    onCompletion?: (ctx: CompletionContext) => void | Promise<void>;
  } = {},
): Rig {
  const socket = fakeSocket();
  const requests: WsRequest[] = [];
  const translations: Array<[string, string]> = [];
  const completions: CompletionContext[] = [];
  const hooks = new HookBus();
  hooks.on('onCompletion', async (ctx) => {
    completions.push(ctx);
    await opts.onCompletion?.(ctx);
  });

  const engine = {
    apiKeys: opts.apiKeys ?? { openai: 'engine-openai-key', google: 'engine-google-key' },
    hooks,
    catalog: {
      resolveModelId: (provider: string, model: string) => {
        translations.push([provider, model]);
        return opts.translate?.[`${provider}/${model}`] ?? model;
      },
    },
    connect: (req: WsRequest) => {
      requests.push(req);
      return socket.conn;
    },
  } as unknown as EngineHandle;

  return { engine, socket, requests, translations, completions };
}

/** OpenAI `response.done` carrying usage — the frame that drives metering. */
function openAiUsageFrame(u: {
  input?: number;
  output?: number;
  total?: number;
  audioIn?: number;
  audioOut?: number;
  cached?: number;
}): { text: string } {
  return {
    text: JSON.stringify({
      type: 'response.done',
      response: {
        usage: {
          input_tokens: u.input ?? 0,
          output_tokens: u.output ?? 0,
          total_tokens: u.total ?? 0,
          input_token_details: { audio_tokens: u.audioIn ?? 0, cached_tokens: u.cached ?? 0 },
          output_token_details: { audio_tokens: u.audioOut ?? 0 },
        },
      },
    }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─── Model + provider resolution ─────────────────────────────────────────────

describe('createRealtime() -- model and provider resolution', () => {
  it('splits a namespaced model into provider + model', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0].provider).toBe('openai');
    expect(rig.translations).toEqual([['openai', 'gpt-realtime']]);
  });

  it('accepts a bare model paired with an explicit provider', async () => {
    const rig = makeRig();
    createRealtime({ model: 'gpt-realtime', provider: 'openai', engine: rig.engine });
    expect(rig.requests[0].provider).toBe('openai');
    expect(rig.translations).toEqual([['openai', 'gpt-realtime']]);
  });

  it('strips a redundant namespace when the provider is also given', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', provider: 'openai', engine: rig.engine });
    expect(rig.translations).toEqual([['openai', 'gpt-realtime']]);
  });

  it('rejects a bare model with no provider, naming the helper', async () => {
    const rig = makeRig();
    expect(() => createRealtime({ model: 'gpt-realtime', engine: rig.engine })).toThrow(
      /createRealtime: bare model "gpt-realtime" requires a provider/,
    );
    expect(rig.requests).toHaveLength(0);
  });
});

// ─── Catalog translation (the regression this helper was fixed for) ──────────

describe('createRealtime() -- catalog translation', () => {
  it('sends the catalog-resolved provider id, not our slug', async () => {
    // The gap: createRealtime parsed the provider but never translated the
    // model, so a realtime session was the one place our own slug reached the
    // provider and 404'd.
    const rig = makeRig({ translate: { 'openai/gpt-realtime': 'gpt-realtime-2025-08-28' } });
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    expect(rig.requests[0].model).toBe('gpt-realtime-2025-08-28');
  });

  it('passes an untranslated id through unchanged', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    expect(rig.requests[0].model).toBe('gpt-realtime');
  });

  it('meters under the translated id too', async () => {
    // A session priced under a slug the catalog does not carry is priced at
    // zero, so the translation has to be the one used in BOTH places.
    const rig = makeRig({ translate: { 'openai/gpt-realtime': 'gpt-realtime-2025-08-28' } });
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire('message', openAiUsageFrame({ input: 10, output: 4, total: 14 }));
    await tick();
    expect(rig.completions).toHaveLength(1);
    expect(rig.completions[0].model).toBe('gpt-realtime-2025-08-28');
    expect(rig.completions[0].response.model).toBe('gpt-realtime-2025-08-28');
  });
});

// ─── API key resolution ──────────────────────────────────────────────────────

describe('createRealtime() -- API key resolution', () => {
  it('falls back to the engine key for the resolved provider', async () => {
    const rig = makeRig({ apiKeys: { openai: 'engine-openai-key' } });
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    // OpenAI carries the key in a WS subprotocol (browsers cannot set headers).
    expect(JSON.stringify(rig.requests[0])).toContain('engine-openai-key');
  });

  it('an explicit apiKey overrides the engine key', async () => {
    const rig = makeRig({ apiKeys: { openai: 'engine-openai-key' } });
    createRealtime({ model: 'openai/gpt-realtime', apiKey: 'caller-key', engine: rig.engine });
    const wire = JSON.stringify(rig.requests[0]);
    expect(wire).toContain('caller-key');
    expect(wire).not.toContain('engine-openai-key');
  });

  it('throws a per-provider message when no key can be found', async () => {
    const rig = makeRig({ apiKeys: {} });
    expect(() => createRealtime({ model: 'google/gemini-live', engine: rig.engine })).toThrow(
      /createRealtime: no API key for provider "google"\. Pass apiKey directly or set engine\.apiKeys\["google"\] via createEngine\./,
    );
  });

  it('does not open a socket when the key is missing', async () => {
    const rig = makeRig({ apiKeys: {} });
    expect(() => createRealtime({ model: 'openai/x', engine: rig.engine })).toThrow(/no API key/);
    expect(rig.requests).toHaveLength(0);
  });

  it('checks the key BEFORE it checks whether the provider has an adapter', async () => {
    // Both are configuration mistakes; reporting the key first would send a
    // caller hunting for credentials for a provider that has no realtime API.
    const rig = makeRig({ apiKeys: {} });
    expect(() => createRealtime({ model: 'anthropic/claude', engine: rig.engine })).toThrow(
      /no API key for provider "anthropic"/,
    );
  });
});

// ─── Adapter selection ───────────────────────────────────────────────────────

describe('createRealtime() -- adapter selection', () => {
  it('openai connects to the OpenAI realtime endpoint', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    expect(rig.requests[0].url).toContain('api.openai.com');
    expect(rig.requests[0].url.startsWith('wss://')).toBe(true);
  });

  it('google connects to the Gemini live endpoint', async () => {
    const rig = makeRig();
    createRealtime({ model: 'google/gemini-live-2.5-flash', engine: rig.engine });
    expect(rig.requests[0].provider).toBe('google');
    expect(rig.requests[0].url).toContain('generativelanguage.googleapis.com');
    expect(rig.requests[0].url.startsWith('wss://')).toBe(true);
  });

  it('a provider with no realtime adapter is rejected, listing the ones that exist', async () => {
    const rig = makeRig({ apiKeys: { anthropic: 'k' } });
    expect(() => createRealtime({ model: 'anthropic/claude', engine: rig.engine })).toThrow(
      /no realtime adapter for provider "anthropic" \(supported: openai, google\)/,
    );
    expect(rig.requests).toHaveLength(0);
  });

  it('rejects xai and openrouter the same way', async () => {
    for (const provider of ['xai', 'openrouter'] as const) {
      const rig = makeRig({ apiKeys: { [provider]: 'k' } });
      expect(() => createRealtime({ model: `${provider}/m`, engine: rig.engine })).toThrow(
        /no realtime adapter/,
      );
    }
  });
});

// ─── Voice resolution ────────────────────────────────────────────────────────

describe('createRealtime() -- voice resolution', () => {
  /** The handshake frame the session writes once the socket opens. */
  function handshake(rig: Rig): Record<string, unknown> {
    rig.socket.fire('open');
    expect(rig.socket.sent.length).toBeGreaterThan(0);
    return JSON.parse(rig.socket.sent[0]) as Record<string, unknown>;
  }

  it('maps a unified alias to the provider voice id', async () => {
    const rig = makeRig();
    createRealtime({
      model: 'openai/gpt-realtime',
      audio: { voice: 'warm' },
      engine: rig.engine,
    });
    expect(JSON.stringify(handshake(rig))).toContain('coral');
  });

  it('maps the same alias to a different id per provider', async () => {
    // 'warm' is coral on OpenAI and Aoede on Google — the alias table is the
    // whole point, and a shared value would be a silent cross-provider bug.
    const rig = makeRig();
    createRealtime({
      model: 'google/gemini-live-2.5-flash',
      audio: { voice: 'warm' },
      engine: rig.engine,
    });
    expect(JSON.stringify(handshake(rig))).toContain('Aoede');
  });

  it('passes an unrecognised voice id through verbatim', async () => {
    const rig = makeRig();
    createRealtime({
      model: 'openai/gpt-realtime',
      audio: { voice: 'verse' },
      engine: rig.engine,
    });
    expect(JSON.stringify(handshake(rig))).toContain('verse');
  });

  it('still honours the deprecated top-level voice field', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', voice: 'bright', engine: rig.engine });
    expect(JSON.stringify(handshake(rig))).toContain('shimmer');
  });

  it('audio.voice wins over the deprecated voice field', async () => {
    const rig = makeRig();
    createRealtime({
      model: 'openai/gpt-realtime',
      audio: { voice: 'deep' },
      voice: 'bright',
      engine: rig.engine,
    });
    const frame = JSON.stringify(handshake(rig));
    expect(frame).toContain('echo'); // deep
    expect(frame).not.toContain('shimmer'); // bright
  });

  it('sends the instructions and modalities it was given', async () => {
    const rig = makeRig();
    createRealtime({
      model: 'openai/gpt-realtime',
      modalities: ['text', 'audio'],
      instructions: 'be terse',
      engine: rig.engine,
    });
    const frame = JSON.stringify(handshake(rig));
    expect(frame).toContain('be terse');
    expect(frame).toContain('audio');
  });
});

// ─── Metering ────────────────────────────────────────────────────────────────

describe('createRealtime() -- usage metering', () => {
  it('re-emits every provider usage event as an onCompletion', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire('message', openAiUsageFrame({ input: 100, output: 20, total: 120 }));
    rig.socket.fire('message', openAiUsageFrame({ input: 5, output: 1, total: 6 }));
    await tick();
    expect(rig.completions).toHaveLength(2);
    expect(rig.completions[0].response.usage.inputTokens).toBe(100);
    expect(rig.completions[1].response.usage.inputTokens).toBe(5);
  });

  it('carries the provider on the completion context', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire('message', openAiUsageFrame({ input: 1, output: 1, total: 2 }));
    await tick();
    expect(rig.completions[0].provider).toBe('openai');
  });

  it('forwards the usage object untouched, audio tokens included', async () => {
    // Audio and text tokens price at different rates, so a collapsed usage
    // object would misprice every voice session.
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire(
      'message',
      openAiUsageFrame({ input: 40, output: 12, total: 52, audioIn: 30, audioOut: 8, cached: 5 }),
    );
    await tick();
    const usage: Usage = rig.completions[0].response.usage;
    expect(usage.audioInputTokens).toBe(30);
    expect(usage.audioOutputTokens).toBe(8);
    expect(usage.cachedTokens).toBe(5);
    expect(usage.inputTokens).toBe(10); // 40 total - 30 audio
    expect(usage.outputTokens).toBe(4); // 12 total - 8 audio
    // The raw provider usage is kept for evidence.
    expect(rig.completions[0].response.raw).toBe(usage);
  });

  it('synthesises a minimal, honest CompletionResponse around the usage', async () => {
    // The CostCollector only reads usage/model, but the context must be a
    // well-formed CompletionResponse — and it must not invent content.
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire('message', openAiUsageFrame({ input: 1, output: 1, total: 2 }));
    await tick();
    const { response, request } = rig.completions[0];
    expect(response.id).toBe('');
    expect(response.text).toBe('');
    expect(response.content).toEqual([]);
    expect(response.toolCalls).toEqual([]);
    expect(response.media).toEqual([]);
    expect(response.thinking).toBeNull();
    expect(response.finishReason).toBe('stop');
    expect(response.latencyMs).toBe(0);
    expect(request).toEqual({
      estimatedInputTokens: 0,
      inputChars: 0,
      messageCount: 0,
      hasTools: false,
    });
  });

  it('emits nothing for frames that carry no usage', async () => {
    const rig = makeRig();
    createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    rig.socket.fire('open');
    rig.socket.fire('message', { text: JSON.stringify({ type: 'response.done', response: {} }) });
    rig.socket.fire('message', {
      text: JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
    });
    await tick();
    expect(rig.completions).toHaveLength(0);
  });

  it('a throwing onCompletion handler does not break the session', async () => {
    // Metering is a side channel. A broken cost pipeline must never take down
    // a live conversation, and the rejected emit must not escape as an
    // unhandled rejection either.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const rig = makeRig({
        onCompletion: () => {
          throw new Error('cost pipeline exploded');
        },
      });
      const session = createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
      const texts: string[] = [];
      session.on('text', (e) => texts.push(e.delta));

      rig.socket.fire('open');
      rig.socket.fire('message', openAiUsageFrame({ input: 1, output: 1, total: 2 }));
      await tick();
      // The session keeps delivering after the hook blew up.
      rig.socket.fire('message', {
        text: JSON.stringify({ type: 'response.output_text.delta', delta: 'still here' }),
      });
      await tick();
      expect(texts).toEqual(['still here']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ─── The returned session ────────────────────────────────────────────────────

describe('createRealtime() -- the returned session', () => {
  it('returns the adapter session, wired to the fake socket', async () => {
    const rig = makeRig();
    const session = createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    const events: string[] = [];
    session.on('open', () => events.push('open'));
    session.on('close', () => events.push('close'));

    rig.socket.fire('open');
    rig.socket.fire('close');
    expect(events).toEqual(['open', 'close']);
  });

  it('closes the underlying connection', async () => {
    const rig = makeRig();
    const session = createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    session.close();
    expect(rig.socket.closed).toBe(1);
  });

  it('buffers a send made before the socket opened', async () => {
    const rig = makeRig();
    const session = createRealtime({ model: 'openai/gpt-realtime', engine: rig.engine });
    session.send({ text: 'hello' });
    expect(rig.socket.sent).toHaveLength(0); // nothing on the wire yet

    rig.socket.fire('open');
    // handshake frame first, then the buffered turn.
    expect(rig.socket.sent.length).toBeGreaterThan(1);
    expect(rig.socket.sent.join('')).toContain('hello');
  });
});
