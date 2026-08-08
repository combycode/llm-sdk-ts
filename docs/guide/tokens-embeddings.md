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
| `transcribe(opts)` | Speech-to-text. OpenAI routes to `/v1/audio/transcriptions`; Google uses a chat-style completion internally. Returns `{ text }`. |
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

## Related

- [Cost tracking + estimate()](./cost.md)
- [LLM Client + complete/stream](./llm-client.md)
- [Media / files / batch](./media-files-batch.md)
