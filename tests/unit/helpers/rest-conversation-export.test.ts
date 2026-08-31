/** conversationToMarkdown() — the full part/source rendering matrix.
 *
 *  Behaviour pinned here:
 *   - Each part type has a distinct rendering; only `image` gets the `![]()`
 *     embed form, the other media are plain links, so a Markdown reader does
 *     not try to inline a 40MB video.
 *   - `inlineMedia: false` collapses EVERY media part to a bare `[label]`
 *     placeholder and MUST NOT leak the underlying URL or base64 payload —
 *     that is the whole reason the flag exists.
 *   - Generated media (`*_output`) render by mediaId, never by bytes, because
 *     the bytes live in the media store, not in the message.
 *   - Every DataSource variant maps to a specific href form; `buffer` is
 *     base64-encoded on the way out and `base64` is passed through as a
 *     data-URL, so both embedded forms produce a self-contained document.
 *   - An unknown part type and an unknown source type degrade to '' rather
 *     than throwing — an export must never fail on a part it does not know. */

import { describe, expect, it } from 'bun:test';
import { conversationToMarkdown } from '../../../src/helpers/conversation-export';
import type { ContentPart, DataSource, Message } from '../../../src/llm/types/messages';

function md(parts: ContentPart[], inlineMedia = true): string {
  return conversationToMarkdown([{ role: 'user', content: parts }], { inlineMedia });
}

function withSource(type: 'image' | 'audio' | 'video' | 'document', source: DataSource): string {
  return md([{ type, source } as unknown as ContentPart]);
}

const URL_SRC: DataSource = { type: 'url', url: 'https://example.invalid/a.png' };

// ─── Part types ───────────────────────────────────────────────────────────────

describe('conversationToMarkdown — part rendering', () => {
  it('renders text verbatim', () => {
    expect(md([{ type: 'text', text: 'hello **world**' }])).toContain('hello **world**');
  });

  it('renders an image as an embedded Markdown image', () => {
    expect(withSource('image', URL_SRC)).toContain('![image](https://example.invalid/a.png)');
  });

  it('renders audio / video / document as plain links, not embeds', () => {
    expect(withSource('audio', URL_SRC)).toContain('[audio](https://example.invalid/a.png)');
    expect(withSource('video', URL_SRC)).toContain('[video](https://example.invalid/a.png)');
    expect(withSource('document', URL_SRC)).toContain('[document](https://example.invalid/a.png)');
    expect(withSource('audio', URL_SRC)).not.toContain('![');
  });

  it('renders generated media by mediaId', () => {
    expect(md([{ type: 'image_output', mediaId: 'img_1', mimeType: 'image/png' } as ContentPart]))
      .toContain('[generated image: img_1]');
    expect(md([{ type: 'audio_output', mediaId: 'aud_1', mimeType: 'audio/mpeg' } as ContentPart]))
      .toContain('[generated audio: aud_1]');
    expect(md([{ type: 'video_output', mediaId: 'vid_1', mimeType: 'video/mp4' } as ContentPart]))
      .toContain('[generated video: vid_1]');
  });

  it('renders a tool_call as a fenced block naming the tool, with pretty JSON args', () => {
    const out = md([
      { type: 'tool_call', id: 't1', name: 'get_weather', arguments: { city: 'Oslo' } } as ContentPart,
    ]);
    expect(out).toContain('```tool_call get_weather');
    expect(out).toContain('"city": "Oslo"');
  });

  it('renders a tool_call with no arguments as an empty object, not "undefined"', () => {
    const out = md([{ type: 'tool_call', id: 't1', name: 'ping' } as unknown as ContentPart]);
    expect(out).toContain('```tool_call ping\n{}\n```');
  });

  it('renders a string tool_result raw and a structured one as JSON', () => {
    expect(md([{ type: 'tool_result', toolCallId: 't1', content: 'sunny' } as unknown as ContentPart]))
      .toContain('```tool_result\nsunny\n```');
    expect(md([{ type: 'tool_result', toolCallId: 't1', content: { temp: 12 } } as unknown as ContentPart]))
      .toContain('```tool_result\n{"temp":12}\n```');
  });

  it('renders an unknown part type as nothing rather than throwing', () => {
    expect(() => md([{ type: 'something_new' } as unknown as ContentPart])).not.toThrow();
    expect(md([{ type: 'text', text: 'A' }, { type: 'something_new' } as unknown as ContentPart]))
      .toBe('## user\n\nA\n');
  });
});

