/** Anthropic's code-execution container, and the skills loaded into it.
 *
 *  Fixtures transcribed from live captures (2026-10-02), all on a plain key with no
 *  beta header — the param is GA. Three of them pin things a reasonable guess gets
 *  wrong:
 *
 *  - When STREAMING, `message_start` carries `container: null` and the real
 *    container arrives on `message_delta.delta.container`. Reading the opening
 *    frame reports `null` for every streamed turn.
 *  - A requested `version: 'latest'` comes back RESOLVED (`'20260914'`), so the
 *    response's version is worth reporting rather than echoing the request.
 *  - `container: null` is the NORMAL answer for a turn that ran no code. Not an
 *    error, and not worth a warning.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/index';
import type { SSEEvent } from '../../../src/network/types';
import {
  containerFromWire,
  toWireContainer,
} from '../../../src/llm/providers/anthropic/container';

const ADAPTER = new AnthropicAdapter({ apiKey: 'k' });

const WIRE_CONTAINER = {
  id: 'container_011qsGm3etjwdPk4vQ14efrr',
  expires_at: '2026-10-02T12:55:18.075903Z',
  skills: [{ type: 'anthropic', skill_id: 'xlsx', version: '20260914' }],
};

function bodyFor(providerOptions: Record<string, unknown>): Record<string, unknown> {
  const req = ADAPTER.buildRequest({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 256,
    tools: [{ type: 'code_interpreter' }],
    providerOptions,
  } as never);
  return ((req as { body?: Record<string, unknown> }).body ?? {}) as Record<string, unknown>;
}

describe('asking for a container', () => {
  it('sends an id so a warm container is reused', () => {
    expect(bodyFor({ container: { id: 'container_abc' } }).container).toEqual({
      id: 'container_abc',
    });
  });

  it('renames skillId to the wire name', () => {
    // The one thing the spec language cannot do, and the reason this is a named
    // transform rather than a passthrough.
    expect(
      toWireContainer({ skills: [{ type: 'anthropic', skillId: 'xlsx', version: 'latest' }] }),
    ).toEqual({ skills: [{ type: 'anthropic', skill_id: 'xlsx', version: 'latest' }] });
  });

  it('omits a version the caller did not pin', () => {
    expect(toWireContainer({ skills: [{ type: 'custom', skillId: 'skl_1' }] })).toEqual({
      skills: [{ type: 'custom', skill_id: 'skl_1' }],
    });
  });

  it('sends an id and skills together', () => {
    const body = bodyFor({
      container: { id: 'container_abc', skills: [{ type: 'anthropic', skillId: 'pdf' }] },
    });
    expect(body.container).toEqual({
      id: 'container_abc',
      skills: [{ type: 'anthropic', skill_id: 'pdf' }],
    });
  });

  it('sends no empty keys for a container the caller left blank', () => {
    // `skills: []` would be asking for something they did not ask for.
    expect(toWireContainer({})).toEqual({});
    expect(toWireContainer({ skills: [] })).toEqual({});
  });

  it('refuses a skill ref with no skillId instead of sending an empty one', () => {
    // Without this the entry becomes `{}` on the wire once `undefined` is dropped,
    // and the provider answers about a field the caller never wrote.
    expect(() => toWireContainer({ skills: [{ type: 'anthropic' } as never] })).toThrow(
      /skillId must be a non-empty string/,
    );
  });

  it('refuses a skill ref with an unknown type', () => {
    expect(() =>
      toWireContainer({ skills: [{ type: 'builtin' as never, skillId: 'xlsx' }] }),
    ).toThrow(/must be 'anthropic' or 'custom'/);
  });

  it('refuses something that is not a skill ref at all', () => {
    // A bare string is the obvious mistake. Skipping it would load nothing while
    // the caller believes a skill is loaded.
    expect(() => toWireContainer({ skills: ['xlsx' as never] })).toThrow(/must be/);
  });

  it('sends nothing at all when no container was asked for', () => {
    // The regression that carries every existing caller of the code tool.
    expect('container' in bodyFor({})).toBe(false);
  });
});

describe('reading the container back', () => {
  it('camelCases it and keeps the RESOLVED skill version', () => {
    // `latest` was the request; `20260914` is what ran, and that is the useful fact.
    expect(containerFromWire(WIRE_CONTAINER)).toEqual({
      id: WIRE_CONTAINER.id,
      expiresAt: '2026-10-02T12:55:18.075903Z',
      skills: [{ type: 'anthropic', skillId: 'xlsx', version: '20260914' }],
    });
  });

  it('reports no container for a turn that ran no code', () => {
    // `null` is the normal answer there -- no container was created.
    expect(containerFromWire(null)).toBeUndefined();
    expect(containerFromWire(undefined)).toBeUndefined();
  });

  it('ignores a container with no id, which is nothing to reuse', () => {
    expect(containerFromWire({ expires_at: 'x' })).toBeUndefined();
  });

  it('leaves skills off when none were loaded', () => {
    const info = containerFromWire({ id: 'c', expires_at: 'x' });
    expect(info).toEqual({ id: 'c', expiresAt: 'x' });
    expect(info && 'skills' in info).toBe(false);
  });

  it('leaves skills off for an EMPTY list too, not reported as present', () => {
    // An absent key and an empty list mean the same thing -- no skills were
    // loaded -- and reporting `skills: []` would invite a caller to believe the
    // field distinguishes them.
    const info = containerFromWire({ id: 'c', expires_at: 'x', skills: [] });
    expect(info && 'skills' in info).toBe(false);
  });

  it('appears on a buffered response', () => {
    const parsed = ADAPTER.parseResponse(
      {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: '4' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        container: WIRE_CONTAINER,
      } as never,
      1,
    );
    expect(parsed.container?.id).toBe(WIRE_CONTAINER.id);
    expect(parsed.container?.skills?.[0]?.skillId).toBe('xlsx');
  });

  it('is absent from a buffered response that had none', () => {
    const parsed = ADAPTER.parseResponse(
      {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        container: null,
      } as never,
      1,
    );
    expect(parsed.container).toBeUndefined();
  });
});

describe('the container in a stream', () => {
  function streamOf(payloads: Record<string, unknown>[]) {
    const parse = new AnthropicAdapter({ apiKey: 'k' }).createStreamParser();
    const events: Record<string, unknown>[] = [];
    for (const p of payloads) {
      const sse = { event: String(p.type), data: JSON.stringify(p) } as SSEEvent;
      for (const e of parse(sse)) events.push(e as Record<string, unknown>);
    }
    return events;
  }

  const OPENING = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      content: [],
      // Measured: null even on a turn that DOES create a container.
      container: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };

  const CLOSING = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', container: WIRE_CONTAINER },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it('rides the terminal frame, where the provider actually sends it', () => {
    const done = streamOf([OPENING, CLOSING]).find((e) => e.type === 'done');
    expect(done?.container).toEqual({
      id: WIRE_CONTAINER.id,
      expiresAt: '2026-10-02T12:55:18.075903Z',
      skills: [{ type: 'anthropic', skillId: 'xlsx', version: '20260914' }],
    });
  });

  it('is not taken from the opening frame, which always says null', () => {
    // Taking it from `message_start` would report nothing for every streamed turn.
    const events = streamOf([OPENING]);
    expect(events.some((e) => e.container)).toBe(false);
  });

  it('is not reported from the opening frame even if one appeared there', () => {
    // Guards the fix rather than the symptom. `message_start` is measured to send
    // `null`, so reading it also "works" -- until the day it does not, when the
    // same turn would report its container twice, from two different frames, with
    // two `done` events. The opening frame reports no container, full stop.
    const events = streamOf([
      { ...OPENING, message: { ...OPENING.message, container: WIRE_CONTAINER } },
    ]);
    expect(events.some((e) => e.container)).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('leaves `done` alone when the turn had no container', () => {
    const done = streamOf([
      OPENING,
      { type: 'message_delta', delta: { stop_reason: 'end_turn', container: null } },
    ]).find((e) => e.type === 'done');
    expect(done && 'container' in done).toBe(false);
  });
});
