/** checkProvenance() unit tests.
 *
 *  Stubbed engine, no network, no keys. What is pinned here:
 *
 *    - The two guards, and the ORDER they fire in: an unsupported provider is
 *      rejected before the key is looked at, so a caller who mistyped the
 *      provider is told that, not "no API key".
 *    - Key resolution: explicit `apiKey` wins, else `engine.apiKeys[provider]`,
 *      else a throw. The key must actually reach the wire as a Bearer.
 *    - The verdict is the adapter's, forwarded unchanged.
 *    - The honest-zero cost entry: this endpoint is free, and the ledger records
 *      it anyway so a reader can distinguish "free" from "never happened". That
 *      entry must NOT be emitted when the call failed. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { CostEntryContext } from '../../../src/bus/hook-map';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import { checkProvenance } from '../../../src/helpers/provenance';
import type { ProvenanceRawResponse } from '../../../src/helpers/provenance-types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FILE = new Uint8Array([1, 2, 3, 4]);

const CLEAN: ProvenanceRawResponse = {
  object: 'content_provenance_check',
  created_at: 1_700_000_000,
  results: [
    { type: 'c2pa', outcome: 'not_detected', validation_state: 'not_present' },
    { type: 'synthid', outcome: 'not_detected' },
  ],
};

const TRUSTED_C2PA: ProvenanceRawResponse = {
  created_at: 1_700_000_001,
  results: [
    {
      type: 'c2pa',
      outcome: 'detected',
      validation_state: 'trusted',
      issuer: 'OpenAI, Inc.',
      model: 'gpt-image-1',
      generated_at: '2026-01-01T00:00:00Z',
    },
  ],
};

const DETECTED_BUT_INVALID: ProvenanceRawResponse = {
  results: [{ type: 'c2pa', outcome: 'detected', validation_state: 'invalid' }],
};

interface Rig {
  engine: EngineHandle;
  entries: CostEntryContext[];
  requests: Array<Record<string, unknown>>;
}

function makeRig(
  body: ProvenanceRawResponse | (() => never),
  opts: { apiKeys?: Record<string, string> } = {},
): Rig {
  const entries: CostEntryContext[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const hooks = new HookBus();
  hooks.on('onCostEntry', (ctx) => {
    entries.push(ctx);
  });

  const fetch = async (req: Record<string, unknown>) => {
    requests.push(req);
    if (typeof body === 'function') body();
    return { status: 200, headers: {}, body };
  };

  const engine = {
    apiKeys: opts.apiKeys ?? { openai: 'engine-key' },
    catalog: new ModelCatalog(),
    hooks,
    fetch,
  } as unknown as EngineHandle;

  return { engine, entries, requests };
}

const base = { file: FILE, filename: 'photo.png', mimeType: 'image/png' };

// ─── Guards ──────────────────────────────────────────────────────────────────

describe('checkProvenance() -- guards', () => {
  it('rejects any provider other than openai', async () => {
    const { engine } = makeRig(CLEAN);
    await expect(checkProvenance({ ...base, provider: 'google', engine })).rejects.toThrow(
      /provider "google" is not supported\. Only "openai" exposes a content-provenance API/,
    );
  });

  it('rejects the unsupported provider BEFORE it looks for a key', async () => {
    // Order matters: with no key present at all, the caller must still be told
    // the real problem (the provider), not sent hunting for credentials they
    // were never going to need.
    const { engine } = makeRig(CLEAN, { apiKeys: {} });
    await expect(checkProvenance({ ...base, provider: 'anthropic', engine })).rejects.toThrow(
      /is not supported/,
    );
  });

  it('does not reach the wire when the provider is rejected', async () => {
    const { engine, requests, entries } = makeRig(CLEAN);
    await checkProvenance({ ...base, provider: 'xai', engine }).catch(() => {});
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it('throws when neither an explicit key nor an engine key is present', async () => {
    const { engine } = makeRig(CLEAN, { apiKeys: {} });
    await expect(checkProvenance({ ...base, engine })).rejects.toThrow(
      /no API key for provider "openai"\. Pass apiKey or set engine\.apiKeys\["openai"\]/,
    );
  });

  it('an explicitly-undefined apiKey still falls back to the engine', async () => {
    const { engine } = makeRig(CLEAN);
    const v = await checkProvenance({ ...base, apiKey: undefined, engine });
    expect(v.detected).toBe(false);
  });
});

// ─── Provider defaulting + key plumbing ──────────────────────────────────────

describe('checkProvenance() -- provider and key resolution', () => {
  it('defaults the provider to openai when none is given', async () => {
    const { engine, requests } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    expect(requests).toHaveLength(1);
    expect(requests[0].provider).toBe('openai');
  });

  it('accepts openai passed explicitly', async () => {
    const { engine, requests } = makeRig(CLEAN);
    await checkProvenance({ ...base, provider: 'openai', engine });
    expect(requests).toHaveLength(1);
  });

  it('sends the engine key as a Bearer when no explicit key is given', async () => {
    const { engine, requests } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    const headers = requests[0].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer engine-key');
  });

  it('an explicit apiKey overrides the engine key', async () => {
    const { engine, requests } = makeRig(CLEAN);
    await checkProvenance({ ...base, apiKey: 'caller-key', engine });
    const headers = requests[0].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer caller-key');
  });

  it('posts the file to the content-provenance endpoint', async () => {
    const { engine, requests } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    expect(requests[0].method).toBe('POST');
    expect(String(requests[0].url)).toContain('/v1/content_provenance_checks');
    expect(requests[0].model).toBe('content_provenance_check');
  });
});

// ─── The verdict ─────────────────────────────────────────────────────────────

describe('checkProvenance() -- the verdict', () => {
  it('a clean file is detected:false, trusted:false, with both signals listed', async () => {
    const { engine } = makeRig(CLEAN);
    const v = await checkProvenance({ ...base, engine });
    expect(v.detected).toBe(false);
    expect(v.trusted).toBe(false);
    // The negative signals are kept: "checked, found nothing" is not the same
    // statement as "not checked".
    expect(v.signals.map((s) => s.kind)).toEqual(['c2pa', 'synthid']);
    expect(v.createdAt).toBe(1_700_000_000);
  });

  it('a validated C2PA manifest is detected AND trusted, with its metadata', async () => {
    const { engine } = makeRig(TRUSTED_C2PA);
    const v = await checkProvenance({ ...base, engine });
    expect(v.detected).toBe(true);
    expect(v.trusted).toBe(true);
    expect(v.signals[0].issuer).toBe('OpenAI, Inc.');
    expect(v.signals[0].model).toBe('gpt-image-1');
    expect(v.signals[0].generatedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('a detected manifest that did not validate is NOT trusted', async () => {
    // The distinction the whole helper exists for: a signature being present is
    // not a signature being good.
    const { engine } = makeRig(DETECTED_BUT_INVALID);
    const v = await checkProvenance({ ...base, engine });
    expect(v.detected).toBe(true);
    expect(v.trusted).toBe(false);
  });
});

// ─── Honest-zero cost entry ──────────────────────────────────────────────────

describe('checkProvenance() -- honest-zero cost entry', () => {
  it('emits exactly one zero-cost entry per successful check', async () => {
    const { engine, entries } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    expect(entries).toHaveLength(1);
    const { entry, runningTotal } = entries[0];
    expect(entry.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      source: 'calculated',
    });
    expect(entry.tokens).toEqual({ input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 });
    expect(runningTotal).toBe(0);
  });

  it('records WHY the cost is zero, so free is distinguishable from unpriced', async () => {
    const { engine, entries } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    expect(entries[0].entry.providerEvidence.note).toBe(
      'free: content-provenance endpoint not billed',
    );
  });

  it('labels the entry so it can be found in the ledger', async () => {
    const { engine, entries } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    const { entry } = entries[0];
    expect(entry.provider).toBe('openai');
    expect(entry.model).toBe('content_provenance_check');
    expect(entry.tags).toEqual({
      provider: 'openai',
      model: 'content_provenance_check',
      type: 'provenance',
    });
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it('gives every call its own entry id', async () => {
    const { engine, entries } = makeRig(CLEAN);
    await checkProvenance({ ...base, engine });
    await checkProvenance({ ...base, engine });
    expect(entries).toHaveLength(2);
    expect(entries[0].entry.id).not.toBe(entries[1].entry.id);
  });

  it('emits NOTHING when the request fails', async () => {
    // A ledger entry for a call that never happened is worse than no entry.
    const { engine, entries } = makeRig(() => {
      throw new Error('boom');
    });
    await expect(checkProvenance({ ...base, engine })).rejects.toThrow('boom');
    expect(entries).toHaveLength(0);
  });
});