// ─── inlineMedia: false ───────────────────────────────────────────────────────

describe('conversationToMarkdown — inlineMedia:false', () => {
  // Exact equality, not `toContain`: "[audio](url)" also *contains* "[audio]",
  // so a containment check would pass on a build that still emitted the link.
  it('replaces every media part with a bare placeholder and nothing else', () => {
    for (const type of ['image', 'audio', 'video', 'document'] as const) {
      expect(md([{ type, source: URL_SRC } as unknown as ContentPart], false))
        .toBe(`## user

[${type}]
`);
    }
  });

  it('leaks neither the URL nor the base64 payload', () => {
    const b64: DataSource = { type: 'base64', mimeType: 'image/png', data: 'QUJD' };
    const out = md(
      [
        { type: 'image', source: URL_SRC } as ContentPart,
        { type: 'image', source: b64 } as ContentPart,
      ],
      false,
    );
    expect(out).not.toContain('example.invalid');
    expect(out).not.toContain('QUJD');
  });
});

// ─── DataSource → href ────────────────────────────────────────────────────────

describe('conversationToMarkdown — source URL forms', () => {
  it('url passes through unchanged', () => {
    expect(withSource('image', { type: 'url', url: 'https://a.invalid/x' }))
      .toContain('](https://a.invalid/x)');
  });

  it('base64 becomes a data-URL carrying the declared mime type', () => {
    expect(withSource('image', { type: 'base64', mimeType: 'image/png', data: 'QUJD' }))
      .toContain('](data:image/png;base64,QUJD)');
  });

  it('buffer bytes are base64-encoded into a data-URL', () => {
    // 0x41 0x42 0x43 = "ABC" = "QUJD" in base64.
    const src: DataSource = { type: 'buffer', mimeType: 'image/png', data: new Uint8Array([65, 66, 67]) };
    expect(withSource('image', src)).toContain('](data:image/png;base64,QUJD)');
  });

  it('file / provider_ref keep their opaque id behind a scheme prefix', () => {
    expect(withSource('document', { type: 'file', fileId: 'file-123' })).toContain('](file:file-123)');
    expect(withSource('image', { type: 'provider_ref', mimeType: 'image/png', refId: 'ref-9' }))
      .toContain('](ref:ref-9)');
  });

  it('path renders the local path as-is', () => {
    expect(withSource('image', { type: 'path', mimeType: 'image/png', path: './pics/a.png' }))
      .toContain('](./pics/a.png)');
  });

  it('an unknown source type renders an empty href rather than throwing', () => {
    const src = { type: 'quantum', mimeType: 'image/png' } as unknown as DataSource;
    expect(() => withSource('image', src)).not.toThrow();
    expect(withSource('image', src)).toContain('![image]()');
  });
});

// ─── Document shape ───────────────────────────────────────────────────────────

describe('conversationToMarkdown — document shape', () => {
  it('emits an H1 title only when one is given', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    expect(conversationToMarkdown(messages, { title: 'Session' })).toStartWith('# Session');
    expect(conversationToMarkdown(messages)).toStartWith('## user');
  });

  it('emits one H2 per message, in order, and ends with exactly one newline', () => {
    const out = conversationToMarkdown([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(out).toBe('## user\n\nq\n\n## assistant\n\na\n');
  });

  it('joins multiple parts with a blank line', () => {
    expect(md([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))
      .toContain('one\n\ntwo');
  });
});
