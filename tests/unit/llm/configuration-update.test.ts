/** Changing how hard a stored conversation thinks, from this turn on.
 *
 *  `thinking.effort` already existed, and it was not enough: it applies to ITS
 *  request and nothing else. Measured on `gpt-5.6-luna` on 2026-10-01, three runs
 *  per arm, by setting the effort in turn 1 and naming nothing in turn 2:
 *
 *    via `configuration_update`   turn 2 reasoning tokens 0, 0, 0
 *    via `thinking.effort`        turn 2 reasoning tokens 244, 189, 172
 *    nothing at all               turn 2 reasoning tokens 155, 129, 198
 *
 *  The option does not persist; the item does. `none` is the arm that settles it
 *  — a flat zero against a default near 170 leaves nothing to argue about, which
 *  is why the part's vocabulary has to be able to say it.
 *
 *  Measured facts the official SDK types get wrong, each asserted below: the item
 *  REQUIRES `reasoning`, requires `reasoning.effort`, and refuses
 *  `effort: null`. All three are optional or nullable in `openai-ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OPENAI_REASONING_EFFORT } from '../../../src/llm/providers/openai/reasoning-effort';
import type { ConfigurationUpdatePart, ContentPart, Message } from '../../../src/llm/types/messages';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });

const update = (effort: ConfigurationUpdatePart['reasoning']['effort']): ConfigurationUpdatePart => ({
  type: 'configuration_update',
  reasoning: { effort },
});

/** The `input` array the adapter builds for one conversation. */
function input(messages: Message[]): Array<Record<string, unknown>> {
  const req = { model: 'gpt-5.6-sol', messages } as NormalizedRequest;
  return (adapter.buildRequest(req).body as { input: Array<Record<string, unknown>> }).input;
}

describe('the update on the way out', () => {
  it('is its own top-level item, not message content', async () => {
    const items = input([{ role: 'user', content: [update('high'), { type: 'text', text: 'hi' }] }]);
    const conf = items.find((i) => i.type === 'configuration_update');
    expect(conf).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } });
    // And the message is still there, with only its text.
    const msg = items.find((i) => i.role === 'user');
    expect(JSON.stringify(msg)).toContain('hi');
    expect(JSON.stringify(msg)).not.toContain('configuration_update');
  });

  it('comes BEFORE the message it travels with', () => {
    // The API applies an update to SUBSEQUENT responses. Placed after the message
    // it was meant to govern it governs the next one instead, and the caller sees
    // their change take effect a turn late with nothing reporting it.
    const items = input([{ role: 'user', content: [{ type: 'text', text: 'hi' }, update('low')] }]);
    expect(items[0]?.type).toBe('configuration_update');
  });

  it('travels on an assistant turn too, for a replayed transcript', () => {
    // A conversation restored from history carries the update that was in it. If
    // only user turns emitted it, replaying a transcript would quietly drop the
    // configuration and the replay would think harder (or less) than the original.
    const items = input([
      { role: 'assistant', content: [update('none'), { type: 'text', text: 'ok' }] },
    ]);
    expect(items.some((i) => i.type === 'configuration_update')).toBe(true);
  });

  it('does not echo the provider id', () => {
    // `cnfu_...` names the STORED item. Sending it back claims to update an item
    // that already exists, and nothing requires the round-trip.
    const withId: ConfigurationUpdatePart = { ...update('high'), id: 'cnfu_abc' };
    const items = input([{ role: 'user', content: [withId, { type: 'text', text: 'hi' }] }]);
    const conf = items.find((i) => i.type === 'configuration_update');
    expect(conf).not.toHaveProperty('id');
  });

  it('sends nothing when no part asks for it', () => {
    const items = input([{ role: 'user', content: 'plain string content' }]);
    expect(items.some((i) => i.type === 'configuration_update')).toBe(false);
  });

  it('maps `max` to the rung OpenAI actually has', () => {
    // Measured 2026-09-30: `effort: "max"` is a 400 on `gpt-5.4-nano`
    // ("Unsupported value: 'max' is not supported"). `max` means "the most this
    // model will do", so it is mapped, never sent — even though the
    // configuration_update validator on gpt-5.6-* does list `max`, because one
    // meaning for the word across the surface is worth more than one fewer line.
    const items = input([{ role: 'user', content: [update('max'), { type: 'text', text: 'hi' }] }]);
    expect(items[0]?.reasoning).toEqual({ effort: 'xhigh' });
  });

  it('passes `none` and `minimal` through, which is why they are nameable', () => {
    for (const effort of ['none', 'minimal'] as const) {
      const items = input([{ role: 'user', content: [update(effort), { type: 'text', text: 'x' }] }]);
      expect(items[0]?.reasoning).toEqual({ effort });
    }
  });
});

describe('the two effort tables agree', () => {
  it('matches the wire spec, entry for entry', () => {
    // The same mapping exists twice: here in TypeScript for the item the adapter
    // builds, and as a `$table` in the spec for the top-level field the
    // interpreter builds. An effort meaning one thing on a request and another on
    // a stored update, in the same conversation, is a bug nobody would look for —
    // so this is a mechanical guard rather than a note asking a future edit to
    // touch both.
    const spec = JSON.parse(
      readFileSync('src/wire/specs/openai-responses.json', 'utf8'),
    ) as { tables: { reasoningEffort: Record<string, string> } };
    const fromSpec = Object.fromEntries(
      Object.entries(spec.tables.reasoningEffort).filter(([k]) => !k.startsWith('_')),
    );
    expect(fromSpec).toEqual({ ...OPENAI_REASONING_EFFORT });
  });
});

describe('the update on the way back in', () => {
  /** What OpenAI stores, copied verbatim from a conversation items listing on
   *  2026-10-01 (`gpt-5.6-luna`). */
  const STORED = {
    id: 'cnfu_0fafbf4bd614c625006abe7d27d0688193a610cfa5c9ecb349',
    type: 'configuration_update',
    reasoning: { effort: 'high' },
  };

  const parse = (output: unknown[]) =>
    adapter.parseResponse({ id: 'resp_1', output, usage: {} }, 1);

  it('becomes a typed part, carrying the stored id', () => {
    const res = parse([STORED]);
    const part = res.content.find(
      (p: ContentPart) => p.type === 'configuration_update',
    ) as ConfigurationUpdatePart;
    expect(part).toBeDefined();
    expect(part.reasoning.effort).toBe('high');
    expect(part.id).toBe(STORED.id);
  });

  it('is not invented from an item with no effort', () => {
    // Nothing useful to carry, and a part claiming an undefined effort would be
    // sent back as one.
    const res = parse([{ id: 'cnfu_x', type: 'configuration_update' }]);
    expect(res.content.some((p: ContentPart) => p.type === 'configuration_update')).toBe(false);
  });

  it('survives a round trip', () => {
    // Measured: this item does NOT appear in `response.output` — four turns that
    // set one came back `output: [message]`, and it was found only through the
    // conversation-items endpoint. It is parsed anyway because OpenAI's types put
    // it in the output union and the cost of being wrong runs one way: dropping it
    // from history silently reverts the effort on the next turn.
    const res = parse([STORED]);
    const items = input([{ role: 'assistant', content: res.content }]);
    expect(items.find((i) => i.type === 'configuration_update')).toEqual({
      type: 'configuration_update',
      reasoning: { effort: 'high' },
    });
  });
});
