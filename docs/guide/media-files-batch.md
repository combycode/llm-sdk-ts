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

### Image `quality` on xAI

`grok-imagine-image-2.0` takes `params.quality` of `low` or `medium`,
defaulting to `medium` when omitted. The catalog records it on that model
alone, which is what the xAI SDK documents.

Worth knowing why the catalog is narrower than the wire: `quality: "ultra"` is
refused with a 422 on *every* imagine model, because that is the request body
being deserialized before any model dispatch. A 200 on another model therefore
means the schema accepts the field, not that the model honours it -- and xAI
published OpenAPI does not carry `quality` at all, so its silence is not
evidence either. Ask `catalog.get(...)?.mediaParams?.quality` rather than
inferring support from a status code.

### Two retired endpoints, and what happens now

Both were checked live on 2026-09-29, because a deprecation notice in an SDK's types
cannot tell you whether the endpoint still answers:

- **Google Imagen `:predict` is gone from the Developer API** -- `models/imagen-4.0-generate-001:predict`
  returns 404, "not supported for predict", and both Google SDKs deleted their Developer-API
  converters. It was also this library's default image model, so the default Google image path
  was broken. The default is now `gemini-3.1-flash-image`, verified generating an image through
  `generateContent` in the same check. Naming an `imagen*` model explicitly still builds the
  `:predict` request -- an Enterprise (Gemini Enterprise Agent Platform) deployment can reach it,
  and the frozen media corpus records that envelope as the adapter's contract.
- **The OpenAI Sora API shut down on 2026-09-24**, the date its own deprecation notice named;
  `/v1/videos` returns 404. `submitVideo` now raises a typed `unsupported` error saying so,
  instead of returning an empty id that reads as a submitted job. The exported function and the
  public video surface are unchanged -- other providers serve them. Note that `sora-2` and
  `sora-2-pro` are **still listed by `/v1/models`**, so a catalog built from a provider's model
  list will keep reporting a model that nothing serves.

### Video generation (+ extend / edit)

`generateVideo()` is async (submit -> poll -> download). Text-to-video by default;
pass a first-frame `sourceImage` for image-to-video. Providers that support it (xAI
`grok-imagine-video`) also take a **`sourceVideo`** to continue or modify an existing
clip, chosen via `params.videoMode`:

- `videoMode: 'extend'` -- continue the clip from its last frame (`/v1/videos/extensions`).
- `videoMode: 'edit'` -- modify the clip per the prompt (`/v1/videos/edits`).

Gate this on the model's `capabilities.videoExtension` -- only extension-capable
models accept a `sourceVideo`.

### Voices: catalog, custom, and several at once

`params.voice` takes a unified alias (`'warm'`), a provider catalog name (`'Kore'`), or a voice you
own:

```ts
params: { voice: 'warm' }                        // alias -> the provider's name
params: { voice: 'Kore' }                        // the provider's own name
params: { voice: { id: 'voice_011CZk...' } }     // a custom voice you created
```

The object form exists because a custom voice id is not a name anyone could guess — it is issued
when the voice is created. A plain string still means exactly what it always meant, and builds
exactly the request it always built.

**Several voices** need a cast and a script. Both, together:

```ts
await media.generateAudio({
  model: 'google/gemini-3.8-flash-tts',
  input: 'TTS this conversation.',
  params: {
    speakers: [
      { name: 'Ada', voice: 'Kore' },
      { name: 'Grace', voice: { id: 'voice_011CZk...' } },
    ],
    segments: [
      { speaker: 'Ada', text: 'The meeting is Tuesday.', style: 'brisk' },
      { speaker: 'Grace', text: 'I will be there.' },
    ],
  },
});
```

`style` is free text and per segment, so one line can be hesitant and the next certain. A cast wins
over a single `voice` — asking for both is a contradiction, and the cast is the more specific ask.

> Measured 2026-09-30. The two halves are **one feature**: a request carrying the speaker configs
> without a speaker on every text part is refused — *"Multi-speaker generation requests must specify
> speech_metadata.speaker for each text part in the contents."* So both are derived from your
> `segments`, and there is no way to supply one and forget the other. A catalog name goes to
> `prebuiltVoiceConfig.voiceName` exactly as before; a `{ id }` goes to the flat `voiceConfig.voice`,
> which is the field Google validates custom ids against.

**Creating** a custom voice is not part of this library yet. The voices API is reachable, so this is
a design decision rather than a limitation: voice management deserves a provider-neutral resource
rather than one ported from a single vendor's shape, and that design is still open. Bring your own
id and everything above works.

### The audio track

Video models generate sound by default, so the useful thing to say is "don't".

| Param | What it does | Where it lands |
| --- | --- | --- |
| `params.generateAudio` | `false` asks for a **silent** video | xAI `generate_audio`, on `grok-imagine-video` and `-1.5` |
| `params.referenceAudios` | voices to condition the speech on, `[{ voiceId: 'ara' }]`, at most three | xAI `reference_audios`, **`grok-imagine-video-1.5` only** |

`generateAudio` is not sent to Google or OpenAI. The parameter does exist on Veo, but
only in Vertex / Gemini Enterprise mode -- on the Developer API this library speaks,
google-genai throws rather than send it. Sora has no equivalent. On those providers the
video comes back however the provider defaults it.

Voice ids come from xAI's text-to-speech catalog, and custom ids from
`/v1/custom-voices` work too. There is no client-side list: an unknown id is refused
with the whole catalog in the error, which is better than a copy that goes stale.

```ts
// a silent clip
await media.generateVideo({ prompt: 'rain on a window', params: { generateAudio: false } });

// pick the voices, on 1.5
await media.generateVideo({
  model: 'xai/grok-imagine-video-1.5',
  prompt: 'two friends arguing about the weather',
  params: { referenceAudios: [{ voiceId: 'ara' }, { voiceId: 'rex' }] },
});
```

> Measured 2026-09-30. Worth knowing when adding to this: **xAI answers 200 to a request
> carrying a field it has never heard of**, so a successful submission proves nothing
> about whether a parameter was understood. What proves it is a refusal -- a wrongly
> typed `generate_audio` is a `422` naming the expected type, and `reference_audios` on
> the non-1.5 model is a `400` saying it is unsupported there.

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

### Letting an upload expire by itself

Uploaded files do not clean themselves up. OpenAI states that everything except
`purpose=batch` persists until something deletes it, so an agent that attaches a
document per turn grows an unbounded pile on the customer's account. Set
`uploadLifetimeSeconds` and the provider deletes the file for you:

```ts
import { createEngine, FilesRegistry } from '@combycode/llm-sdk';

const engine = createEngine({ catalog: 'defaults' });
const files = new FilesRegistry({
  hooks: engine.hooks,
  catalog: engine.catalog,
  fetch: engine.fetch,
  uploadLifetimeSeconds: 3600,
});
```

Off by default, which is the providers' own default. Anthropic, OpenAI and xAI
each accept a lifetime in a different field shape; the registry handles that.

**Google is the exception, and it is worth knowing before you rely on this.**
Google's `expiration_time` is marked "Output only" -- Google decides, asking
changes nothing, and the file still expires on Google's own schedule (reported
back as `expiresAt`). The adapter says so through `onWarning` with code
`request_adjusted` rather than dropping the request quietly, because a unified
option that silently does nothing on one provider is worse than one that is
honest about where it applies. Deleting the file yourself stays available on
every provider.

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
