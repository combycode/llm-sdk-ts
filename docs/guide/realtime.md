# Realtime (Live) Sessions

`createRealtime()` opens a persistent WebSocket session to a provider's live
API, normalizing the two very different provider protocols (OpenAI's typed
event stream, Google's turn-based bidirectional stream) onto one event model.

**Beta.** Both underlying provider APIs are in beta. Expect breaking changes
from providers independent of this SDK.

## Supported providers

| Provider | Model example | Notes |
|---|---|---|
| `openai` | `gpt-4o-realtime-preview` | Full duplex, text + audio |
| `google` | `gemini-2.0-flash-live` | Turn-based bidirectional, audio-native |

Passing any other provider throws immediately with a clear message.

## `createRealtime(opts)` signature

```ts
createRealtime(opts: CreateRealtimeOptions): RealtimeSession
```

`CreateRealtimeOptions`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | `string` | yes | Bare (`gpt-4o-realtime-preview`) or namespaced (`openai/...`) |
| `provider` | `ProviderName` | when model is bare | Ignored when model is namespaced |
| `apiKey` | `string` | no | Falls back to `engine.apiKeys[provider]` |
| `modalities` | `RealtimeModality[]` | no | `'text'` and/or `'audio'`. Default `['text']` |
| `audio` | `AudioOptions` | no | `{ voice?, format? }` for audio output |
| `voice` | `string` | no | Deprecated; use `audio.voice` |
| `instructions` | `string` | no | System-level instructions for the session |
| `engine` | `EngineHandle` | no | Defaults to the registered engine |

Returns a `RealtimeSession` immediately (synchronous). The underlying WebSocket
connection opens asynchronously; listen for the `'open'` event before sending.

## `RealtimeSession` interface

```ts
interface RealtimeSession {
  send(input: RealtimeInput, opts?: { turnComplete?: boolean }): void;
  on<E extends RealtimeEventType>(type: E, cb: (e: ...) => void): () => void;
  close(): void;
}
```

`RealtimeInput`:

```ts
interface RealtimeInput {
  text?: string;
  audio?: Uint8Array;   // raw audio bytes (provider-specific encoding, e.g. PCM16)
}
```

`send()` defaults to `turnComplete: true` -- commits the turn and requests a
response. Pass `turnComplete: false` to stream a single turn across multiple
`send()` calls (useful for chunked audio).

`on()` returns an unsubscribe function. Call it to stop receiving events of
that type.

## Events

```ts
type RealtimeEvent =
  | { type: 'open' }
  | { type: 'text'; delta: string }
  | { type: 'audio'; chunk: Uint8Array; mimeType: string; sampleRate?: number }
  | { type: 'turnComplete' }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: Error }
  | { type: 'close' };
```

| Event | When |
|---|---|
| `open` | WebSocket connected and session ready |
| `text` | Text delta from the model (stream chunks) |
| `audio` | Audio chunk from the model |
| `turnComplete` | Model finished a response turn |
| `usage` | Token usage reported (fires once per turn; wired into cost pipeline) |
| `error` | Transport or protocol error |
| `close` | Socket closed (normal or abnormal) |

Usage events are automatically forwarded to the `onCompletion` hook so the
`CostCollector` tracks and prices realtime calls alongside regular completions.

## Minimal text example

```ts
import { createEngine, createRealtime } from '@combycode/llm-sdk';

createEngine({ apiKeys: { openai: process.env.OPENAI_API_KEY! } });

const session = createRealtime({
  model: 'openai/gpt-4o-realtime-preview',
  modalities: ['text'],
  instructions: 'You are a helpful assistant.',
});

const unsubText = session.on('text', (e) => {
  process.stdout.write(e.delta);
});

session.on('turnComplete', () => {
  console.log('\n[turn complete]');
  session.close();
});

session.on('open', () => {
  session.send({ text: 'Hello! Tell me a short joke.' });
});

session.on('error', (e) => console.error('Realtime error:', e.error));
session.on('close', () => unsubText());
```

## Audio example (OpenAI)

```ts
import { createEngine, createRealtime } from '@combycode/llm-sdk';

createEngine({ apiKeys: { openai: process.env.OPENAI_API_KEY! } });

const session = createRealtime({
  model: 'openai/gpt-4o-realtime-preview',
  modalities: ['audio', 'text'],
  audio: { voice: 'alloy' },
  instructions: 'Respond concisely.',
});

// Collect audio chunks.
const audioChunks: Uint8Array[] = [];

session.on('audio', (e) => {
  audioChunks.push(e.chunk);
});

session.on('turnComplete', () => {
  console.log(`Got ${audioChunks.length} audio chunks.`);
  // Combine and play / write to file as needed.
  session.close();
});

session.on('open', () => {
  // Send pre-encoded PCM16 audio or a text prompt.
  session.send({ text: 'Say "Hello, world!" in a friendly tone.' });
});
```

## Observability hooks

In addition to the `onCompletion` event (for cost tracking), the network layer
emits three realtime-specific hooks on `engine.hooks`:

| Hook | When |
|---|---|
| `onRealtimeOpen` | Socket connected (`provider`, `model`, `url`) |
| `onRealtimeFrame` | Each frame direction/size (metadata only, no payload) |
| `onRealtimeClose` | Socket closed (`code`, `reason`) |
| `onRealtimeError` | Transport error |

```ts
engine.hooks.on('onRealtimeOpen', (ctx) => {
  console.log(`Realtime connected: ${ctx.provider}/${ctx.model}`);
});
```

## Related

- [Media / Files / Batch](./media-files-batch.md) -- `createRealtime` is also
  listed there alongside other media helpers
- [Observability / Telemetry](./telemetry.md) -- `onCompletion`, realtime hooks
- [Cost Tracking](./cost.md) -- realtime usage is metered through `CostCollector`
