/** Do the spec chains cover every model GENERATION, not just the catalogued ones?
 *
 *  Every catalogued model carries an explicit `wireSpec`, and the golden corpus
 *  checks all 289 of them. The ids that exercise the FALLBACK are the ones the
 *  catalog does not have: a dated snapshot, a legacy family-last name, or a model
 *  released after this build. That path is not an edge case — it is how the SDK
 *  behaves on the day a provider ships something new.
 *
 *  ── why the expectations are written out ───────────────────────────────────
 *  This test used to compare the spec's output against `anthropicThinkingShape()`
 *  — the same arithmetic the adapter called. Two derivations of one rule agreeing
 *  says almost nothing; it is a tautology wearing a test's clothes. The rule now
 *  lives in `src/wire/pins/*.json` as data, and the expectations below are written
 *  out by hand from the documented API behaviour, so the test and the thing it
 *  tests have genuinely independent sources.
 *
 *  The rules themselves, from the pinned SDK clone:
 *    thinking  `{type:'adaptive'}` from 4.6 up, `{type:'enabled', budget_tokens}`
 *              below it. Anthropic's SDK carries both as distinct types.
 *    top_k     "Deprecated. Models released after Claude Opus 4.6 do not accept
 *              top_k; any value will be rejected with a 400 error."
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const anthropic = new AnthropicAdapter({ apiKey: 'k' });
const google = new GoogleAdapter({ apiKey: 'k' });

const req = (model: string, extra: Record<string, unknown>): NormalizedRequest =>
  ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) as unknown as NormalizedRequest;

const body = (a: { buildRequest: (r: NormalizedRequest) => unknown }, r: NormalizedRequest) =>
  (a.buildRequest(r) as { body: Record<string, unknown> }).body;

type Thinking = 'adaptive' | 'budgeted';

/** id -> what the API accepts for it. Written from the provider's own rules, not
 *  derived from library code. */
const ANTHROPIC: Array<{ id: string; thinking: Thinking; topK: boolean; note?: string }> = [
  // 4.0: no minor, or a release DATE that must not be read as one
  { id: 'claude-opus-4', thinking: 'budgeted', topK: false },
  { id: 'claude-sonnet-4', thinking: 'budgeted', topK: false },
  { id: 'claude-opus-4-20250514', thinking: 'budgeted', topK: false, note: 'date, not minor 20250514' },
  { id: 'claude-sonnet-4-20250514', thinking: 'budgeted', topK: false },
  // 4.1 - 4.5: budgeted, and these are the ids the top_k allow-list names
  { id: 'claude-opus-4-1', thinking: 'budgeted', topK: true },
  { id: 'claude-opus-4-1-20250805', thinking: 'budgeted', topK: true },
  { id: 'claude-opus-4-5', thinking: 'budgeted', topK: true },
  { id: 'claude-opus-4-5-20251101', thinking: 'budgeted', topK: true },
  { id: 'claude-sonnet-4-5', thinking: 'budgeted', topK: true },
  { id: 'claude-sonnet-4-5-20250929', thinking: 'budgeted', topK: true },
  { id: 'claude-haiku-4-5', thinking: 'budgeted', topK: true },
  { id: 'claude-haiku-4-5-20251001', thinking: 'budgeted', topK: true },
  // a 4.x minor the allow-list does not name: budgeted, and top_k withheld
  { id: 'claude-opus-4-2', thinking: 'budgeted', topK: false },
  { id: 'claude-haiku-4-3', thinking: 'budgeted', topK: false },
  // 4.6 exactly: the boundary, and the only band that is adaptive AND takes top_k
  { id: 'claude-opus-4-6', thinking: 'adaptive', topK: true },
  { id: 'claude-sonnet-4-6', thinking: 'adaptive', topK: true },
  // above 4.6: adaptive, top_k retired
  { id: 'claude-opus-4-7', thinking: 'adaptive', topK: false },
  { id: 'claude-opus-4-8', thinking: 'adaptive', topK: false },
  { id: 'claude-opus-4-10', thinking: 'adaptive', topK: false, note: 'two-digit minor, not a date' },
  { id: 'claude-sonnet-5', thinking: 'adaptive', topK: false },
  { id: 'claude-opus-5', thinking: 'adaptive', topK: false },
  { id: 'claude-fable-5', thinking: 'adaptive', topK: false },
  { id: 'claude-mythos-5', thinking: 'adaptive', topK: false },
  // newer than this build: treated as newer, which is the fail-safe direction
  { id: 'claude-opus-6', thinking: 'adaptive', topK: false },
  { id: 'claude-sonnet-6-1', thinking: 'adaptive', topK: false },
  { id: 'claude-haiku-7', thinking: 'adaptive', topK: false },
  { id: 'claude-sonnet-6-1-20270101', thinking: 'adaptive', topK: false },
  { id: 'claude-something-entirely-new', thinking: 'adaptive', topK: false },
  // legacy family-last ids: all predate extended thinking
  { id: 'claude-3-5-sonnet-latest', thinking: 'budgeted', topK: false },
  { id: 'claude-3-opus-20240229', thinking: 'budgeted', topK: false },
  { id: 'claude-3-haiku-20240307', thinking: 'budgeted', topK: false },
  // namespaced and upper-cased forms a caller may legitimately send
  { id: 'anthropic/claude-sonnet-5', thinking: 'adaptive', topK: false },
  { id: 'CLAUDE-OPUS-4-6', thinking: 'adaptive', topK: true, note: 'case must not change the band' },
  // DOTTED slugs below 4.6 withhold top_k where the hyphenated form allows it.
  // Deliberate: the allow-list only ever matched hyphens, omitting top_k is a
  // no-op, and sending it to a model that retired it is a hard 400.
  { id: 'claude-opus-4.5', thinking: 'budgeted', topK: false },
  { id: 'claude-sonnet-4.5', thinking: 'budgeted', topK: false },
  { id: 'claude-opus-4.6', thinking: 'adaptive', topK: false },
  { id: 'claude-opus-4.8', thinking: 'adaptive', topK: false },
];

