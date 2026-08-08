/** `tiktoken` as an OPTIONAL PEER dependency.
 *
 *  Guards the fix for a consumer report (2026-08-08): a string-literal `import('tiktoken')` is
 *  statically resolvable, so bundlers emitted tiktoken's ~5.6 MB wasm into every consumer bundle —
 *  88% of that project's production output, for a code path their app never reached. The specifier
 *  must stay in a variable, and the counter must not be constructed until it is actually used.
 *
 *  See CONSTITUTION.md standing decisions (2026-08-08). */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TiktokenCounter, tiktokenUnavailableError } from '../../../../src/plugins/context-measurer/counter/tiktoken';
import { HybridTokenCounter } from '../../../../src/plugins/context-measurer/counter/hybrid';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';

const SRC = join(import.meta.dir, '../../../../src/plugins/context-measurer/counter/tiktoken.ts');

/** Bundlers parse code, not prose — and the doc comment in that file deliberately quotes the
 *  anti-pattern it warns about. Strip comments so the guard tests what actually ships. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── The regression guard: the specifier must not be statically resolvable ────

describe('bundler safety', () => {
  it('never imports "tiktoken" with a literal specifier', () => {
    const code = stripComments(readFileSync(SRC, 'utf8'));
    expect(code).not.toMatch(/import\s*\(\s*['"]tiktoken['"]\s*\)/);
  });

  it('loads the module through a variable specifier', () => {
    const src = readFileSync(SRC, 'utf8');
    expect(src).toMatch(/const TIKTOKEN_SPECIFIER = 'tiktoken'/);
    expect(src).toMatch(/import\([^)]*TIKTOKEN_SPECIFIER\)/);
  });
});

// ─── The counter is only built when the strategy actually routes to it ────────

describe('lazy construction', () => {
  it('does not build a TiktokenCounter just to construct the hybrid counter', () => {
    const hybrid = new HybridTokenCounter({ catalog: new ModelCatalog() });
    expect((hybrid as unknown as { _tiktoken?: unknown })._tiktoken).toBeUndefined();
  });

  it('falls back to the heuristic without ever touching tiktoken when no catalog entry matches', async () => {
    const hybrid = new HybridTokenCounter({ catalog: new ModelCatalog() });
    const n = await hybrid.measure('hello world', { provider: 'openai', model: 'nope' });
    expect(n).toBeGreaterThan(0);
    expect((hybrid as unknown as { _tiktoken?: unknown })._tiktoken).toBeUndefined();
  });
});

// ─── The error a consumer sees when they never installed the peer ─────────────

describe('missing-peer error', () => {
  it('names the package, how to install it, and the alternative', () => {
    const cause = new Error('Cannot find module "tiktoken"');
    const err = tiktokenUnavailableError(cause);
    expect(err.message).toContain('tiktoken');
    expect(err.message).toContain('npm i tiktoken');
    expect(err.message).toContain('heuristic');
    expect(err.cause).toBe(cause);
  });
});

// ─── And it still works for consumers who DO install it ───────────────────────

describe('exact counting when the peer is present', () => {
  it('counts tokens through the real tiktoken encoder', async () => {
    const counter = new TiktokenCounter();
    const n = await counter.measure('hello world', { provider: 'openai', model: 'gpt-4o' });
    // Exact tokenizer: "hello world" is 2 tokens under o200k_base.
    expect(n).toBe(2);
  });

  it('caches the encoder across calls', async () => {
    const counter = new TiktokenCounter();
    const a = await counter.measure('the quick brown fox', { provider: 'openai', model: 'gpt-4o' });
    const b = await counter.measure('the quick brown fox', { provider: 'openai', model: 'gpt-4o' });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });
});
