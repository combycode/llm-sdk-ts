/** Conversation export — render a Message[] conversation as Markdown for
 *  archiving / sharing / debugging. Media parts become Markdown links: an inline
 *  image embeds its data-URL (self-contained, no archive needed); other media
 *  link to their URL or a short placeholder. */

import type { ContentPart, Content, DataSource, Message } from '../llm/types/messages';
import { bytesToBase64 } from '../util/base64';

export interface ConversationExportOptions {
  /** Embed media as data-URL links (self-contained). When false, media is a
   *  short `[image]` placeholder. Default true. */
  inlineMedia?: boolean;
  /** Optional title at the top of the document. */
  title?: string;
}

/** Render a conversation as Markdown. */
export function conversationToMarkdown(
  messages: Message[],
  opts: ConversationExportOptions = {},
): string {
  const inline = opts.inlineMedia ?? true;
  const out: string[] = [];
  if (opts.title) out.push(`# ${opts.title}\n`);

  for (const m of messages) {
    out.push(`## ${m.role}\n`);
    out.push(renderContent(m.content, inline));
    out.push('');
  }
  return out.join('\n').trim()
    .concat('\n');
}

function renderContent(content: Content, inline: boolean): string {
  if (typeof content === 'string') return content;
  return content.map((p) => renderPart(p, inline)).join('\n\n');
}

function renderPart(part: ContentPart, inline: boolean): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'image':
      return inline ? `![image](${sourceUrl(part.source)})` : '[image]';
    case 'audio':
      return inline ? `[audio](${sourceUrl(part.source)})` : '[audio]';
    case 'video':
      return inline ? `[video](${sourceUrl(part.source)})` : '[video]';
    case 'document':
      return inline ? `[document](${sourceUrl(part.source)})` : '[document]';
    case 'image_output':
    case 'audio_output':
    case 'video_output':
      return `[generated ${part.type.replace('_output', '')}: ${part.mediaId}]`;
    case 'tool_call':
      return `\`\`\`tool_call ${part.name}\n${JSON.stringify(part.arguments ?? {}, null, 2)}\n\`\`\``;
    case 'tool_result':
      return `\`\`\`tool_result\n${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}\n\`\`\``;
    default:
      return '';
  }
}

/** DataSource → a URL usable in a Markdown link (data-URL for inline bytes). */
function sourceUrl(src: DataSource): string {
  switch (src.type) {
    case 'url':
      return src.url;
    case 'base64':
      return `data:${src.mimeType};base64,${src.data}`;
    case 'buffer':
      return `data:${src.mimeType};base64,${bytesToBase64(src.data)}`;
    case 'file':
      return `file:${src.fileId}`;
    case 'provider_ref':
      return `ref:${src.refId}`;
    case 'path':
      return src.path;
    default:
      return '';
  }
}
