# Tokens + Embeddings -- countTokens / embed / transcribe

This group covers the three "non-chat" LLM capabilities: counting tokens (for
context management and cost estimation), producing embedding vectors, and
transcribing speech to text.

## When to reach for this

- You want to know how many tokens a prompt will consume before sending it
  (`countTokens`).
- You need embedding vectors for semantic search, similarity ranking, or
  clustering (`embed`).
- You need to convert an audio file or stream to text (`transcribe`).

## Main exports

| Export | What it does |
|---|---|
| `countTokens(opts)` | Count the tokens in a string or message array. Picks the right counter per model: tiktoken for OpenAI, count-API for Anthropic/Google, heuristic otherwise. |
| `embed(opts)` | Produce embedding vectors from a string or string array. Works with OpenAI, Google, and OpenRouter. Returns `{ embeddings, dimensions, usage }`. |
| `transcribe(opts)` | Speech-to-text. OpenAI routes to `/v1/audio/transcriptions`; Google uses a chat-style completion internally. Returns `{ text }`, plus `segments` / `words` / `languages` / `durationSeconds` when the model produces them. |
| `HybridTokenCounter` | Low-level token counter that tries tiktoken, falls back to count-API, then heuristic. Used by `countTokens` and `estimate()` internally. |
| `HeuristicCounter` / `TiktokenCounter` / `CountApiCounter` | Individual counters for custom wiring. |

## Exact OpenAI counting needs `tiktoken` (optional peer dependency)

The SDK has **zero required runtime dependencies**. Exact OpenAI tokenization is the one feature
that needs an extra package, and it is an **optional peer dependency** -- not installed unless you
ask for it:

```bash
npm i tiktoken     # only if you want exact OpenAI token counts locally
```

Without it everything still works: `countTokens` uses the count-API strategy for Anthropic/Google
and the calibrated heuristic elsewhere. Only the `tiktoken` strategy needs the package, and if it is
reached without being installed the error says so and names the alternatives.

**Why a peer and not an optional dependency.** `optionalDependencies` means *"do not fail the
install if this package fails to build"* -- npm installs it anyway. So every consumer received
tiktoken's ~5.6 MB wasm file, and bundlers emitted it into production builds even when local
counting was never used; one consumer found it was 88% of their shipped output. As an optional peer,
nobody pays for a feature they did not ask for.

It works in the **browser** too when you do install it -- tiktoken ships a wasm/ESM build that
bundlers resolve for browser targets. Nothing here is Node-only.

## Minimal examples

### Count tokens

```ts
import { countTokens } from '@combycode/llm-sdk';

const n = await countTokens({
  model: 'openai/gpt-5.4-nano',
  apiKey: process.env.OPENAI_API_KEY,
  input: 'The quick brown fox jumps over the lazy dog.',
});
console.log(`Token count: ${n}`);
```

### Embeddings

```ts
import { embed } from '@combycode/llm-sdk';

const { embeddings, dimensions } = await embed({
  model: 'openai/text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY,
  input: ['hello world', 'foo bar'],
});
console.log(`${embeddings.length} embeddings, ${dimensions} dimensions each`);
```

### Transcription (speech-to-text)

```ts
import { transcribe } from '@combycode/llm-sdk';

const { text } = await transcribe({
  model: 'openai/gpt-4o-transcribe',
  apiKey: process.env.OPENAI_API_KEY,
  audio: './recording.wav', // file path, URL, or Uint8Array
});
console.log(text);
```

### Structured transcription

`text` is the only field you always get. Everything else -- `segments`, `words`,
detected `languages`, `durationSeconds` -- appears when the model you chose produces it,
so code written against `text` never breaks when you switch models.

```ts
// Spelling control: keywords steer names and jargon the model would otherwise guess at.
const named = await transcribe({
  model: 'openai/gpt-transcribe',
  audio: './standup.wav',
  keywords: ['Zylberquist', 'Praxil'],   // "Zalbrequist" -> "Zylberquist"
  languages: ['en', 'de'],               // candidates, when the language is unknown
});
console.log(named.languages);            // [{ code: 'en' }]

// Word-level timings (and segments).
const timed = await transcribe({
  model: 'openai/whisper-1',
  audio: './standup.wav',
  wordTimestamps: true,
});
console.log(timed.words?.[0]);           // { word: 'Hello', start: 0, end: 0.72 }

// Speaker labels.
const meeting = await transcribe({
  model: 'openai/gpt-4o-transcribe-diarize',
  audio: './standup.wav',
  diarization: true,
});
for (const s of meeting.segments ?? []) {
  console.log(`[${s.speaker}] ${s.start.toFixed(1)}s ${s.text}`);
}
```

**Which model does what.** These capabilities live on different models, and asking the
wrong one is an error from the provider rather than a silent downgrade -- you always find
out that you did not get what you asked for:

| | `gpt-transcribe` | `gpt-4o-transcribe` | `whisper-1` | `gpt-4o-transcribe-diarize` |
|---|---|---|---|---|
| `keywords` / `languages` | yes | -- | -- | -- |
| detected `languages` | always | -- | -- | -- |
| `wordTimestamps` (`words` + `segments`) | -- | -- | yes | -- |
| `diarization` (`segments` with `speaker`) | -- | -- | -- | yes |
| `language` (single, known) | -- | yes | yes | yes |

No model returns speakers *and* word timings, so `wordTimestamps` and `diarization`
cannot be combined -- that throws before any request is sent.

**Google** returns plain text only. Its transcription config is accepted by the Developer
API and then ignored -- a request carrying it comes back byte-identical to one without
(verified with a two-speaker round-trip). Asking for structure on a Google model emits an
`onWarning` (`transcription_option_unsupported`) so the missing speakers are visible
rather than quietly absent.

## Related

- [Cost tracking + estimate()](./cost.md)
- [LLM Client + complete/stream](./llm-client.md)
- [Media / files / batch](./media-files-batch.md)
