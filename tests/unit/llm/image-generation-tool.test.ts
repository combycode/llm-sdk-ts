/** The `image_generation` builtin, and the label on what comes back.
 *
 *  The row that led here asked whether xAI's server-side image tool needed its
 *  own parsing. Measured on REST on 2026-10-01 it does not: xAI's output item is
 *  OpenAI's `image_generation_call`, same keys, `result` as base64 — not the
 *  `{__type: 'image_generation_result'}` envelope its gRPC surface uses. So the
 *  tool was working on both providers already.
 *
 *  Two things were wrong anyway, and neither is what the row was looking for.
 *
 *  **The catalog said no.** `image_generation` was in no provider's builtin list
 *  — including OpenAI's, where the tool has worked all along — so
 *  `supportsBuiltinTool(..., 'image_generation')` answered `false` about a tool
 *  that works, and a caller gating on the catalog refused itself.
 *
 *  **The mime was a guess.** The parser read `output_format` and defaulted to PNG.
 *  OpenAI reports the format (accurately: asking for jpeg returns JPEG bytes).
 *  xAI reports NONE and returns JPEG — so every xAI image came back labeled
 *  `image/png` with JPEG inside it. A caller writing the file gets the wrong
 *  extension, and a strict validator downstream (Google Veo compares the declared
 *  mime against the bytes) answers 400. The same correction already existed one
 *  layer over for xAI's image API; this path had been left out of it.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { PROVIDER_BUILTIN_TOOLS } from '../../../src/catalog/builtin-tools';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { ImageOutputPart } from '../../../src/llm/types/messages';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });

/** Base64 of the leading magic bytes, padded so a slice(0,16) decodes. */
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString(
  'base64',
);

function imageOf(item: Record<string, unknown>): ImageOutputPart | undefined {
  const res = adapter.parseResponse({ id: 'resp_1', output: [item], usage: {} }, 1);
  return res.content.find((p) => p.type === 'image_output') as ImageOutputPart | undefined;
}

describe('the mime on a generated image', () => {
  it("takes the provider's word when it gives one", () => {
    // OpenAI reports `output_format`, and reports it accurately.
    expect(
      imageOf({ type: 'image_generation_call', output_format: 'jpeg', result: PNG_B64 })?.mimeType,
    ).toBe('image/jpeg');
    expect(
      imageOf({ type: 'image_generation_call', output_format: 'webp', result: PNG_B64 })?.mimeType,
    ).toBe('image/webp');
    expect(
      imageOf({ type: 'image_generation_call', output_format: 'png', result: PNG_B64 })?.mimeType,
    ).toBe('image/png');
  });

  it('reads the BYTES when the provider says nothing — the xAI case', () => {
    // Measured 2026-10-01: xAI's item is `[id, type, status, result, prompt]`,
    // no `output_format`, and the bytes are JPEG. This was the mislabel.
    expect(imageOf({ type: 'image_generation_call', result: JPEG_B64 })?.mimeType).toBe(
      'image/jpeg',
    );
  });

  it('still answers PNG when the bytes say nothing either', () => {
    // A format we do not recognise should not become a confident wrong answer in
    // the other direction; PNG remains the fallback it always was.
    const unknown = Buffer.from([0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0]).toString('base64');
    expect(imageOf({ type: 'image_generation_call', result: unknown })?.mimeType).toBe('image/png');
  });

  it('agrees with the bytes rather than with a provider that contradicts them', () => {
    // Deliberate: the declared format wins. A provider that says jpeg and sends
    // PNG is a provider bug, and second-guessing a provider that DID answer would
    // make the behaviour depend on which of two wrong things we trust. Only
    // silence is filled in.
    expect(
      imageOf({ type: 'image_generation_call', output_format: 'png', result: JPEG_B64 })?.mimeType,
    ).toBe('image/png');
  });

  it('produces no part at all without data', () => {
    expect(imageOf({ type: 'image_generation_call', status: 'in_progress' })).toBeUndefined();
  });
});

describe('what the catalog says about the tool', () => {
  // The REAL shipped catalog; a bare instance indexes nothing.
  const catalog = ModelCatalog.withProviderDefaults();

  it('reports it supported on the providers it was measured on', () => {
    // Measured through the library on 2026-10-01: each of these returned an image
    // on `response.media`.
    for (const [provider, model] of [
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-5.4-nano'],
      ['xai', 'grok-4.6'],
      ['xai', 'grok-4.5'],
      ['xai', 'grok-4.3'],
    ] as const) {
      expect(catalog.supportsBuiltinTool(provider, model, 'image_generation')).toBe(true);
    }
  });

  it('does NOT claim it where it was not measured', () => {
    // Anthropic and Google have no such hosted tool, and an unchecked `true` here
    // would be a capability claim nobody made.
    expect(PROVIDER_BUILTIN_TOOLS.anthropic).not.toContain('image_generation');
    expect(PROVIDER_BUILTIN_TOOLS.google).not.toContain('image_generation');
    expect(PROVIDER_BUILTIN_TOOLS.openrouter).not.toContain('image_generation');
  });

  it('leaves the tools that were already listed alone', () => {
    // The regression that would be easy to miss while editing a shared list.
    expect(catalog.supportsBuiltinTool('xai', 'grok-4.6', 'web_search')).toBe(true);
    expect(catalog.supportsBuiltinTool('xai', 'grok-4.6', 'code_interpreter')).toBe(true);
    expect(catalog.supportsBuiltinTool('xai', 'grok-4.6', 'web_fetch')).toBe(false);
  });
});

describe("the tool's params reach the wire as the provider wants them", () => {
  it('spreads them as siblings of `type`, not nested', () => {
    // xAI reads `action` beside `type`. Nested under a `params` key it would be an
    // unknown field, and `action` would be silently absent rather than refused.
    const req = {
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'draw a circle' }],
      tools: [{ type: 'image_generation', params: { action: 'generate' } }],
    } as unknown as NormalizedRequest;
    const tools = (adapter.buildRequest(req).body as { tools: Array<Record<string, unknown>> })
      .tools;
    expect(tools[0]).toEqual({ type: 'image_generation', action: 'generate' });
  });

  it('sends the bare tool when no params are given', () => {
    const req = {
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'draw a circle' }],
      tools: [{ type: 'image_generation' }],
    } as unknown as NormalizedRequest;
    const tools = (adapter.buildRequest(req).body as { tools: Array<Record<string, unknown>> })
      .tools;
    expect(tools[0]).toEqual({ type: 'image_generation' });
  });
});
