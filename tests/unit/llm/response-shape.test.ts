/** The shape check reports drift, stays quiet otherwise, and its description of
 *  each provider cannot drift from the recordings.
 *
 *  The last part is what makes the feature maintainable rather than a second
 *  source of truth: `response-shapes.json` is derived from the corpus, and the
 *  first test here re-checks every recorded body against it. Re-record a provider
 *  whose response has changed and this goes red until someone regenerates — which
 *  is exactly the moment to decide whether the new field matters.
 */
import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import {
  checkShape,
  pathsOf,
  ResponseShapeChecker,
  streamEventKey,
  type ShapeBook,
} from '../../../src/llm/response-shape';
import type { ResponseCell } from './response-corpus';
import shapes from '../../../src/llm/response-shapes.json' with { type: 'json' };
import golden from '../../fixtures/response-golden.json' with { type: 'json' };

const book = shapes as unknown as ShapeBook;
const corpus = golden as unknown as Record<string, ResponseCell>;

/** Collect the warnings a checker emits for one body. */
function warningsFor(target: string, run: (c: ResponseShapeChecker) => void): string[] {
  const hooks = new HookBus();
  const seen: string[] = [];
  hooks.on('onWarning', (ctx) => {
    if (ctx.code.startsWith('response_shape_')) seen.push(`${ctx.code}: ${ctx.message}`);
  });
  const [provider, api] = target.split('/') as [string, string];
  run(new ResponseShapeChecker(hooks, provider, api, book));
  return seen;
}

describe('response shapes are derived from the corpus', () => {
  it('covers every recorded target', () => {
    const recorded = new Set(Object.values(corpus).map((c) => c.target));
    expect(Object.keys(book).sort()).toEqual([...recorded].sort());
  });

  it('every recorded body passes its own declaration', () => {
    // Not circular: the declaration is a UNION over recordings and an
    // INTERSECTION for `expected`, so a body can still fail it — a field seen in
    // one recording and absent from another is not `expected`, and one that
    // appears in a re-recording but not in the derivation is unknown.
    const complaints: string[] = [];
    for (const [id, cell] of Object.entries(corpus)) {
      // Synthetic cells are checked separately below: they legitimately LACK
      // fields every recording has (a failed response carries no output), so
      // holding them to `expected` would only assert that a stub is a stub.
      if (cell.synthetic) continue;
      const found = warningsFor(cell.target, (checker) => {
        if (cell.streaming) {
          for (const event of cell.raw as Array<{ event?: string; data: string }>) {
            checker.checkStreamEvent(event as never);
          }
        } else {
          checker.checkResponse(cell.raw);
        }
      });
      if (found.length) complaints.push(`${id}: ${found.join(' | ')}`);
    }
    expect(complaints).toEqual([]);
  });

  it('every synthetic body is at least RECOGNISED, field for field', () => {
    // The weaker half of the same contract. A constructed body may be missing
    // fields, but nothing in it may be UNKNOWN: an unknown field or an unhandled
    // discriminator would mean the shape book cannot describe an error response,
    // and the runtime checker would cry wolf the first time a provider sent one.
    const complaints: string[] = [];
    for (const [id, cell] of Object.entries(corpus)) {
      if (!cell.synthetic) continue;
      const found = warningsFor(cell.target, (checker) => checker.checkResponse(cell.raw)).filter(
        (w) => !w.includes('response_shape_missing_field'),
      );
      if (found.length) complaints.push(`${id}: ${found.join(' | ')}`);
    }
    expect(complaints).toEqual([]);
  });

  it('names every stream event type each provider actually sends', () => {
    for (const [target, set] of Object.entries(book)) {
      const cells = Object.values(corpus).filter((c) => c.target === target && c.streaming);
      if (cells.length === 0) continue;
      const sent = new Set<string>();
      for (const cell of cells) {
        for (const event of cell.raw as Array<{ event?: string; data: string }>) {
          try {
            sent.add(streamEventKey(event as never, JSON.parse(event.data)));
          } catch {
            /* non-JSON payloads describe no shape */
          }
        }
      }
      expect(Object.keys(set.stream ?? {}).sort()).toEqual([...sent].sort());
    }
  });
});

