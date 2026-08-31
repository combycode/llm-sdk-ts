/** conversationToZip() — part rendering and the DataSource → bytes/url split.
 *
 *  The existing conversation-zip.test.ts pins the archive container. This file
 *  pins the *content* decisions, which are what a port has to reproduce:
 *   - which part types produce a media file and which produce plain text;
 *   - only `image` uses the `![]()` embed form (the others are plain links,
 *     because a Markdown reader must not try to inline a video);
 *   - which DataSources carry bytes worth extracting (base64, buffer,
 *     data-URL) versus which are merely references that stay as links
 *     (remote url, path, file id, provider ref) — a reference must NOT be
 *     counted as extracted media, since there are no bytes to write;
 *   - an unrecognised source degrades to a `[label]` placeholder and an
 *     unrecognised part type to '', so an export never throws. */

import { describe, expect, it } from 'bun:test';
import { conversationToZip } from '../../../src/helpers/conversation-zip';
import type { ContentPart, DataSource, Message } from '../../../src/llm/types/messages';

function zipOf(parts: ContentPart[]) {
  const messages: Message[] = [{ role: 'user', content: parts }];
  return conversationToZip(messages);
}

function partWith(type: 'image' | 'audio' | 'video' | 'document', source: DataSource): ContentPart {
  return { type, source } as unknown as ContentPart;
}

const BYTES: DataSource = { type: 'buffer', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) };

// ─── Part types ───────────────────────────────────────────────────────────────

describe('conversationToZip — part rendering', () => {
  it('extracts an image as a relative embed link', () => {
    const out = zipOf([partWith('image', BYTES)]);
    expect(out.mediaCount).toBe(1);
    expect(out.markdown).toContain('![image](media/media-001.png)');
  });

  it('extracts audio / video / document as plain links, never as embeds', () => {
    const audio = zipOf([partWith('audio', { type: 'buffer', mimeType: 'audio/mpeg', data: new Uint8Array([1]) })]);
    expect(audio.markdown).toContain('[audio](media/media-001.mp3)');
    expect(audio.markdown).not.toContain('![');

    const video = zipOf([partWith('video', { type: 'buffer', mimeType: 'video/mp4', data: new Uint8Array([1]) })]);
    expect(video.markdown).toContain('[video](media/media-001.mp4)');

    const doc = zipOf([partWith('document', { type: 'buffer', mimeType: 'application/pdf', data: new Uint8Array([1]) })]);
    expect(doc.markdown).toContain('[document](media/media-001.pdf)');
  });

  it('renders generated media by mediaId and extracts nothing', () => {
    const out = zipOf([
      { type: 'image_output', mediaId: 'img_1', mimeType: 'image/png' } as ContentPart,
      { type: 'audio_output', mediaId: 'aud_1', mimeType: 'audio/mpeg' } as ContentPart,
      { type: 'video_output', mediaId: 'vid_1', mimeType: 'video/mp4' } as ContentPart,
    ]);
    expect(out.mediaCount).toBe(0);
    expect(out.markdown).toContain('[generated image: img_1]');
    expect(out.markdown).toContain('[generated audio: aud_1]');
    expect(out.markdown).toContain('[generated video: vid_1]');
  });

  it('renders a tool_call as a fenced block with pretty JSON args (empty object when absent)', () => {
    expect(
      zipOf([{ type: 'tool_call', id: 't', name: 'lookup', arguments: { q: 'x' } } as ContentPart]).markdown,
    ).toContain('```tool_call lookup\n{\n  "q": "x"\n}\n```');
    expect(zipOf([{ type: 'tool_call', id: 't', name: 'ping' } as unknown as ContentPart]).markdown)
      .toContain('```tool_call ping\n{}\n```');
  });

  it('renders a string tool_result raw and a structured one as JSON', () => {
    expect(zipOf([{ type: 'tool_result', toolCallId: 't', content: 'ok' } as unknown as ContentPart]).markdown)
      .toContain('```tool_result\nok\n```');
    expect(
      zipOf([{ type: 'tool_result', toolCallId: 't', content: { a: 1 } } as unknown as ContentPart]).markdown,
    ).toContain('```tool_result\n{"a":1}\n```');
  });

  it('renders an unknown part type as nothing rather than throwing', () => {
    expect(() => zipOf([{ type: 'brand_new' } as unknown as ContentPart])).not.toThrow();
    expect(zipOf([{ type: 'text', text: 'A' }, { type: 'brand_new' } as unknown as ContentPart]).markdown)
      .toBe('## user\n\nA\n');
  });
});

