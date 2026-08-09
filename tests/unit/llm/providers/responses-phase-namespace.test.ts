/** OpenAI Responses: assistant `phase` and tool-output `name` / `namespace` (openai-ts 7.x).
 *
 *  Both were probe-verified on 2026-08-06 — accepted, and with an invalid value rejected, so the
 *  fields are validated by the API rather than tolerated. Both are optional additions (R3): a model
 *  that reports neither behaves exactly as before. */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../../src/llm/providers/openai/responses';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { ContentPart, TextPart } from '../../../../src/llm/types/messages';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });
const req = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model: 'gpt-5.5',
  messages: [],
  ...over,
});
const items = (r: NormalizedRequest) => adapter.buildRequest(r).body.input as Array<Record<string, unknown>>;

// ─── #6 name + namespace on tool outputs ─────────────────────────────────────

describe('function_call_output name / namespace', () => {
  const conversation = (namespace?: string): NormalizedRequest =>
    req({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', id: 'call_1', content: '{"c":21}', ...(namespace ? { namespace } : {}) },
          ] as ContentPart[],
        },
      ],
    });

  it('names the tool that produced the output, taken from the matching call', () => {
    const out = items(conversation()).find((i) => i.type === 'function_call_output');
    expect(out).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"c":21}',
      name: 'get_weather',
    });
  });

  it('round-trips a namespace when one is present', () => {
    const out = items(conversation('crm')).find((i) => i.type === 'function_call_output');
    expect(out?.namespace).toBe('crm');
  });

  it('omits name rather than inventing one when no call matches', () => {
    const orphan = req({
      messages: [{ role: 'tool', content: [{ type: 'tool_result', id: 'unknown', content: 'x' }] }],
    });
    const out = items(orphan).find((i) => i.type === 'function_call_output');
    expect(out).toEqual({ type: 'function_call_output', call_id: 'unknown', output: 'x' });
    expect('name' in (out ?? {})).toBe(false);
  });
});

// ─── #15 assistant phase ─────────────────────────────────────────────────────

describe('assistant phase', () => {
  it('parses phase onto the text parts it belongs to', () => {
    const res = adapter.parseResponse(
      {
        output: [
          { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'thinking…' }] },
          { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'the answer' }] },
        ],
        usage: {},
      },
      10,
    );

    const texts = (res.content as ContentPart[]).filter((p): p is TextPart => p.type === 'text');
    expect(texts.map((t) => [t.text, t.phase])).toEqual([
      ['thinking…', 'commentary'],
      ['the answer', 'final_answer'],
    ]);
  });

  it('leaves `text` as the full concatenation', () => {
    const res = adapter.parseResponse(
      {
        output: [
          { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'a' }] },
          { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'b' }] },
        ],
        usage: {},
      },
      10,
    );
    // Narrowing this to the final answer would silently change what every existing caller reads.
    expect(res.text).toBe('ab');
  });

  it('omits phase entirely for a model that does not report it', () => {
    const res = adapter.parseResponse(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: 'plain' }] }], usage: {} },
      10,
    );
    const [first] = (res.content as ContentPart[]).filter((p): p is TextPart => p.type === 'text');
    expect(first?.text).toBe('plain');
    expect('phase' in (first ?? {})).toBe(false);
  });

  it('re-emits phase, splitting a run when it changes', () => {
    const out = items(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'a', phase: 'commentary' },
              { type: 'text', text: 'b', phase: 'commentary' },
              { type: 'text', text: 'c', phase: 'final_answer' },
            ] as ContentPart[],
          },
        ],
      }),
    ).filter((i) => i.type === 'message');

    // Consecutive same-phase parts share one item; a change of phase starts a new one, so
    // commentary never gets reordered against the answer that follows it.
    expect(out).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'a' },
          { type: 'output_text', text: 'b' },
        ],
        phase: 'commentary',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'c' }],
        phase: 'final_answer',
      },
    ]);
  });

  it('emits no phase field when the parts carry none (unchanged wire for everyone else)', () => {
    const out = items(
      req({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }),
    ).filter((i) => i.type === 'message');
    expect(out).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ]);
  });

  it('stamps phase onto streaming deltas from the item that announced it', () => {
    const parse = adapter.createStreamParser();
    const ev = (o: unknown) => ({ data: JSON.stringify(o) }) as never;

    // The phase arrives once, on the item; the deltas carry only item_id.
    parse(ev({ type: 'response.output_item.added', item_id: 'i1', item: { type: 'message', phase: 'commentary' } }));
    parse(ev({ type: 'response.output_item.added', item_id: 'i2', item: { type: 'message', phase: 'final_answer' } }));

    const a = parse(ev({ type: 'response.output_text.delta', item_id: 'i1', delta: 'narrating' }));
    const b = parse(ev({ type: 'response.output_text.delta', item_id: 'i2', delta: 'answering' }));
    const c = parse(ev({ type: 'response.output_text.delta', item_id: 'unknown', delta: 'plain' }));

    expect(a[0]).toEqual({ type: 'text', text: 'narrating', itemId: 'i1', phase: 'commentary' });
    expect(b[0]).toEqual({ type: 'text', text: 'answering', itemId: 'i2', phase: 'final_answer' });
    // An item that announced no phase stays exactly as before.
    expect(c[0]).toEqual({ type: 'text', text: 'plain', itemId: 'unknown' });
  });

  it('keeps per-stream phase state isolated between parsers', () => {
    const ev = (o: unknown) => ({ data: JSON.stringify(o) }) as never;
    const first = adapter.createStreamParser();
    const second = adapter.createStreamParser();

    first(ev({ type: 'response.output_item.added', item_id: 'i1', item: { type: 'message', phase: 'commentary' } }));
    // The second stream never saw that item, so it must not inherit the phase.
    const out = second(ev({ type: 'response.output_text.delta', item_id: 'i1', delta: 'x' }));
    expect(out[0]).toEqual({ type: 'text', text: 'x', itemId: 'i1' });
  });
});
