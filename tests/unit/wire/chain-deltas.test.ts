/** The chain's edits must be load-bearing, and everything a spec names must exist.
 *
 *  Two failure modes that both look like success:
 *
 *  1. A REMOVAL THAT REMOVES NOTHING. `removeFields` / `removeBlocks` used to
 *     filter silently, so a typo or a delta left stale by a rename simply did not
 *     happen. Whether that reached the wire depended on rule ORDER: renaming the
 *     block `anthropic/messages@4.6` removes changed no output at all, because the
 *     adaptive block it adds writes the same key and lands later. Reorder those two
 *     and a 4.6+ model gets the retired `budget_tokens` shape instead — a 400 on
 *     every thinking request. Found by mutating the spec and watching the suite
 *     stay green.
 *
 *  2. A SPEC NAMING CODE THAT IS NOT THERE. `$call` / `pred` / `fn` / `call` /
 *     `effects` resolve by string at build time, so a wrong name is not a compile
 *     error — it is a throw on the first request that reaches the rule, which may
 *     be a rule only one provider and one shape ever hit.
 *
 *  `scripts/audit-wire-coverage.ts` reports the same ground in more detail; this is
 *  the part that has to BLOCK.
 */

import { allResponseNames, RESPONSE_REGISTRIES } from '../../../src/llm/providers/response-registries';
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { applyDelta, resolveSpec, type SpecDelta } from '../../../src/wire/inherit';
import type { WireSpec } from '../../../src/wire/interpreter';
import { WIRE_SPECS } from '../../../src/wire/registry';
import { makeRegistry } from '../../../src/llm/wire-transforms';
import { mcpWireRegistry } from '../../../src/plugins/mcp/wire-rules';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';

const K = 'k';
const reg = makeRegistry({
  anthropic: new AnthropicAdapter({ apiKey: K }),
  google: new GoogleAdapter({ apiKey: K }),
  googleInteractions: new GoogleInteractionsAdapter({ apiKey: K }),
  openaiResponses: new OpenAIResponsesAdapter({ apiKey: K }),
  openaiCompletions: new OpenAIAdapter({ apiKey: K }),
});

const SPEC_DIR = resolve(import.meta.dir, '../../../src/wire/specs');
const SEP = String.fromCharCode(92);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}
const specFiles = walk(SPEC_DIR);

describe('a chain delta cannot remove something that is not there', () => {
  const base = (): WireSpec =>
    ({
      id: 'test/base',
      provider: 'test',
      fields: [{ to: 'temperature', from: 'temperature' }],
      blocks: [{ name: 'tools', to: 'tools', template: {} }],
    }) as unknown as WireSpec;

  it('removes what IS there', () => {
    const out = applyDelta(base(), {
      id: 'test/child',
      removeFields: ['temperature'],
      removeBlocks: ['tools'],
    } as SpecDelta);
    expect(out.fields).toEqual([]);
    expect(out.blocks).toEqual([]);
  });

  it('throws on a removeFields name the base does not define', () => {
    expect(() =>
      applyDelta(base(), { id: 'test/child', removeFields: ['top_kX'] } as SpecDelta),
    ).toThrow(/removeFields names "top_kX"/);
  });

  it('throws on a removeBlocks name the base does not define', () => {
    expect(() =>
      applyDelta(base(), { id: 'test/child', removeBlocks: ['thinking.typo'] } as SpecDelta),
    ).toThrow(/removeBlocks names "thinking.typo"/);
  });

  it('names what IS present, so the fix is obvious from the message', () => {
    try {
      applyDelta(base(), { id: 'test/child', removeBlocks: ['nope'] } as SpecDelta);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('Present: tools');
      expect((e as Error).message).toContain('test/child');
    }
  });

  it('every shipped spec still resolves under the strict rule', () => {
    const broken: string[] = [];
    for (const id of WIRE_SPECS.keys()) {
      try {
        resolveSpec(id, WIRE_SPECS as unknown as Map<string, SpecDelta>);
      } catch (e) {
        broken.push(`${id}: ${(e as Error).message}`);
      }
    }
    expect(broken).toEqual([]);
    expect(WIRE_SPECS.size).toBe(150);
  });
});

describe('every name a spec uses resolves to real code', () => {
  /** The five forms the interpreter reads. A search for one finds none of the
   *  others, which is why this collects all of them rather than grepping. */
  function namesIn(node: unknown, out: Set<string>): void {
    if (Array.isArray(node)) {
      for (const x of node) namesIn(x, out);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    // `effect` is the SCALAR form an EmitRule uses; `effects` below is the array
    // form the request specs use. Only the array was collected, so a typo in any
    // `"effect": "..."` resolved to nothing and failed at the first response
    // that happened to take that branch.
    for (const key of ['pred', '$call', 'fn', 'call', 'effect']) {
      if (typeof o[key] === 'string') out.add(o[key] as string);
    }
    if (Array.isArray(o.effects)) {
      for (const e of o.effects) if (typeof e === 'string') out.add(e);
    }
    for (const v of Object.values(o)) namesIn(v, out);
  }

  it('resolves every named reference across every shipped spec', () => {
    // MCP composes two extra rules onto the shared registry — `llm -> plugins` is a
    // forbidden edge, so they cannot live in wire-transforms with the rest. Names are
    // resolved against the composition the library actually builds, not against the
    // base alone, or an MCP spec would look like it referenced code that is not there.
    const full = mcpWireRegistry(reg);
    const known = new Set([
      ...Object.keys(full.transforms),
      ...Object.keys(full.builders),
      ...Object.keys(full.predicates),
      ...Object.keys(full.effects),
    ]);
    // Response specs resolve against the PER-PROVIDER response registries, not
    // this one: `anthropicFinish` is meaningless to an OpenAI spec, and a single
    // shared bag would let one provider's spec call another's helper. Both sets
    // are still checked — a typo in a response spec has to fail here, not at
    // the first request that happens to take that branch.
    const knownResponse = allResponseNames();
    const missing: string[] = [];
    let referenced = 0;
    for (const f of specFiles) {
      const rel = relative(SPEC_DIR, f).split(SEP).join('/');
      const names = new Set<string>();
      namesIn(JSON.parse(readFileSync(f, 'utf8')), names);
      referenced += names.size;
      // `responses/` and `stream/` both resolve against the per-provider
      // registries — a stream spec names the same kind of helper.
      const resolvesAgainst =
        rel.startsWith('responses/') || rel.startsWith('stream/') ? knownResponse : known;
      for (const n of names) {
        if (!resolvesAgainst.has(n)) missing.push(`${rel}: "${n}"`);
      }
    }
    // Guards against passing because nothing was collected.
    expect(referenced).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('every response and stream spec has a registry to resolve its names', () => {
    // A response spec with no entry in RESPONSE_REGISTRIES cannot be run at all.
    // Without this, adding the spec file and forgetting the wiring looks fine
    // until the first response arrives.
    const orphans: string[] = [];
    for (const f of specFiles) {
      const rel = relative(SPEC_DIR, f).split(SEP).join('/');
      if (!rel.startsWith('responses/') && !rel.startsWith('stream/')) continue;
      const id = (JSON.parse(readFileSync(f, 'utf8')) as { id?: string }).id ?? '(no id)';
      if (!RESPONSE_REGISTRIES[id]) orphans.push(`${rel}: id "${id}"`);
    }
    expect(orphans).toEqual([]);
  });
});