describe('what the check reports', () => {
  const target = 'anthropic/messages';
  const base = () => structuredClone((corpus[`${target}::text`] as ResponseCell).raw) as Record<string, unknown>;

  it('says nothing about a body it already knows', () => {
    expect(warningsFor(target, (c) => c.checkResponse(base()))).toEqual([]);
  });

  it('reports a field it has never seen', () => {
    const body = base();
    body.brand_new_field = 1;
    const found = warningsFor(target, (c) => c.checkResponse(body));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('unknown_field');
    expect(found[0]).toContain('brand_new_field');
  });

  it('reports a field that was always there and is now gone', () => {
    // The rename case: the provider still answers 200, the parse still succeeds,
    // and the number it produced is `undefined`.
    const body = base();
    const renamed = body.usage as Record<string, unknown>;
    renamed.output_tokens_v2 = renamed.output_tokens;
    delete renamed.output_tokens;
    const found = warningsFor(target, (c) => c.checkResponse(body));
    expect(found.some((w) => w.includes('missing_field') && w.includes('usage.output_tokens'))).toBe(true);
    expect(found.some((w) => w.includes('unknown_field') && w.includes('output_tokens_v2'))).toBe(true);
  });

  it('reports a discriminator value nothing branches on', () => {
    // A new content-block type is the most expensive drift there is: the block is
    // dropped, the reply is short, and nothing errors.
    const body = base();
    (body.content as Array<Record<string, unknown>>).push({ type: 'holographic_diagram', data: 'x' });
    const found = warningsFor(target, (c) => c.checkResponse(body));
    expect(found.some((w) => w.includes('unknown_value') && w.includes('holographic_diagram'))).toBe(true);
  });

  it('reports a stream event type it does not handle', () => {
    const found = warningsFor(target, (c) =>
      c.checkStreamEvent({ event: 'message_teleport', data: '{"type":"message_teleport"}' } as never),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('unknown_event');
    expect(found[0]).toContain('message_teleport');
  });

  it('reports each finding once, however many responses carry it', () => {
    // Otherwise the same line arrives on every request for the life of the
    // process, and the person it is for stops reading it.
    const hooks = new HookBus();
    let n = 0;
    hooks.on('onWarning', (ctx) => {
      if (ctx.code.startsWith('response_shape_')) n++;
    });
    const checker = new ResponseShapeChecker(hooks, 'anthropic', 'messages', book);
    const body = base();
    body.brand_new_field = 1;
    for (let i = 0; i < 5; i++) checker.checkResponse(body);
    expect(n).toBe(1);
  });

  it('stays silent for a provider it has no declaration for', () => {
    // Not "everything is unknown": a target nobody recorded would otherwise
    // produce a warning per field on every request.
    expect(warningsFor('someone/else', (c) => c.checkResponse({ anything: true }))).toEqual([]);
  });

  it('ignores a non-JSON stream payload', () => {
    // `[DONE]` sentinels and keep-alives describe no shape.
    expect(warningsFor(target, (c) => c.checkStreamEvent({ data: '[DONE]' } as never))).toEqual([]);
  });
});

describe('path collection', () => {
  it('collapses array indices, so list length is not part of the shape', () => {
    const one = pathsOf({ items: [{ a: 1 }] });
    const three = pathsOf({ items: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    expect([...one].sort()).toEqual([...three].sort());
    expect([...one].sort()).toEqual(['items', 'items[]', 'items[].a']);
  });

  it('treats a differently-typed leaf as the same path', () => {
    // The check is about SHAPE, not types: a string where a number was is not
    // reported here, and claiming otherwise would make it noisy on every nullable.
    const decl = { known: ['a'], expected: ['a'] };
    expect(checkShape({ a: 'text' }, decl)).toEqual({ unknown: [], missing: [], unknownValues: [] });
  });
});
