/** A tool may answer with content parts rather than a string.
 *
 *  `AgentTool.execute` has always promised `string | ContentPart[]`, but every
 *  adapter used to `JSON.stringify` the array into the provider's text slot. An
 *  image came through as a wall of base64: paid for as text, unreadable as an
 *  image, and often large enough to blow the context on its own.
 *
 *  Each API has a place for this, and they disagree about where:
 *
 *  | API                  | media travels as                                  |
 *  | -------------------- | ------------------------------------------------- |
 *  | Anthropic Messages   | blocks inside `tool_result.content`               |
 *  | OpenAI Responses     | items inside `function_call_output.output`        |
 *  | Google generateContent | `functionResponse.parts[].inlineData`           |
 *  | OpenAI Completions   | nowhere — a tool message is text, so it follows in its own user message |
 *
 *  What they agree on is the split: some of a tool's answer is text for the
 *  result slot, the rest is media. That split is done once, here, so an adapter
 *  only has to say how its API spells the two halves.
 */
import type {
  AudioPart,
  ContentPart,
  DocumentPart,
  ImagePart,
  VideoPart,
} from '../../types/messages';

/** A part that carries bytes rather than characters. */
export type MediaPart = ImagePart | DocumentPart | AudioPart | VideoPart;

function isMedia(part: ContentPart): part is MediaPart {
  return (
    part.type === 'image' ||
    part.type === 'document' ||
    part.type === 'audio' ||
    part.type === 'video'
  );
}

/** Split a tool result into the text half and the media half.
 *
 *  `text` is everything the provider's text slot can carry, already joined;
 *  `media` is the parts that must travel as media, in the order the tool
 *  returned them.
 *
 *  A part that is neither is serialised into the text rather than dropped — a
 *  tool returning something unexpected should reach the model looking odd, not
 *  vanish on the way. */
export function splitToolResult(content: string | ContentPart[]): {
  text: string;
  media: MediaPart[];
} {
  if (typeof content === 'string') return { text: content, media: [] };

  const text: string[] = [];
  const media: MediaPart[] = [];
  for (const part of content) {
    if (part.type === 'text') text.push(part.text);
    else if (isMedia(part)) media.push(part);
    else text.push(JSON.stringify(part));
  }
  return { text: text.join('\n'), media };
}

/** Whether this tool result has anything that must travel as media.
 *
 *  The question every adapter asks first, because the answer decides whether it
 *  can keep taking the cheap path — a plain string result must build exactly the
 *  body it built before this existed. */
export function hasToolResultMedia(content: string | ContentPart[]): boolean {
  return typeof content !== 'string' && content.some(isMedia);
}
