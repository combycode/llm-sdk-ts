---
title: Retrieving Output Files
description: Fetch the bytes of hosted-tool output files (code-execution charts, CSVs) from response.files with retrieveFile / streamFile — buffered or streamed, with the name / mimeType / size needed to display them as attachments.
---

# Retrieving Output Files

## What you'll achieve

When a hosted tool produces a file — a matplotlib chart, an exported CSV — it surfaces on
`response.files` as a `FileOutput`. This guide shows how to turn that descriptor into actual
bytes plus the metadata (name, MIME type, size) you need to display or store it as an
attachment — either buffered into a `Blob` or streamed straight to a sink.

## When and why you need this

`response.files` gives you a **descriptor**, not the bytes. Depending on the provider it carries
an inline base64 `data`, a `url`, or a provider file `id` — three different retrieval mechanics.
`retrieveFile` / `streamFile` collapse all three into one call, bound to the **same model + key**
the completion already used (no re-passing credentials), and read the real name / type / size
from the download response.

## Two helpers, one descriptor

Both live on every `CompleteResult`, on `LLMClient`, and on `AgentLoop` (so an agent run can
fetch the files it produced with the same call):

```ts
retrieveFile(file) → { blob: Blob;                        name?; mimeType: string; size: number }
streamFile(file)   → { stream: ReadableStream<Uint8Array>; name?; mimeType?;      size? }
```

### Buffered — whole file into memory

Use when the file is small enough to hold at once (charts, small CSVs). You get a `Blob` you can
open, plus the attachment metadata:

```ts
import { complete } from '@combycode/llm-sdk';

const { response, retrieveFile } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'Plot y = x**2 for x in 1..5 with matplotlib, save a PNG, and return the file.',
  tools: [{ type: 'code_interpreter' }],
  maxTokens: 6000,
});

for (const file of response.files ?? []) {
  const { blob, name, mimeType, size } = await retrieveFile(file);
  //   name → 'chart.png'   mimeType → 'image/png'   size → 43940   blob.type is set
  //   browser: const url = URL.createObjectURL(blob);  // <img src={url}> / <a download={name} href={url}>
  //   Node:    await Bun.write(name ?? 'out.bin', blob);
}
```

### Streamed — pipe large files without buffering

When a file could be large (a big dataset export), stream it straight to a file, MongoDB GridFS,
or an HTTP response. Nothing is buffered; the queue slot is released as soon as the transfer
starts. The metadata comes back **alongside** the stream (a `ReadableStream` carries only bytes):

```ts
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';

const { stream, name, mimeType, size } = await streamFile(file);

// Node file sink:
Readable.fromWeb(stream).pipe(createWriteStream(name ?? 'out.bin'));

// MongoDB GridFS:
Readable.fromWeb(stream).pipe(bucket.openUploadStream(name ?? 'out.bin', { contentType: mimeType }));

// HTTP response (e.g. an Express handler):
res.setHeader('Content-Type', mimeType ?? 'application/octet-stream');
if (name) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
Readable.fromWeb(stream).pipe(res);
```

## Where the metadata comes from

`retrieveFile` / `streamFile` read the download's response headers so you can show a proper
attachment:

| Field | Source |
|---|---|
| `mimeType` | `Content-Type` (falls back to the filename extension, then `application/octet-stream`) |
| `name` | `Content-Disposition` (the provider's real filename, e.g. `chart.png`; RFC 5987 `filename*` preferred), else the `FileOutput.name` |
| `size` | `blob.size` (buffered) / `Content-Length` (streamed, when the provider sends it) |

## How each source resolves

You never branch on the provider — the helpers do:

| `FileOutput` carries | Providers | Retrieval |
|---|---|---|
| inline base64 `data` | Google | decoded directly, no HTTP |
| `url` | OpenAI (code-interpreter images) | fetched from that URL |
| `id` (+ `ref.containerId`) | Anthropic, OpenAI (container files) | fetched from the provider's files / container-files endpoint |

**Security:** the provider's credentials are attached **only** when the request targets the
provider's own host — a `url` pointing elsewhere gets no auth header, so keys never leak to a
third-party host.

## Streaming completions

`stream()` has the same file coverage as `complete()`: a `{ type: 'file', file }` event fires as
each file finalizes, and the files are also collected onto the streamed final response. Fetch the
bytes exactly the same way — see [Hosted Code Execution](./code-execution.md#streaming--files-arrive-as-file-events).

## Next steps

- [Hosted Code Execution](./code-execution.md) — produce the files in the first place.
- [LLM Client + complete/stream](./llm-client.md) — the client these helpers hang off.
