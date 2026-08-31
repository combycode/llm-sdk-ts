/** Every response spec reproduces the hand-written parser it replaces, exactly.
 *
 *  This is the check that makes the migration safe. Both paths are live: the
 *  adapters still parse every response, and this asserts that driving the spec
 *  over the SAME recorded bodies yields the same object. When the adapters are
 *  switched to the interpreter the assertion survives, because `cell.parsed` is
 *  frozen data that neither path recomputes.
 *
 *  The bodies are real -- `scripts/record-responses.ts` captured them pre-parse,
 *  straight off the bus -- except the cells marked `synthetic`, which are
 *  constructed because no provider fails on demand.
 *
 *  Adding a provider adds no code here: write the spec, register its registry,
 *  and its recorded cells start being checked.
 */
import { describe, expect, it } from 'bun:test';
import golden from '../../fixtures/response-golden.json' with { type: 'json' };
import { buildResponse } from '../../../src/wire/response-interpreter';
import { getResponseSpec, RESPONSE_SPECS, responseSpecId } from '../../../src/wire/response-specs';
import { RESPONSE_REGISTRIES } from '../../../src/llm/providers/response-registries';
import type { ResponseCell } from '../llm/response-corpus';

const corpus = golden as unknown as Record<string, ResponseCell>;

/** Buffered cells whose target has a spec. Streaming is a separate phase: a
 *  stream parser is a state machine across events, not a mapping. */
const covered = Object.entries(corpus).filter(
  ([, c]) => !c.streaming && RESPONSE_SPECS.has(responseSpecId(c.target)),
);

const build = (cell: ResponseCell) => {
  const id = responseSpecId(cell.target);
  const reg = RESPONSE_REGISTRIES[id];
  if (!reg) throw new Error(`no response registry for ${id}`);
  return buildResponse(getResponseSpec(id), cell.raw, reg, {
    extra: { latencyMs: 0, raw: cell.raw },
  });
};

/** The adapter's output was JSON round-tripped into the corpus, so undefined
 *  keys are already gone. Compare like for like. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('response specs reproduce their adapters', () => {
  it('is actually checking something', () => {
    // A filter that silently matched nothing would make every case below vacuous.
    expect(covered.length).toBeGreaterThanOrEqual(7);
    // And every spec that ships must have cells behind it, or it is unproven.
    const unproven = [...RESPONSE_SPECS.keys()].filter(
      (id) => !covered.some(([, c]) => responseSpecId(c.target) === id),
    );
    expect(unproven).toEqual([]);
  });

  for (const [id, cell] of covered) {
    it(`${id} builds the same response the adapter does`, () => {
      expect(plain(build(cell))).toEqual(cell.parsed as never);
    });
  }
});

describe('behaviour deep equality cannot see', () => {
  it('shares one object between content and toolCalls', () => {
    // The adapters push a single object into both arrays. Copies would satisfy
    // every assertion above and still change what consumers observe.
    let checked = 0;
    for (const target of ['anthropic/messages', 'openai/completions']) {
      const cell = corpus[`${target}::tools`];
      if (!cell || !RESPONSE_SPECS.has(responseSpecId(target))) continue;
      const built = build(cell);
      const calls = built.toolCalls as unknown[];
      expect(calls.length).toBeGreaterThan(0);
      expect((built.content as unknown[]).includes(calls[0])).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('carries hosted-tool output and files through the anthropic default case', () => {
    // The branch with no discriminator case of its own: *_tool_result attaches
    // stdout to its call, and code-execution results contribute files.
    const cell = corpus['anthropic/messages::builtin.codeexec'];
    const built = plain(build(cell));
    const calls = (built.builtinToolCalls ?? []) as Array<{ output?: string }>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => typeof c.output === 'string' && c.output.length > 0)).toBe(true);
  });

  it('keeps content order: text first, then the spoken audio', () => {
    // `seed` runs before `collect` precisely for this. Rendering depends on it.
    const cell = corpus['openai/completions::media.audio'];
    const types = (plain(build(cell)).content as Array<{ type: string }>).map((p) => p.type);
    expect(types).toEqual(['text', 'audio_output']);
  });
});
