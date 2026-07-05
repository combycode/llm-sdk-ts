---
title: Retrieving Output Files
---

# Retrieving Output Files

Source: `src/llm/files/retrieve.ts` (+ `LLMClient.retrieveFile/streamFile`, `AgentLoop.retrieveFile/streamFile`, `CompleteResult.retrieveFile/streamFile`).

## Purpose and responsibilities

Hosted tools (code execution) produce files that surface on `response.files` as `FileOutput`
descriptors, not bytes. This subsystem resolves a `FileOutput` into actual bytes plus display
metadata (name / mimeType / size), buffered (`retrieveFile` → `Blob`) or streamed
(`streamFile` → `ReadableStream`, for large files piped to a sink without buffering).

It is deliberately **not** a `FileProviderAdapter` concern: that adapter covers upload / delete /
getInfo / list of *input* files. Retrieving *output* file bytes is a distinct, read-only path
that must be bound to the completion's own model + key, so it lives next to the client.

## Design

### One descriptor, three sources

A `FileOutput` carries exactly one of three retrieval shapes, and the resolver branches on which
field is set — the caller never does:

| Field | Provider | Resolution |
|---|---|---|
| `data` (base64) | Google | decoded in-process, no HTTP |
| `url` | OpenAI code-interpreter images | GET that URL |
| `id` (+ `ref.containerId`) | Anthropic, OpenAI container files | GET the provider's files / container-files endpoint |

### RetrieveContext — bound to the call

The public surfaces (`CompleteResult`, `LLMClient`, `AgentLoop`) all delegate to
`retrieveFile(file, ctx)` / `streamFile(file, ctx)` with a `RetrieveContext` built from the
client that made the call: `{ provider, apiKey, fetch, baseURL? }`. This is why the user never
re-passes model or key — the retrieval reuses the exact provider + credentials + engine
(`engine.fetch`, so the queue / retry / cost / trace plumbing still applies).

### Per-provider endpoints

`contentRequest(ctx, file)` builds the authenticated download request:

- **Anthropic** — `GET /v1/files/{id}/content?beta=true` with `x-api-key`, `anthropic-version`,
  `anthropic-beta: files-api-2025-04-14`, `accept: application/binary`.
- **OpenAI / xAI / OpenRouter** — container path `/v1/containers/{containerId}/files/{id}/content`
  when `file.ref.containerId` is set, else `/v1/files/{id}/content`; `Authorization: Bearer`.
- **Google** — `GET /v1beta/files/{id}:download?alt=media` with `x-goog-api-key` (rare; Google
  usually returns inline `data`).

### Auth is same-host only

`providerAuth(ctx, url)` attaches the provider's credentials **only** when the request URL starts
with the provider's base URL. A `url`-form `FileOutput` pointing at a third-party host (e.g. a
CDN) is fetched with no auth header — so keys never leak off the provider's own domain.

### Metadata from the download response

Name / type / size come from the download's response headers, not guessed:

- `mimeType` ← `Content-Type` (split off params), falling back to a filename-extension map
  (`EXT_MIME`), then `application/octet-stream`.
- `name` ← `Content-Disposition` (RFC 5987 `filename*=utf-8''…` preferred over `filename="…"`),
  else `FileOutput.name`.
- `size` ← `blob.size` (buffered) or `Content-Length` (streamed).

### Streaming without buffering

`streamFile` uses the network layer's `responseType: 'stream'`, which returns the raw
`response.body` (`ReadableStream<Uint8Array>`) and releases the queue slot immediately — the
transfer isn't held in memory, and the queue isn't blocked for the whole download. Inline `data`
is wrapped in a single-chunk stream so the streamed path has the same shape for all three sources.

## Invariants

- All HTTP flows through the injected `EngineFetch` — never a bare `fetch`.
- Provider credentials are sent only to the provider's own host.
- Buffered and streamed paths return the same metadata for the same file.

## Related

- Guide: [Retrieving Output Files](../guide/retrieving-files.md)
- [Hosted Code Execution](../guide/code-execution.md) — where the files come from.
- [LLM Client](./llm-client.md) — the `file` StreamEvent + the client these hang off.
