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
| `embed(opts)` | Produce embedding vectors from a string or string array. Works with OpenAI, Google, and OpenRouter. Returns `{ vectors, dimensions, usage }`. |
| `transcribe(opts)` | Speech-to-text. OpenAI routes to `/v1/audio/transcriptions`; Google uses a chat-style completion internally. Returns `{ text, language? }`. |
| `HybridTokenCounter` | Low-level token counter that tries tiktoken, falls back to count-API, then heuristic. Used by `countTokens` and `estimate()` internally. |
| `HeuristicCounter` / `TiktokenCounter` / `CountApiCounter` | Individual counters for custom wiring. |

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

const { vectors, dimensions } = await embed({
  model: 'openai/text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY,
  input: ['hello world', 'foo bar'],
});
console.log(`${vectors.length} vectors, ${dimensions} dimensions each`);
```

### Transcription (speech-to-text)

```ts
import { transcribe } from '@combycode/llm-sdk';

const { text } = await transcribe({
  model: 'openai/gpt-4o-audio-preview',
  apiKey: process.env.OPENAI_API_KEY,
  audio: './recording.wav', // file path, URL, or Uint8Array
});
console.log(text);
```

## Related

- [Cost tracking + estimate()](./cost.md)
- [LLM Client + complete/stream](./llm-client.md)
- [Media / files / batch](./media-files-batch.md)
