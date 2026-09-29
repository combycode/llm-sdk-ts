/** Refusing a model the catalog has MEASURED as unreachable — and the one door
 *  left open.
 *
 *  The rule reads the naming, but what it tracks is the difference between "we
 *  cannot reach it" and "it is gone":
 *
 *  `imagen-4` is our slug. Asking by it means "give me whatever the catalog
 *  calls this", so the catalog's answer applies — and its answer is that the
 *  `:predict` endpoint is Enterprise-only. `imagen-4.0-generate-001` is Google's
 *  own id; typing it means you went looking for that name, and the likeliest
 *  reason is a deployment where it answers. We measured it gone for US; we
 *  cannot measure it gone for everyone. The same distinction `resolveModelId`
 *  already draws between a slug and a provider-accepted id.
 *
 *  `sora-2` gets no door, because its slug and provider id are the same string
 *  AND its endpoint shut down on an announced date. There is nobody for whom it
 *  still answers. */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { HookBus } from '../../../src/bus/hook-bus';
import { createEngine } from '../../../src/helpers/engine';
import { createMediaOutput } from '../../../src/helpers/media';
import { MediaOutput } from '../../../src/plugins/media/output';
import { MemoryMediaStore } from '../../../src/plugins/media/memory-store';

const catalog = ModelCatalog.withProviderDefaults();

describe('refuseCall: asking by our slug', () => {
  it.each(['imagen-4', 'imagen-4-fast', 'imagen-4-ultra'])('refuses %s', (model) => {
    const r = catalog.refuseCall('google', model);
    expect(r).toBeTruthy();
    expect(r).toContain('Enterprise');
  });

  it('names the provider id as the way through', () => {
    const r = catalog.refuseCall('google', 'imagen-4');
    expect(r).toContain('imagen-4.0-generate-001');
  });

  it('refuses sora-2, and offers no way through', () => {
    const r = catalog.refuseCall('openai', 'sora-2');
    expect(r).toBeTruthy();
    expect(r).toContain('2026-09-24');
    // No escape: the slug IS the provider id, and the endpoint is gone for all.
    expect(r).not.toContain('name the provider');
  });
});

describe("refuseCall: asking by the provider's own id", () => {
  it.each([
    'imagen-4.0-generate-001',
    'imagen-4.0-fast-generate-001',
    'imagen-4.0-ultra-generate-001',
  ])('lets %s through as a deliberate choice', (model) => {
    expect(catalog.refuseCall('google', model)).toBeNull();
  });
});

describe('refuseCall: everything else', () => {
  it('says nothing about a model that works', () => {
    expect(catalog.refuseCall('google', 'gemini-3.1-flash-image')).toBeNull();
  });

  it('says nothing about a model it has never heard of', () => {
    expect(catalog.refuseCall('google', 'not-a-model-at-all')).toBeNull();
  });

  it('is a POLICY on top of unavailableReason, which still reports the fact', () => {
    // The knowledge and the decision are separate: the provider id overrides the
    // decision, never the measurement.
    expect(catalog.unavailableReason('google', 'imagen-4.0-generate-001')).toBeTruthy();
    expect(catalog.refuseCall('google', 'imagen-4.0-generate-001')).toBeNull();
  });
});

// ─── the seam: that the media surface actually asks ──────────────────────────
//
// Everything above tests the catalog. None of it would notice if the call were
// removed from generateImage, which is the thing a caller actually reaches.

describe('MediaOutput refuses before it spends anything', () => {
  const rig = () => {
    const calls: string[] = [];
    const out = new MediaOutput({
      hooks: new HookBus(),
      mediaStore: new MemoryMediaStore(),
      fetch: async () => {
        calls.push('fetch');
        return { status: 200, headers: {}, body: {} };
      },
      catalog,
    });
    out.registerProvider('google', {
      name: 'google',
      capabilities: () => ({
        imageGeneration: true,
        imageEditing: true,
        audioGeneration: true,
        videoGeneration: false,
        audioStreaming: false,
      }),
      generateImage: async () => {
        calls.push('adapter');
        return [{ data: new Uint8Array([1]), mimeType: 'image/png' }];
      },
      generateAudio: async () => ({ data: new Uint8Array([1]), mimeType: 'audio/mp3' }),
    });
    return { out, calls };
  };

  it('throws the refusal for our slug, without reaching the adapter', async () => {
    const { out, calls } = rig();
    await expect(
      out.generateImage({ provider: 'google', model: 'imagen-4', prompt: 'x' }),
    ).rejects.toThrow(/Enterprise/);
    expect(calls).toEqual([]);
  });

  it("goes ahead when the caller names the provider's own id", async () => {
    const { out, calls } = rig();
    await out.generateImage({
      provider: 'google',
      model: 'imagen-4.0-generate-001',
      prompt: 'x',
    });
    expect(calls).toContain('adapter');
  });

  it('leaves a model with nothing against it alone', async () => {
    const { out, calls } = rig();
    await out.generateImage({ provider: 'google', model: 'gemini-3.1-flash-image', prompt: 'x' });
    expect(calls).toContain('adapter');
  });
});

// ─── and through the door a caller actually walks in by ──────────────────────
//
// `createMediaOutput` translates our slug into the provider's own id before the
// request reaches MediaOutput — and that id is precisely what the refusal lets
// through. Asking after the translation is asking about a spelling the caller
// never used, so every refusal above passed while the public path refused
// nothing. The tests above would not have noticed: they hold MediaOutput itself.

describe('createMediaOutput refuses on what the caller wrote', () => {
  const engine = createEngine({
    registerAsDefault: false,
    apiKeys: { google: 'k' },
  });

  // Thrown synchronously, like this handle's existing `requireProvider` check:
  // the request is refused before there is a request to reject.
  it('refuses our slug, before it is rewritten to the provider id', () => {
    const media = createMediaOutput({
      engine,
      model: 'google/imagen-4',
      store: new MemoryMediaStore(),
    });
    expect(() => media.generateImage({ prompt: 'x' })).toThrow(/Enterprise/);
  });

  it("still lets the provider's own id through", () => {
    const media = createMediaOutput({
      engine,
      model: 'google/imagen-4.0-generate-001',
      store: new MemoryMediaStore(),
    });
    // It gets past the refusal and fails later, on the network — which is the
    // point: the decision is no longer what stops it.
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = media.generateImage({ prompt: 'x' });
    }).not.toThrow();
    promise?.catch(() => {});
  });
});
