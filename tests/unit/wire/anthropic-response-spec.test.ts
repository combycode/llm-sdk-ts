/** The Anthropic response spec reproduces the hand-written parser, exactly.
 *
 *  This is the check that makes the migration safe. Both paths are live: the
 *  adapter still parses every response, and this asserts that driving the spec
 *  over the SAME recorded bodies yields the same object. When the adapter is
 *  eventually switched to the interpreter, the assertion survives, because
 *  `cell.parsed` is frozen data rather than something either path recomputes.
 *
 *  The bodies are real. `scripts/record-responses.ts` captured them from
 *  Anthropic, pre-parse, straight off the bus.
 */
import { describe, expect, it } from 'bun:test';
import golden from '../../fixtures/response-golden.json' with { type: 'json' };
import spec from '../../../src/wire/specs/responses/anthropic.messages.json' with { type: 'json' };
import { buildResponse, type ResponseSpec } from '../../../src/wire/response-interpreter';
import { ANTHROPIC_RESPONSE_REGISTRY } from '../../../src/llm/providers/anthropic/response-registry';
import type { ResponseCell } from '../../unit/llm/response-corpus';

const corpus = golden as unknown as Record<string, ResponseCell>;
const SPEC = spec as unknown as ResponseSpec;

const cells = Object.entries(corpus).filter(
  ([, c]) => c.target === 'anthropic/messages' && !c.streaming,
);

/** The adapter's own output is JSON round-tripped into the corpus, so undefined
 *  keys are already gone. Compare like for like. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const build = (cell: ResponseCell) =>
  plain(
    buildResponse(SPEC, cell.raw, ANTHROPIC_RESPONSE_REGISTRY, {
      extra: { latencyMs: 0, raw: cell.raw },
    }),
  );

describe('anthropic/messages.response', () => {
  it('has cells to check', () => {
    // A filter that silently matches nothing would make every case below vacuous.
    expect(cells.length).toBeGreaterThanOrEqual(7);
  });

  for (const [id, cell] of cells) {
    it(`${id} builds the same response the adapter does`, () => {
      expect(build(cell)).toEqual(cell.parsed as never);
    });
  }

  it('shares one object between content and toolCalls', () => {
    // Deep equality above cannot see reference identity, and the adapter's
    // behaviour depends on it.
    const cell = corpus['anthropic/messages::tools'];
    const built = buildResponse(SPEC, cell.raw, ANTHROPIC_RESPONSE_REGISTRY, {
      extra: { latencyMs: 0, raw: cell.raw },
    });
    const calls = built.toolCalls as unknown[];
    expect(calls.length).toBeGreaterThan(0);
    expect((built.content as unknown[]).includes(calls[0])).toBe(true);
  });

  it('carries hosted-tool output and files through the default case', () => {
    // The branch with no discriminator case of its own: *_tool_result attaches
    // stdout to its call, and code-execution results contribute files.
    const cell = corpus['anthropic/messages::builtin.codeexec'];
    const built = build(cell);
    const calls = (built.builtinToolCalls ?? []) as Array<{ output?: string }>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => typeof c.output === 'string' && c.output.length > 0)).toBe(true);
  });
});
