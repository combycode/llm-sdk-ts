/** The sources an answer cited, read from four different wire shapes.
 *
 *  `builtinToolCalls` already records what the model INVOKED — that it searched,
 *  and for what. This is the other half: what it ended up CITING. They are not
 *  the same list. A model can run three searches and cite one page, or open a
 *  page and cite nothing, and a caller rendering footnotes needs the second
 *  list, not the first.
 *
 *  Until now this was only reachable by regexing `response.raw`, which is what
 *  the web-search example actually did. That is a per-consumer reimplementation
 *  of provider knowledge that belongs in the SDK.
 *
 *  This function always returns an array. The RESPONSE FIELD it feeds is
 *  optional and omitted when empty, like the `files` / `builtinToolCalls` lines
 *  it sits beside -- R3 forbids adding a required field to a response type, so
 *  the Python port's always-present array is not available here. Callers read
 *  `response.citations ?? []`.
 */

import type { Citation } from '../../types/response';

/** Anthropic: text blocks carry a `citations[]`, with the passage they support. */
function fromAnthropic(raw: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  for (const block of (raw.content as Record<string, unknown>[]) ?? []) {
    for (const cite of (block.citations as Record<string, unknown>[]) ?? []) {
      const url = cite.url as string | undefined;
      if (url) {
        out.push({
          url,
          ...(cite.title ? { title: cite.title as string } : {}),
          // Anthropic is the only provider that reports the cited passage.
          ...(cite.cited_text ? { text: cite.cited_text as string } : {}),
        });
      }
    }
  }
  return out;
}

/** Google: grounding metadata hangs off the candidate, not the parts. */
function fromGoogle(raw: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  for (const candidate of (raw.candidates as Record<string, unknown>[]) ?? []) {
    const grounding = (candidate.groundingMetadata as Record<string, unknown>) ?? {};
    for (const chunk of (grounding.groundingChunks as Record<string, unknown>[]) ?? []) {
      const web = (chunk.web as Record<string, unknown>) ?? {};
      const uri = web.uri as string | undefined;
      if (uri) out.push({ url: uri, ...(web.title ? { title: web.title as string } : {}) });
    }
  }
  return out;
}

/** OpenAI Responses: annotations sit on the output text they annotate. */
function fromResponses(raw: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  for (const item of (raw.output as Record<string, unknown>[]) ?? []) {
    for (const part of (item.content as Record<string, unknown>[]) ?? []) {
      for (const note of (part.annotations as Record<string, unknown>[]) ?? []) {
        // `file_citation` annotations exist too; they are not web sources and
        // carry no URL, so they are skipped rather than emitted URL-less.
        if (note.type === 'url_citation' && note.url) {
          out.push({
            url: note.url as string,
            ...(note.title ? { title: note.title as string } : {}),
          });
        }
      }
    }
  }
  return out;
}

/** Chat completions: OpenAI annotates the message; xAI lists bare URLs at the
 *  top level. BOTH are read — handling only one reports zero citations for the
 *  other provider, which is indistinguishable from a model that never searched. */
function fromCompletions(raw: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  const message =
    (((raw.choices as Record<string, unknown>[]) ?? [])[0]?.message as Record<string, unknown>) ??
    {};
  for (const note of (message.annotations as Record<string, unknown>[]) ?? []) {
    // OpenAI nests the fields under `url_citation`; some gateways flatten them.
    const detail = ((note.url_citation as Record<string, unknown>) ?? note) as Record<
      string,
      unknown
    >;
    if (note.type === 'url_citation' && detail.url) {
      out.push({
        url: detail.url as string,
        ...(detail.title ? { title: detail.title as string } : {}),
      });
    }
  }
  for (const url of (raw.citations as unknown[]) ?? []) {
    if (typeof url === 'string') out.push({ url });
  }
  return out;
}

/** Which reader a surface needs. Keyed by the API rather than the provider:
 *  xAI and OpenRouter serve OpenAI's shapes, and share its readers. */
const READERS: Record<string, (raw: Record<string, unknown>) => Citation[]> = {
  messages: fromAnthropic,
  generate: fromGoogle,
  responses: fromResponses,
  completions: fromCompletions,
  // `interactions` is DELIBERATELY absent. Google's Interactions API returns a
  // `steps[]` machine, not `candidates[]`, so `fromGoogle` would read a key that
  // is never there -- and no recorded Interactions response carries grounding, so
  // there is nothing to write a reader against. Guessing the shape would produce
  // a reader that is confidently wrong and passes a test built from the same
  // guess. The adapter is wired anyway: when the shape is measured, only this
  // table changes.
};

/** Every source the answer cited, or `[]`.
 *
 *  `api` is the wire surface (`'messages' | 'generate' | 'interactions' |
 *  'responses' | 'completions'`). An unknown surface yields `[]` rather than
 *  throwing: a response we cannot read citations from is still a valid answer. */
export function extractCitations(api: string, raw: unknown): Citation[] {
  if (raw == null || typeof raw !== 'object') return [];
  return READERS[api]?.(raw as Record<string, unknown>) ?? [];
}
