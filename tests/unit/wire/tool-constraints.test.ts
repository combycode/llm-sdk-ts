/** A tool the provider refuses beside the attached content is dropped — and said.
 *
 *  Measured 2026-08-25: Google answers 400 "The mime type: video/mp4 is not
 *  supported for code execution" when `code_interpreter` accompanies a PDF or a
 *  video. Images are fine, `web_search` is fine, and OpenAI accepts every
 *  combination — so this is one provider's rule, and it lives in that provider's
 *  spec as data rather than as an `if` in the builder.
 *
 *  Both halves matter. Dropping it makes the request succeed; SAYING so is what
 *  stops a silently missing capability from looking like a working one — the
 *  caller asked for code execution and has to learn they did not get it.
 */
import { describe, expect, it } from 'bun:test';
import { chatSpec } from '../../../src/wire/chat-specs';
import { buildFromSpec } from '../../../src/wire/interpreter';
import { makeRegistry } from '../../../src/llm/wire-transforms';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const K = 'k';
const reg = makeRegistry({
  google: new GoogleAdapter({ apiKey: K }),
  openaiResponses: new OpenAIResponsesAdapter({ apiKey: K }),
});
const spec = chatSpec('google/generate@2.5');

const req = (parts: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) =>
  ({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: [...parts, { type: 'text', text: 'hi' }] }],
    tools,
  }) as unknown as NormalizedRequest;

const PDF = { type: 'document', source: { type: 'base64', mimeType: 'application/pdf', data: 'JVBERi0=' } };
const VIDEO = { type: 'video', source: { type: 'base64', mimeType: 'video/mp4', data: 'AAAA' } };
const IMAGE = { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'iVBOR' } };
const CODE = [{ type: 'code_interpreter' }];
const SEARCH = [{ type: 'web_search' }];

const toolsOf = (body: Record<string, unknown>): string[] =>
  ((body.tools as Array<Record<string, unknown>>) ?? []).flatMap((t) => Object.keys(t));

describe('google drops code execution beside a PDF or video', () => {
  it('sends codeExecution when nothing conflicts', () => {
    const out = buildFromSpec(spec, req([], CODE), reg, 'google');
    expect(toolsOf(out.body)).toContain('codeExecution');
    expect(out.notes ?? []).toEqual([]);
  });

  it('keeps it with an IMAGE — images are not the conflict', () => {
    const out = buildFromSpec(spec, req([IMAGE], CODE), reg, 'google');
    expect(toolsOf(out.body)).toContain('codeExecution');
    expect(out.notes ?? []).toEqual([]);
  });

  for (const [name, part] of [
    ['pdf', PDF],
    ['video', VIDEO],
  ] as const) {
    it(`drops it with a ${name}, and says why`, () => {
      const out = buildFromSpec(spec, req([part], CODE), reg, 'google');
      expect(toolsOf(out.body)).not.toContain('codeExecution');
      expect(out.notes?.length).toBe(1);
      expect(out.notes?.[0]).toContain('code execution');
    });
  }

  it('leaves web search alone — only the constrained tool is affected', () => {
    const out = buildFromSpec(spec, req([VIDEO], [...SEARCH, ...CODE]), reg, 'google');
    const tools = toolsOf(out.body);
    expect(tools).toContain('googleSearch');
    expect(tools).not.toContain('codeExecution');
  });

  it('says it once, not once per matching part', () => {
    const out = buildFromSpec(spec, req([PDF, VIDEO], CODE), reg, 'google');
    expect(out.notes?.length).toBe(1);
  });

  it('applies to gemini 3 as well, by inheritance', () => {
    const out = buildFromSpec(chatSpec('google/generate@3'), req([VIDEO], CODE), reg, 'google');
    expect(toolsOf(out.body)).not.toContain('codeExecution');
    expect(out.notes?.length).toBe(1);
  });
});

describe('other providers are untouched', () => {
  it('openai keeps its code interpreter beside a video', () => {
    // The rule is Google's. A spec without `toolConstraints` behaves exactly as
    // before, which is what keeps this from becoming a rule about video.
    const openai = chatSpec('openai/responses');
    const out = buildFromSpec(
      openai,
      { ...req([VIDEO], CODE), model: 'gpt-5.4-nano' } as NormalizedRequest,
      reg,
      'openai',
    );
    const kinds = ((out.body.tools as Array<Record<string, unknown>>) ?? []).map((t) => t.type);
    expect(kinds).toContain('code_interpreter');
    expect(out.notes ?? []).toEqual([]);
  });
});
