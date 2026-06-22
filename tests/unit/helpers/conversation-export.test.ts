import { describe, expect, it } from 'bun:test';
import { conversationToMarkdown } from '../../../src/helpers/conversation-export';
import type { Message } from '../../../src/llm/types/messages';

describe('conversationToMarkdown', () => {
  it('renders roles + text', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const md = conversationToMarkdown(msgs);
    expect(md).toContain('## user');
    expect(md).toContain('hello');
    expect(md).toContain('## assistant');
    expect(md).toContain('hi there');
  });

  it('embeds image parts as data-URL links when inlineMedia', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'aGk=' } },
        ],
      },
    ];
    const md = conversationToMarkdown(msgs);
    expect(md).toContain('look');
    expect(md).toContain('![image](data:image/png;base64,aGk=)');
  });

  it('inlineMedia:false → placeholders, no data URL', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'aGk=' } }],
      },
    ];
    const md = conversationToMarkdown(msgs, { inlineMedia: false });
    expect(md).toContain('[image]');
    expect(md).not.toContain('data:image');
  });

  it('url sources pass through; title is rendered', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }] },
    ];
    const md = conversationToMarkdown(msgs, { title: 'My chat' });
    expect(md).toContain('# My chat');
    expect(md).toContain('![image](http://x/y.png)');
  });
});
