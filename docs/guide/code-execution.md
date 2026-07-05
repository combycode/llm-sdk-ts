---
title: Hosted Code Execution
description: Run the provider's server-side code interpreter through one interface and read its file outputs uniformly from response.files across OpenAI, Anthropic, and Google.
---

# Hosted Code Execution

## What you'll achieve

By the end of this guide you will be able to:

- Enable a provider's **hosted code-execution** tool with one unified tool entry.
- Read code-produced **files** (charts, CSVs, data) uniformly from `response.files`.
- Understand how each provider returns those files, so you can fetch the bytes.

## When and why you need this

Hosted code execution runs a sandboxed Python environment **on the provider's side** and folds
the result back into a single response — no client-side tool loop, no executor to write. Use it
for computation, data wrangling, and generating artifacts (plots, CSVs) from a prompt.

## Enable it — one interface, every provider

Pass the `code_interpreter` builtin. The SDK maps it to each provider's own hosted tool
(OpenAI `code_interpreter`, Anthropic `code_execution`, Google `codeExecution`; xAI inherits the
OpenAI Responses shape):

```ts
import { complete } from '@combycode/llm-sdk';

const { text } = await complete({
  model: 'openai/gpt-5.4-nano',            // or anthropic/… , google/… , xai/…
  apiKey: process.env.OPENAI_API_KEY,
  prompt: 'Compute 12345 * 6789 using code and tell me the result.',
  tools: [{ type: 'code_interpreter' }],
});
// text → "…83,810,205…"
```

That's the whole request surface — the model writes and runs code server-side and returns the
answer in one turn.

## Reading file outputs — `response.files`

When executed code produces files (a matplotlib chart, an exported CSV), they surface uniformly
on `response.files` as `FileOutput[]`, independent of model-generated `media`:

```ts
interface FileOutput {
  id?: string;        // provider file id — fetch bytes via the files API
  name?: string;      // filename, when provided
  mimeType?: string;  // when known
  data?: string;      // inline base64, when returned inline
  url?: string;       // fetchable URL, when returned as one
  source?: string;    // e.g. 'code_execution'
}
```

```ts
const { response } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'With matplotlib, plot y = x**2 for x in 1..5, save it to a PNG file, and return the file.',
  tools: [{ type: 'code_interpreter' }],
  maxTokens: 6000,
});

for (const f of response.files ?? []) {
  // one shape across every provider — see retrieval below
  console.log(f.source, f.id ?? f.url ?? `${(f.data ?? '').length} inline bytes`);
}
```

The same code runs against any provider — you never touch a provider-specific block shape.

## How each provider returns the bytes

`response.files` is unified, but the bytes live in different places per provider. Fetch them by
whichever field is set:

| Provider | Fields set | How to get the bytes |
|---|---|---|
| **Anthropic** | `{ id, source }` | Fetch via the Files API using `id`. |
| **OpenAI** | `{ url, source }` (code-interpreter images) or `{ id, name, source }` (container files) | Fetch `url`, or fetch the container file by `id`. |
| **Google** | `{ data, mimeType, source }` | `data` is base64 — decode it directly. |

## Gotchas and notes

- **Anthropic beta routing is automatic.** Anthropic's code execution is a beta feature and its
  file outputs only return on the beta endpoint — the SDK detects the `code_interpreter` builtin
  and routes the request accordingly. You do nothing.
- **Produce a real file to get a file.** Providers surface a downloadable file only when the code
  writes one (e.g. saving a chart). Code that merely prints a table to stdout yields text, not a
  `FileOutput`. Ask the model to *save/return a file* when you want one.
- **Agent runs carry files through too.** `response.files` propagates through `AgentLoop` /
  `createAgent`, so a code-execution step inside an agent run still surfaces its files on the
  final response.
- **Not all providers have it.** OpenAI, Anthropic, and Google support hosted code execution;
  xAI (via the OpenAI Responses shape) and OpenRouter do not expose a code-execution tool.

## Next steps

- [Tools & built-in tools](./tools.md) — other hosted tools (web search, MCP) and function tools.
- [Media, files & batch](./media-files-batch.md) — model-generated media (`response.media`).
