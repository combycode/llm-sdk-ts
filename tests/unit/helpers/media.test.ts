/** createMediaOutput key resolution — direct apiKey vs engine.apiKeys, matching
 *  the other helpers (complete/embed/transcribe/...). */

import { afterAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { createMediaOutput } from '../../../src/helpers/media';
import { MemoryMediaStore } from '../../../src/plugins/media/memory-store';

const DIR = 'tests/.tmp-media';
afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

describe('createMediaOutput key resolution', () => {
  it('accepts a direct apiKey (no engine needed)', () => {
    expect(() =>
      createMediaOutput({ model: 'openai/gpt-image-1', apiKey: 'sk-test', dir: DIR }),
    ).not.toThrow();
  });

  it('throws a helpful error when no key is available', () => {
    expect(() => createMediaOutput({ model: 'openai/gpt-image-1', dir: DIR })).toThrow(
      /no API key/,
    );
  });

  it('accepts a custom store (browser memory path) without a dir', () => {
    expect(() =>
      createMediaOutput({
        model: 'openai/gpt-image-1',
        apiKey: 'sk-test',
        store: new MemoryMediaStore(),
      }),
    ).not.toThrow();
  });

  it('throws when neither dir nor store is provided', () => {
    expect(() => createMediaOutput({ model: 'openai/gpt-image-1', apiKey: 'sk-test' })).toThrow(
      /dir.*store/,
    );
  });
});
