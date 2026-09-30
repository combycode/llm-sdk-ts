/** How the model works through a video, and what each surface can be told.
 *
 *  Google offers two ways of reading a video: `agentic`, where the model
 *  navigates and seeks to what it needs, and `static`, a fixed frame rate with
 *  every extracted frame placed in the context window. On a long video the
 *  difference is not stylistic — static sampling is predictably expensive, and
 *  the offsets are how a question about 30 seconds of a two-hour recording
 *  costs what 30 seconds should.
 *
 *  The catch this file exists for: **the two Google surfaces take different
 *  shapes**, and one of them cannot express the interesting half.
 *
 *  - `generateContent` takes `Part.mediaProcessing`, a screaming-snake enum
 *    with exactly two values. No fps, no offsets.
 *  - Interactions takes `processing`, either the bare mode or an object
 *    carrying `fps` / `start_offset` / `end_offset` — snake_case there, while
 *    ours are camelCase.
 *
 *  So the object form is honoured on Interactions and reduced to plain STATIC
 *  on generateContent. Writing one mapper for both would have quietly sent the
 *  fps to a surface that ignores it.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import type { VideoPart } from '../../../src/llm/types/messages';

const generate = new GoogleAdapter({ apiKey: 'k' });
const interactions = new GoogleInteractionsAdapter({ apiKey: 'k' });

const VIDEO: VideoPart = { type: 'video', source: { type: 'url', url: 'https://v.test/clip.mp4' } };

/** The `parts[]` generateContent would receive. */
function genParts(part: unknown) {
  const body = generate.buildRequest({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: [part] }],
  } as never).body as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
  return body.contents[0]?.parts ?? [];
}

/** The input-item content Interactions would receive. */
function interactionParts(part: unknown) {
  const body = interactions.buildRequest({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: [part] }],
  } as never).body as { input: Array<{ content: Array<Record<string, unknown>> }> };
  return body.input[0]?.content ?? [];
}

describe('generateContent — the enum surface', () => {
  it('sends nothing when the caller did not ask', () => {
    expect(genParts(VIDEO)[0]).not.toHaveProperty('mediaProcessing');
  });

  it('maps the modes to the screaming enum', () => {
    expect(genParts({ ...VIDEO, providerOptions: { processing: 'agentic' } })[0]?.mediaProcessing).toBe(
      'AGENTIC',
    );
    expect(genParts({ ...VIDEO, providerOptions: { processing: 'static' } })[0]?.mediaProcessing).toBe(
      'STATIC',
    );
  });

  it('reduces the object form to plain STATIC', () => {
    // The honest outcome: this surface has nowhere to put fps or offsets, so
    // the mode survives and the sampling does not. Asserted so the loss is a
    // decision on the record rather than a surprise.
    const part = genParts({
      ...VIDEO,
      providerOptions: { processing: { type: 'static', fps: 2, startOffset: '10.5s' } },
    })[0];
    expect(part?.mediaProcessing).toBe('STATIC');
    expect(part).not.toHaveProperty('fps');
    expect(part).not.toHaveProperty('start_offset');
  });

  it('keeps the file reference, with a mime type the enum will accept', () => {
    // The uri is untouched. The mime type is NOT `application/octet-stream`
    // here, which Google refuses alongside media_processing -- see the mime
    // block at the bottom of this file for the measurements.
    const part = genParts({ ...VIDEO, providerOptions: { processing: 'agentic' } })[0];
    expect(part?.fileData).toEqual({ fileUri: 'https://v.test/clip.mp4', mimeType: 'video/mp4' });
  });

  it('does not touch an image part', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://i.test/x.png' } };
    expect(genParts(image)[0]).not.toHaveProperty('mediaProcessing');
  });
});

describe('Interactions — the rich surface', () => {
  it('sends nothing when the caller did not ask', () => {
    expect(interactionParts(VIDEO)[0]).toEqual({ type: 'video', uri: 'https://v.test/clip.mp4' });
  });

  it('passes a bare mode through as-is, lowercase', () => {
    expect(interactionParts({ ...VIDEO, providerOptions: { processing: 'agentic' } })[0]?.processing).toBe(
      'agentic',
    );
  });

  it('carries the sampling, renaming the offsets to snake_case', () => {
    // The reason the object form exists at all.
    expect(
      interactionParts({
        ...VIDEO,
        providerOptions: {
          processing: { type: 'static', fps: 2, startOffset: '10.5s', endOffset: '30s' },
        },
      })[0]?.processing,
    ).toEqual({ type: 'static', fps: 2, start_offset: '10.5s', end_offset: '30s' });
  });

  it('omits the parts of the object that were not given', () => {
    // Absent, not null. `fps: null` is a value the server has to reject;
    // leaving it out means "your default".
    expect(
      interactionParts({ ...VIDEO, providerOptions: { processing: { type: 'static' } } })[0]?.processing,
    ).toEqual({ type: 'static' });
  });

  it('keeps fps: 0 rather than treating it as absent', () => {
    // 0 is falsy and would be dropped by a truthiness check. It is also a
    // value the server should get the chance to reject on its own terms.
    expect(
      (
        interactionParts({ ...VIDEO, providerOptions: { processing: { type: 'static', fps: 0 } } })[0]
          ?.processing as Record<string, unknown>
      )?.fps,
    ).toBe(0);
  });

  it('carries a name when one was given', () => {
    const part = interactionParts({ ...VIDEO, providerOptions: { name: 'the interview' } })[0];
    expect(part?.name).toBe('the interview');
    expect(interactionParts({ ...VIDEO, providerOptions: { name: '' } })[0]).not.toHaveProperty('name');
  });
});

describe('the mime type mediaProcessing demands', () => {
  /** Measured 2026-09-30, and the reason this block exists:
   *    no mime at all      -> 400 mime_type must be set when media_processing is specified
   *    application/octet-  -> 400 media_processing can only be set on video parts
   *    video/mp4 + STATIC  -> 200
   *  A `url` or `file` source carries no mime type in this library, so asking
   *  for processing on one would have been a guaranteed 400. */
  it('replaces the octet-stream default on a url source', () => {
    const part = genParts({ ...VIDEO, providerOptions: { processing: 'static' } })[0];
    expect((part?.fileData as { mimeType?: string })?.mimeType).toBe('video/mp4');
  });

  it('supplies one for a file source, which has none at all', () => {
    const part = genParts({
      type: 'video',
      source: { type: 'file', fileId: 'files/abc' },
      providerOptions: { processing: 'static' },
    })[0];
    expect((part?.fileData as { mimeType?: string })?.mimeType).toBe('video/mp4');
  });

  it("keeps a caller's own video mime type", () => {
    const part = genParts({
      type: 'video',
      source: { type: 'provider_ref', mimeType: 'video/webm', refId: 'files/abc' },
      providerOptions: { processing: 'static' },
    })[0];
    expect((part?.fileData as { mimeType?: string })?.mimeType).toBe('video/webm');
  });

  it('fixes an inline video too', () => {
    const part = genParts({
      type: 'video',
      source: { type: 'base64', mimeType: 'application/octet-stream', data: 'AA==' },
      providerOptions: { processing: 'static' },
    })[0];
    expect((part?.inlineData as { mimeType?: string })?.mimeType).toBe('video/mp4');
  });

  it('leaves a video that asked for nothing exactly as it was', () => {
    // The fix is scoped to requests that opted in, so nothing already working
    // changes shape.
    const part = genParts(VIDEO)[0];
    expect((part?.fileData as { mimeType?: string })?.mimeType).toBe('application/octet-stream');
  });
});
