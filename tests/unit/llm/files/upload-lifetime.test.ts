/** Asking a provider to delete an uploaded file after N seconds.
 *
 *  It exists because files do NOT clean themselves up: OpenAI states that
 *  everything but `purpose=batch` "persists until manually deleted", so an agent
 *  attaching a document per turn grows an unbounded pile on the customer's
 *  account.
 *
 *  Every shape below was MEASURED on 2026-09-29, and two of the three would have
 *  been wrong if guessed:
 *
 *    anthropic  expires_in_seconds: 3600                      -> 200
 *    openai     expires_after[anchor] + expires_after[seconds] -> 200
 *               the same value as a JSON string               -> 400
 *    xai        expires_after: 3600, placed BEFORE the file   -> 200
 *               the same field placed after the file          -> 400
 *    google     no such field: expiration_time is "Output only"
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicFileAdapter } from '../../../../src/llm/providers/anthropic/files';
import { OpenAIFileAdapter } from '../../../../src/llm/providers/openai/files';
import { XAIFileAdapter } from '../../../../src/llm/providers/xai/files';
import { GoogleFileAdapter } from '../../../../src/llm/providers/google/files';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { EngineFetch } from '../../../../src/network/types';
import type {
  FileProviderAdapter,
  FileUploadOptions,
} from '../../../../src/plugins/files/provider-adapter';
import { FilesRegistry } from '../../../../src/plugins/files/registry';

const noopFetch: EngineFetch = async () => ({ status: 200, headers: {}, body: {} });

const cfg = { apiKey: 'k' };
const file = {
  filename: 'a.txt',
  mimeType: 'text/plain',
  toBuffer: async () => new Uint8Array([1]),
} as never;
const data = new Uint8Array([1]);

const fields = (req: { body: unknown }): string[] =>
  req.body instanceof FormData ? [...req.body.keys()] : Object.keys((req.body as object) ?? {});

describe('anthropic: a plain scalar', () => {
  const a = new AnthropicFileAdapter(cfg);

  it('sends expires_in_seconds when asked', () => {
    expect(fields(a.buildUploadRequest(file, data, { lifetimeSeconds: 3600 }))).toContain(
      'expires_in_seconds',
    );
  });

  it('omits it entirely when not asked, which is the provider default', () => {
    expect(fields(a.buildUploadRequest(file, data))).not.toContain('expires_in_seconds');
  });
});

describe('openai: a bracket pair, not a JSON string', () => {
  const o = new OpenAIFileAdapter(cfg);

  it('sends both halves when asked', async () => {
    const f = fields(await o.buildUploadRequest(file, data, { lifetimeSeconds: 3600 }));
    expect(f).toContain('expires_after[anchor]');
    expect(f).toContain('expires_after[seconds]');
  });

  it('sends neither when not asked', async () => {
    const f = fields(await o.buildUploadRequest(file, data));
    expect(f.some((k) => k.startsWith('expires_after'))).toBe(false);
  });
});

describe('xai: before the file, and the order is the contract', () => {
  const x = new XAIFileAdapter(cfg);

  /** `expires_after` after the file is refused 400 with the reason spelled out:
   *  "expires_after must appear before the file field". */
  it('places expires_after ahead of the file part', async () => {
    const f = fields(await x.buildUploadRequest(file, data, { lifetimeSeconds: 3600 }));
    expect(f.indexOf('expires_after')).toBeGreaterThanOrEqual(0);
    expect(f.indexOf('expires_after')).toBeLessThan(f.indexOf('file'));
  });

  it('omits it when not asked, leaving the order untouched', async () => {
    const f = fields(await x.buildUploadRequest(file, data));
    expect(f).not.toContain('expires_after');
    expect(f[0]).toBe('file');
  });
});

describe('google: cannot honour it, and says so', () => {
  it('warns rather than dropping the request silently', async () => {
    const warnings: string[] = [];
    const g = new GoogleFileAdapter(cfg);
    // The upload itself will fail on the stub fetch; the warning fires first,
    // which is the whole point — the caller learns before anything else happens.
    await g
      .upload(file, (async () => ({ status: 500, headers: {}, body: {} })) as never, {
        lifetimeSeconds: 3600,
        warn: (m) => warnings.push(m),
      })
      .catch(() => undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3600');
    expect(warnings[0]).toContain('expiration_time');
  });

  it('says nothing when no lifetime was asked for', async () => {
    const warnings: string[] = [];
    const g = new GoogleFileAdapter(cfg);
    await g
      .upload(file, (async () => ({ status: 500, headers: {}, body: {} })) as never, {
        warn: (m) => warnings.push(m),
      })
      .catch(() => undefined);
    expect(warnings).toEqual([]);
  });
});

// ─── the seam between the config and the wire ────────────────────────────────

describe('FilesRegistry threads the configured lifetime to the adapter', () => {
  const add = (reg: FilesRegistry) =>
    reg.add({
      filename: 'a.txt',
      mimeType: 'text/plain',
      content: { type: 'base64', mimeType: 'text/plain', data: btoa('hi') },
    });

  const spyAdapter = (seen: { opts?: FileUploadOptions }): FileProviderAdapter => ({
    name: 'spy',
    expiresAfter: null,
    maxFileSize: 100_000_000,
    supportedTypes: null,
    upload: async (_f, _fetch, opts) => {
      seen.opts = opts;
      return { remoteId: 'remote_1', expiresAt: null };
    },
    delete: async () => {},
    getInfo: async () => null,
    list: async () => [],
  });

  it('passes what the caller configured, not what the adapter defaults to', async () => {
    const seen: { opts?: FileUploadOptions } = {};
    const reg = new FilesRegistry({
      hooks: new HookBus(),
      fetch: noopFetch,
      uploadLifetimeSeconds: 3600,
    });
    reg.registerProvider('spy', spyAdapter(seen));
    await reg.upload(add(reg).id, 'spy');
    expect(seen.opts?.lifetimeSeconds).toBe(3600);
  });

  it('leaves it undefined when nothing was configured', async () => {
    const seen: { opts?: FileUploadOptions } = {};
    const reg = new FilesRegistry({ hooks: new HookBus(), fetch: noopFetch });
    reg.registerProvider('spy', spyAdapter(seen));
    await reg.upload(add(reg).id, 'spy');
    expect(seen.opts?.lifetimeSeconds).toBeUndefined();
  });

  it("surfaces an adapter's warn as onWarning, naming the file and provider", async () => {
    const seen: { opts?: FileUploadOptions } = {};
    const hooks = new HookBus();
    const warnings: Array<Record<string, unknown>> = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w as unknown as Record<string, unknown>);
    });
    const reg = new FilesRegistry({ hooks, fetch: noopFetch, uploadLifetimeSeconds: 60 });
    reg.registerProvider('spy', spyAdapter(seen));
    const id = add(reg).id;
    await reg.upload(id, 'spy');

    seen.opts?.warn?.('cannot honour it', { requestedLifetimeSeconds: 60 });
    const adjusted = warnings.find((w) => w.code === 'request_adjusted');
    expect(adjusted?.message).toBe('cannot honour it');
    expect(adjusted?.details).toMatchObject({ fileId: id, provider: 'spy' });
  });
});