describe('the anthropic chain covers every generation', () => {
  it('drives a meaningful spread of ids', () => {
    expect(ANTHROPIC.length).toBeGreaterThanOrEqual(35);
  });

  it('the thinking shape matches what the model accepts', () => {
    const wrong: string[] = [];
    for (const c of ANTHROPIC) {
      const b = body(anthropic, req(c.id, { thinking: { mode: 'on', effort: 'high' } }));
      const t = b.thinking as { type?: string; budget_tokens?: number } | undefined;
      const got: Thinking = t?.type === 'adaptive' ? 'adaptive' : 'budgeted';
      if (got !== c.thinking) wrong.push(`${c.id}: want ${c.thinking}, got ${JSON.stringify(t)}`);
      if (c.thinking === 'budgeted') {
        // The budgeted shape is worthless without its budget: Anthropic requires
        // budget_tokens >= 1024 and strictly less than max_tokens.
        if (typeof t?.budget_tokens !== 'number' || t.budget_tokens < 1024) {
          wrong.push(`${c.id}: budgeted thinking without a valid budget_tokens`);
        }
        if ((b.max_tokens as number) <= (t?.budget_tokens ?? 0)) {
          wrong.push(`${c.id}: max_tokens (${b.max_tokens}) must exceed budget_tokens`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('top_k is sent only to models that still accept it', () => {
    const wrong: string[] = [];
    for (const c of ANTHROPIC) {
      const sent = body(anthropic, req(c.id, { topK: 20 })).top_k !== undefined;
      if (sent !== c.topK) wrong.push(`${c.id}: accepts=${c.topK} but ${sent ? 'sent' : 'omitted'}`);
    }
    expect(wrong).toEqual([]);
  });

  it('thinking off is honoured across generations', () => {
    for (const id of ['claude-opus-4-20250514', 'claude-opus-4-6', 'claude-sonnet-5']) {
      expect(body(anthropic, req(id, { thinking: { mode: 'off' } })).thinking).toBeUndefined();
    }
  });
});

/** 2.5 takes a token budget and rejects the level; 3.x takes the level. Nothing
 *  else about the id changes the control. */
const GOOGLE: Array<{ id: string; control: 'budget' | 'level' }> = [
  { id: 'gemini-2.5-pro', control: 'budget' },
  { id: 'gemini-2.5-flash', control: 'budget' },
  { id: 'gemini-2.5-flash-lite', control: 'budget' },
  { id: 'gemini-3-flash', control: 'level' },
  { id: 'gemini-3-flash-preview', control: 'level' },
  { id: 'gemini-3.1-pro', control: 'level' },
  { id: 'gemini-3.1-pro-preview', control: 'level' },
  { id: 'gemini-3.1-flash-lite', control: 'level' },
  { id: 'gemini-3.5-flash', control: 'level' },
  { id: 'gemini-3.6-flash', control: 'level' },
  { id: 'gemini-flash-latest', control: 'level' },
  { id: 'gemini-pro-latest', control: 'level' },
  { id: 'gemini-4-pro', control: 'level' },
  { id: 'gemini-3.9-flash', control: 'level' },
  { id: 'gemini-99-ultra', control: 'level' },
  { id: 'google/gemini-3-flash', control: 'level' },
];

describe('the google chain covers every generation', () => {
  it('the thinking control matches what the model accepts', () => {
    const wrong: string[] = [];
    for (const c of GOOGLE) {
      const b = body(google, req(c.id, { thinking: { mode: 'on', effort: 'high' } }));
      const cfg = (b.generationConfig as Record<string, unknown>)?.thinkingConfig as
        | Record<string, unknown>
        | undefined;
      const got = cfg?.thinkingBudget !== undefined ? 'budget' : 'level';
      if (got !== c.control) wrong.push(`${c.id}: want ${c.control}, got ${JSON.stringify(cfg)}`);
      // 2.5 rejects thinkingLevel and 3.x rejects thinkingBudget, so exactly one
      // of the two may ever be present.
      if (cfg?.thinkingBudget !== undefined && cfg?.thinkingLevel !== undefined) {
        wrong.push(`${c.id}: sent BOTH thinkingBudget and thinkingLevel`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