// ─── DataSource → extracted bytes vs. link ────────────────────────────────────

describe('conversationToZip — which sources become files', () => {
  it('base64 and buffer sources are extracted as real files', () => {
    const out = zipOf([
      partWith('image', { type: 'base64', mimeType: 'image/png', data: 'QUJD' }),
      partWith('image', BYTES),
    ]);
    expect(out.mediaCount).toBe(2);
    expect(out.markdown).toContain('media/media-001.png');
    expect(out.markdown).toContain('media/media-002.png');
  });

  it('a path source stays a link and is NOT counted as extracted media', () => {
    const out = zipOf([partWith('image', { type: 'path', mimeType: 'image/png', path: './local/a.png' })]);
    expect(out.mediaCount).toBe(0);
    expect(out.markdown).toContain('![image](./local/a.png)');
  });

  it('a file id becomes a file: link with no bytes written', () => {
    const out = zipOf([partWith('document', { type: 'file', fileId: 'file-77' })]);
    expect(out.mediaCount).toBe(0);
    expect(out.markdown).toContain('[document](file:file-77)');
  });

  it('a provider_ref becomes a ref: link with no bytes written', () => {
    const out = zipOf([partWith('image', { type: 'provider_ref', mimeType: 'image/png', refId: 'ref-5' })]);
    expect(out.mediaCount).toBe(0);
    expect(out.markdown).toContain('![image](ref:ref-5)');
  });

  it('an unrecognised source degrades to a bare [label] placeholder', () => {
    const src = { type: 'hologram', mimeType: 'image/png' } as unknown as DataSource;
    const out = zipOf([partWith('image', src), partWith('audio', src)]);
    expect(out.mediaCount).toBe(0);
    expect(out.markdown).toContain('[image]');
    expect(out.markdown).toContain('[audio]');
    expect(out.markdown).not.toContain('](');
  });
});

// ─── mime → file extension ────────────────────────────────────────────────────

describe('conversationToZip — extension chosen for the extracted file', () => {
  function extOfExtracted(mimeType: string): string {
    const out = zipOf([partWith('image', { type: 'buffer', mimeType, data: new Uint8Array([1]) })]);
    expect(out.mediaCount).toBe(1);
    return out.markdown.slice(out.markdown.lastIndexOf('.') + 1).replace(')', '').trim();
  }

  it('uses the mapped extension for a known mime', () => {
    expect(extOfExtracted('image/jpeg')).toBe('jpg');
  });

  it('ignores mime parameters and case when looking the mime up', () => {
    expect(extOfExtracted('IMAGE/PNG; charset=binary')).toBe('png');
  });

  it('falls back to the SUBTYPE for a mime the table does not know', () => {
    expect(extOfExtracted('image/tiff')).toBe('tiff');
  });

  it('sanitises a subtype that is not plain alphanumerics', () => {
    expect(extOfExtracted('image/svg+xml')).toBe('svgxml');
  });

  it('uses the whole token when the mime has no slash at all', () => {
    expect(extOfExtracted('binary')).toBe('binary');
  });

  it('falls back to "bin" when nothing usable survives sanitising', () => {
    expect(extOfExtracted('image/+-+')).toBe('bin');
  });
});
