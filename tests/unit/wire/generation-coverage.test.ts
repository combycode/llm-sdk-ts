/** Do the spec chains cover every model GENERATION, not just the catalogued ones?
 *
 *  The chains replaced version arithmetic. `anthropicAdaptiveThinking` — the one
 *  code escape hatch, which computed the thinking shape from the id at build time —
 *  is referenced by none of the 71 shipped specs any more (proved mechanically by
 *  `scripts/audit-wire-coverage.ts`, across all five reference forms). Chain nodes
 *  do that job now.
 *
 *  That replacement is only safe if the node an id lands on produces the SAME wire
 *  the arithmetic would have. The golden corpus checks catalogued models, which is
 *  289 of them but every one a model we already knew about. The ids that actually
 *  exercise the fallback are the ones the catalog does NOT have: a dated snapshot,
 *  a legacy family-last name, a release newer than this build.
 *
 *  So this drives the ids the corpus cannot: every alias and snapshot in the
 *  catalog, the retired ids, the boundary either side of 4.6, plausible future
 *  releases, and the legacy `claude-3-*` form — and requires the spec the adapter
 *  selects to agree with the rules the official SDK documents:
 *
 *    thinking  `{type:'adaptive'}` from 4.6 up, `{type:'enabled', budget_tokens}`
 *              below it. Anthropic's SDK carries both as distinct types.
 *    top_k     "Models released after Claude Opus 4.6 do not accept top_k; any
 *              value will be rejected with a 400 error" — @deprecated, verbatim
 *              from the pinned SDK clone.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import {
  anthropicAcceptsTopK,
  anthropicThinkingShape,
} from '../../../src/llm/providers/anthropic/constants';
import { googleUsesThinkingBudget } from '../../../src/llm/providers/google/constants';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const anthropic = new AnthropicAdapter({ apiKey: 'k' });
const google = new GoogleAdapter({ apiKey: 'k' });

const req = (model: string, extra: Record<string, unknown>): NormalizedRequest =>
  ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) as unknown as NormalizedRequest;

const body = (a: { buildRequest: (r: NormalizedRequest) => unknown }, r: NormalizedRequest) =>
  (a.buildRequest(r) as { body: Record<string, unknown> }).body;

/** Ids across every Anthropic generation this SDK can be pointed at.
 *
 *  Catalogued slugs are covered by the golden corpus; what matters here is
 *  everything else — the forms a caller can legitimately send that the catalog has
 *  no row for. */
const ANTHROPIC_IDS = [
  // dated snapshots (callable, and how the API names releases)
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  // the 4.6 boundary, from both sides
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  // dotted forms
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-sonnet-4.6',
  // current generation
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-mythos-5',
  // releases newer than this build — the fallback's real job
  'claude-opus-6',
  'claude-sonnet-6-1',
  'claude-opus-4-10',
  'claude-haiku-7',
  'claude-sonnet-6-1-20270101',
  // legacy family-last ids, all of which predate extended thinking
  'claude-3-5-sonnet-latest',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
  // namespaced, as a caller may pass it
  'anthropic/claude-sonnet-5',
];

describe('the anthropic chain covers every generation', () => {
  it('drives a meaningful spread of ids', () => {
    expect(ANTHROPIC_IDS.length).toBeGreaterThanOrEqual(25);
  });

  it('thinking shape matches what the id implies, for every id', () => {
    const wrong: string[] = [];
    for (const id of ANTHROPIC_IDS) {
      const b = body(anthropic, req(id, { thinking: { mode: 'on', effort: 'high' } }));
      const thinking = b.thinking as { type?: string; budget_tokens?: number } | undefined;
      const got = thinking?.type === 'adaptive' ? 'adaptive' : 'budgeted';
      const want = anthropicThinkingShape(id);
      if (got !== want) wrong.push(`${id}: want ${want}, spec produced ${JSON.stringify(thinking)}`);
      // The budgeted shape is worthless without the budget: Anthropic requires
      // budget_tokens >= 1024 and < max_tokens.
      if (want === 'budgeted') {
        if (typeof thinking?.budget_tokens !== 'number' || thinking.budget_tokens < 1024) {
          wrong.push(`${id}: budgeted thinking without a valid budget_tokens`);
        }
        if ((b.max_tokens as number) <= (thinking?.budget_tokens ?? 0)) {
          wrong.push(`${id}: max_tokens (${b.max_tokens}) must exceed budget_tokens`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('top_k is sent only to ids that still accept it', () => {
    const wrong: string[] = [];
    for (const id of ANTHROPIC_IDS) {
      const sent = body(anthropic, req(id, { topK: 20 })).top_k !== undefined;
      const want = anthropicAcceptsTopK(id);
      if (sent !== want) wrong.push(`${id}: accepts=${want} but spec ${sent ? 'sent' : 'omitted'} top_k`);
    }
    expect(wrong).toEqual([]);
  });

  it('an unknown id fails SAFE: adaptive thinking, no top_k', () => {
    // Omitting top_k is a no-op; sending it to a model released after 4.6 is a hard
    // 400. The asymmetry is what decides the default for anything unrecognised.
    const b = body(anthropic, req('claude-something-entirely-new', { topK: 20, thinking: { mode: 'on' } }));
    expect((b.thinking as { type: string }).type).toBe('adaptive');
    expect(b.top_k).toBeUndefined();
  });

  it('thinking off is honoured across generations', () => {
    for (const id of ['claude-opus-4-20250514', 'claude-opus-4-6', 'claude-sonnet-5']) {
      const b = body(anthropic, req(id, { thinking: { mode: 'off' } }));
      expect(b.thinking).toBeUndefined();
    }
  });
});

const GOOGLE_IDS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-pro-latest',
  // newer than this build
  'gemini-4-pro',
  'gemini-3.9-flash',
  'google/gemini-3-flash',
];

describe('the google chain covers every generation', () => {
  it('thinking control matches what the id implies, for every id', () => {
    const wrong: string[] = [];
    for (const id of GOOGLE_IDS) {
      const b = body(google, req(id, { thinking: { mode: 'on', effort: 'high' } }));
      const cfg = (b.generationConfig as Record<string, unknown>)?.thinkingConfig as
        | Record<string, unknown>
        | undefined;
      const got = cfg?.thinkingBudget !== undefined ? 'budget' : 'level';
      const want = googleUsesThinkingBudget(id) ? 'budget' : 'level';
      if (got !== want) wrong.push(`${id}: want ${want}, spec produced ${JSON.stringify(cfg)}`);
      // 2.5 rejects thinkingLevel and 3.x rejects thinkingBudget, so exactly one
      // of the two must ever be present.
      if (cfg && cfg.thinkingBudget !== undefined && cfg.thinkingLevel !== undefined) {
        wrong.push(`${id}: sent BOTH thinkingBudget and thinkingLevel`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('an unknown gemini id takes the newer control', () => {
    const b = body(google, req('gemini-99-ultra', { thinking: { mode: 'on' } }));
    const cfg = (b.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>;
    expect(cfg.thinkingLevel).toBeDefined();
    expect(cfg.thinkingBudget).toBeUndefined();
  });
});
