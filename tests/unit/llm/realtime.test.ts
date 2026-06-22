/** Realtime session adapters — protocol normalization for OpenAI + Google,
 *  driven through a fake RealtimeConnection (no network). Proves: handshake on
 *  open, send buffering until ready, and provider-frame → normalized-event maps. */

import { describe, expect, it } from 'bun:test';
import { OpenAIRealtimeAdapter } from '../../../src/llm/providers/openai/realtime';
import { GoogleRealtimeAdapter } from '../../../src/llm/providers/google/realtime';
import type {
  EngineConnect,
  RealtimeConnection,
  RealtimeFrame,
  WsRequest,
} from '../../../src/network/types';

/** A drivable fake connection: records sends, lets tests fire lifecycle/messages. */
class FakeConnection implements RealtimeConnection {
  readonly req: WsRequest;
  readyState = 1;
  sent: string[] = [];
  private msgCbs = new Set<(f: RealtimeFrame) => void>();
  private openCbs = new Set<() => void>();
  private closeCbs = new Set<() => void>();
  private errCbs = new Set<(e: Error) => void>();
  closed = false;

  constructor(req: WsRequest) {
    this.req = req;
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : '<binary>');
  }
  on(type: 'message', cb: (f: RealtimeFrame) => void): () => void;
  on(type: 'open' | 'close', cb: () => void): () => void;
  on(type: 'error', cb: (e: Error) => void): () => void;
  on(type: string, cb: unknown): () => void {
    const set =
      type === 'message'
        ? this.msgCbs
        : type === 'open'
          ? this.openCbs
          : type === 'close'
            ? this.closeCbs
            : this.errCbs;
    set.add(cb as never);
    return () => set.delete(cb as never);
  }
  close(): void {
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  // drivers
  fireOpen(): void {
    for (const cb of this.openCbs) cb();
  }
  fireText(text: string): void {
    for (const cb of this.msgCbs) cb({ text });
  }
  fireBinary(text: string): void {
    // Gemini Live delivers JSON as binary frames — exercise that path.
    const bytes = new TextEncoder().encode(text);
    for (const cb of this.msgCbs) cb({ binary: bytes });
  }
  sentJSON(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function fakeConnectFactory(): { connect: EngineConnect; conns: FakeConnection[] } {
  const conns: FakeConnection[] = [];
  const connect: EngineConnect = (req) => {
    const c = new FakeConnection(req);
    conns.push(c);
    return c;
  };
  return { connect, conns };
}

describe('OpenAIRealtimeAdapter — protocol mapping', () => {
  it('builds a wss URL with model + subprotocol auth', () => {
    const { connect, conns } = fakeConnectFactory();
    new OpenAIRealtimeAdapter({ apiKey: 'sk-test' }).connect({ model: 'gpt-realtime' }, connect);
    expect(conns[0].req.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(conns[0].req.protocols).toEqual(['realtime', 'openai-insecure-api-key.sk-test']);
  });

  it('on open: sends session.update and becomes ready (emits open)', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new OpenAIRealtimeAdapter({ apiKey: 'k' }).connect(
      { model: 'm', modalities: ['text'] },
      connect,
    );
    let opened = false;
    session.on('open', () => {
      opened = true;
    });
    conns[0].fireOpen();
    expect(opened).toBe(true);
    const first = conns[0].sentJSON()[0];
    expect(first.type).toBe('session.update');
    expect((first.session as { output_modalities: string[] }).output_modalities).toEqual(['text']);
  });

  it('buffers send() until ready, then flushes item.create + response.create', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new OpenAIRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    session.send({ text: 'Say PING' }); // before open → buffered
    expect(conns[0].sent).toHaveLength(0);
    conns[0].fireOpen();
    const types = conns[0].sentJSON().map((m) => m.type);
    expect(types).toEqual(['session.update', 'conversation.item.create', 'response.create']);
  });

  it('maps output_text.delta → text and response.done → turnComplete', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new OpenAIRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    const events: string[] = [];
    session.on('text', (e) => events.push(`text:${e.delta}`));
    session.on('turnComplete', () => events.push('done'));
    conns[0].fireOpen();
    conns[0].fireText(JSON.stringify({ type: 'response.output_text.delta', delta: 'PI' }));
    conns[0].fireText(JSON.stringify({ type: 'response.output_text.delta', delta: 'NG' }));
    conns[0].fireText(JSON.stringify({ type: 'response.done' }));
    expect(events).toEqual(['text:PI', 'text:NG', 'done']);
  });

  it('emits a usage event from response.done', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new OpenAIRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    let usage: unknown;
    session.on('usage', (e) => {
      usage = e.usage;
    });
    conns[0].fireOpen();
    conns[0].fireText(
      JSON.stringify({
        type: 'response.done',
        response: {
          usage: {
            input_tokens: 30,
            output_tokens: 25,
            total_tokens: 55,
            input_token_details: { text_tokens: 10, audio_tokens: 20, cached_tokens: 2 },
            output_token_details: { text_tokens: 5, audio_tokens: 20 },
          },
        },
      }),
    );
    // Text and audio tokens are split so cost can price each at its own rate.
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 55,
      cachedTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      audioInputTokens: 20,
      audioOutputTokens: 20,
    });
  });
});

