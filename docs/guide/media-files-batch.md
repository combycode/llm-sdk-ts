# Media / Files / Batch -- createMediaOutput / batch / realtime

This group covers capabilities that go beyond text: generating images, audio, and
video; uploading files for grounding; running requests as asynchronous provider
batches; and opening a real-time audio/text session.

## When to reach for this

- You need to generate an image, produce audio (TTS), or generate a video.
- You need to attach a local file (PDF, image, audio) to a completion request.
- You want to submit a large set of requests at provider-batch rates (cheaper,
  asynchronous, results available within hours).
- You need a low-latency bidirectional audio session (OpenAI Realtime or Google
  Gemini Live).

## Main exports

| Export | What it does |
|---|---|
| `createMediaOutput(opts)` | Build a media handle for image/audio/video generation. `.generateImage()`, `.editImage()`, `.generateAudio()`, `.generateVideo()` (text/image-to-video, plus `sourceVideo` + `params.videoMode` to extend/edit on capable providers). Saves results to a local directory. |
| `transcribe(opts)` | Speech-to-text (covered in [Tokens + embeddings](./tokens-embeddings.md) as well). |
| `batch(opts)` | One-shot auto batch: submit + poll + return results. Each request mirrors `complete()` options. Supported providers: openai, anthropic, google. |
| `submitBatch(opts)` | Submit only -- returns a `BatchJob` handle for manual polling. Supported providers: openai, anthropic, google. |
| `batchJob(ref)` | Reconstruct a `BatchJob` from a previously persisted `{ id, provider }`. |
| `createRealtime(opts)` | Open a real-time session (WebSocket). Returns a `RealtimeSession` with event emitter API (`open`, `text`, `audio`, `turnComplete`, `error`, `close`). |
| `loadContent(source)` | Load a URL string, file path, or `Uint8Array` bytes into a `ContentPart` (image, PDF, audio, video -- MIME-sniffed). |

Type-only exports: `BatchJob`, `BatchItemResult`, `BatchRequestInput`,
`MediaResult`, `MediaMeta`, `RealtimeSession`, `RealtimeEvent`, `LoadImageOptions`.

## Minimal examples

### Image generation

```ts
import { createMediaOutput } from '@combycode/llm-sdk';

const media = createMediaOutput({
  model: 'openai/gpt-image-2',
  apiKey: process.env.OPENAI_API_KEY,
  dir: './.media-out',
});

const [img] = await media.generateImage({
  prompt: 'a red circle on a white background',
  params: { size: '1024x1024' },
});
console.log(`Saved ${img?.id} (${img?.meta.size} bytes)`);
```

### Text-to-speech (TTS)

```ts
import { createMediaOutput } from '@combycode/llm-sdk';

const media = createMediaOutput({
  model: 'openai/gpt-audio-1.5',
  apiKey: process.env.OPENAI_API_KEY,
  dir: './.media-out',
});

const audio = await media.generateAudio({
  input: 'Hello, world.',
  params: { voice: 'alloy', format: 'wav' },
});
console.log(`Audio bytes: ${audio?.meta.size}`);
```

### Video generation (+ extend / edit)

`generateVideo()` is async (submit -> poll -> download). Text-to-video by default;
pass a first-frame `sourceImage` for image-to-video. Providers that support it (xAI
`grok-imagine-video`) also take a **`sourceVideo`** to continue or modify an existing
clip, chosen via `params.videoMode`:

- `videoMode: 'extend'` -- continue the clip from its last frame (`/v1/videos/extensions`).
- `videoMode: 'edit'` -- modify the clip per the prompt (`/v1/videos/edits`).

Gate this on the model's `capabilities.videoExtension` -- only extension-capable
models accept a `sourceVideo`.

```ts
const media = createMediaOutput({
  model: 'xai/grok-imagine-video',
  apiKey: process.env.XAI_API_KEY,
  dir: './.media-out',
});

// image-to-video (first frame)
const vid = await media.generateVideo({
  prompt: 'the boat drifts forward',
  sourceImage: { type: 'path', mimeType: 'image/png', path: './frame.png' },
  params: { duration: 4 },
});

// extend an existing clip (continue from its last frame)
const longer = await media.generateVideo({
  prompt: 'the camera slowly pulls back',
  sourceVideo: { type: 'url', url: vid.meta.sourceUrl! }, // URL, file id, or base64
  params: { videoMode: 'extend', duration: 4 },
});
```

Notes:

- **Source input.** The `sourceVideo` (and `sourceImage`) may be a URL, a provider
  file id, or inline base64 -- whatever the target provider accepts. xAI takes a
  public URL or a base64 data URL, so its server fetches the clip for you (no local
  download needed).
- **`meta.sourceUrl`.** Async video results carry the provider-hosted URL. In the
  browser a cross-origin bucket blocks a programmatic byte-fetch (CORS), so the
  adapter returns the URL with empty bytes -- render it with `<video src>`
  (cross-origin playback needs no CORS) or re-submit it as a `sourceVideo`. In
  Node/Bun the bytes are downloaded as usual.
- **Progress.** Subscribe to the `onMediaProgress` hook for a 0-100 progress signal
  while a video generates -- see [Telemetry + hooks](./telemetry.md).

### File attachment in a completion

Files are attached via the `attachments` option on `complete()`. The SDK handles
uploading to the provider's File API when required (OpenAI/Anthropic), or inlining
as base64 (Google).

```ts
import { complete } from '@combycode/llm-sdk';

const { text } = await complete({
  model: 'openai/gpt-5.4-nano',
  apiKey: process.env.OPENAI_API_KEY,
  prompt: 'What word is in this file? Reply with just the word.',
  attachments: ['./banana.txt'],
  maxTokens: 32,
});
console.log(text);
```

### Batch -- auto mode

```ts
import { batch } from '@combycode/llm-sdk';

const results = await batch({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  requests: [
    { customId: 'a', prompt: 'Say apple.', maxTokens: 16 },
    { customId: 'b', prompt: 'Say banana.', maxTokens: 16 },
  ],
});

for (const r of results) {
  console.log(`${r.customId}: ${r.success ? r.text : r.error}`);
}
```

### Batch -- manual mode (persist the job id, resume later)

```ts
import { submitBatch, batchJob } from '@combycode/llm-sdk';

// Submit and save the id.
const job = await submitBatch({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  requests: [{ customId: 'a', prompt: 'Say apple.', maxTokens: 16 }],
});
console.log(`Batch id: ${job.id}`);

// Later -- reconstruct from persisted id.
const resumed = batchJob({ id: job.id, provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY });
const status = await resumed.status();
if (status.status === 'completed') {
  const results = await resumed.results();
  console.log(results[0].text);
}
```

### Real-time session

```ts
import { createRealtime } from '@combycode/llm-sdk';

const session = createRealtime({
  model: 'openai/gpt-realtime-2',
  apiKey: process.env.OPENAI_API_KEY,
  modalities: ['text'],
});

session.on('open', () => session.send({ text: 'Say PING' }));
session.on('text', (e) => process.stdout.write(e.delta));
session.on('turnComplete', () => {
  session.close();
});
```

## Related

- [Tokens + embeddings](./tokens-embeddings.md)
- [LLM Client + complete/stream](./llm-client.md)
- [MCP (Model Context Protocol)](./mcp.md)