describe('GoogleRealtimeAdapter — protocol mapping', () => {
  it('builds the bidi URL with key auth', () => {
    const { connect, conns } = fakeConnectFactory();
    new GoogleRealtimeAdapter({ apiKey: 'gk' }).connect({ model: 'gemini-live' }, connect);
    expect(conns[0].req.url).toContain(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=gk',
    );
  });

  it('on open sends setup (models/ prefix) but is NOT ready until setupComplete', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new GoogleRealtimeAdapter({ apiKey: 'k' }).connect(
      { model: 'gemini-live', modalities: ['audio'] },
      connect,
    );
    let opened = false;
    session.on('open', () => {
      opened = true;
    });
    conns[0].fireOpen();
    const setup = conns[0].sentJSON()[0].setup as {
      model: string;
      generationConfig: { responseModalities: string[] };
    };
    expect(setup.model).toBe('models/gemini-live');
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(opened).toBe(false); // ready only after setupComplete
  });

  it('becomes ready on setupComplete, flushing buffered clientContent', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new GoogleRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    session.send({ text: 'Say PING' });
    conns[0].fireOpen(); // setup sent, still buffering content
    expect(conns[0].sentJSON().some((m) => m.clientContent)).toBe(false);
    conns[0].fireText(JSON.stringify({ setupComplete: {} }));
    const cc = conns[0].sentJSON().find((m) => m.clientContent)?.clientContent as {
      turns: Array<{ parts: Array<{ text: string }> }>;
      turnComplete: boolean;
    };
    expect(cc.turns[0].parts[0].text).toBe('Say PING');
    expect(cc.turnComplete).toBe(true);
  });

  it('decodes BINARY frames (Gemini sends JSON as binary) — setupComplete + content', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new GoogleRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    let opened = false;
    const events: string[] = [];
    session.on('open', () => {
      opened = true;
    });
    session.on('text', (e) => events.push(`text:${e.delta}`));
    session.on('turnComplete', () => events.push('done'));
    conns[0].fireOpen();
    // setupComplete + serverContent arrive as BINARY frames, not text.
    conns[0].fireBinary(JSON.stringify({ setupComplete: {} }));
    expect(opened).toBe(true);
    conns[0].fireBinary(
      JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: 'PONG' }] } } }),
    );
    conns[0].fireBinary(JSON.stringify({ serverContent: { turnComplete: true } }));
    expect(events).toEqual(['text:PONG', 'done']);
  });

  it('maps serverContent text parts → text and turnComplete', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new GoogleRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    const events: string[] = [];
    session.on('text', (e) => events.push(`text:${e.delta}`));
    session.on('turnComplete', () => events.push('done'));
    conns[0].fireOpen();
    conns[0].fireText(JSON.stringify({ setupComplete: {} }));
    conns[0].fireText(
      JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: 'PONG' }] } } }),
    );
    conns[0].fireText(JSON.stringify({ serverContent: { turnComplete: true } }));
    expect(events).toEqual(['text:PONG', 'done']);
  });

  it('emits a usage event from usageMetadata', () => {
    const { connect, conns } = fakeConnectFactory();
    const session = new GoogleRealtimeAdapter({ apiKey: 'k' }).connect({ model: 'm' }, connect);
    let usage: unknown;
    session.on('usage', (e) => {
      usage = e.usage;
    });
    conns[0].fireOpen();
    conns[0].fireText(JSON.stringify({ setupComplete: {} }));
    conns[0].fireText(
      JSON.stringify({
        usageMetadata: { promptTokenCount: 8, responseTokenCount: 3, totalTokenCount: 11 },
        serverContent: { turnComplete: true },
      }),
    );
    expect(usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });
});
