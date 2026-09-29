/** xAI image `quality`, and the limit of what a status code can prove.
 *
 *  The xAI SDK says: "Allowed values are `low` and `medium`. When omitted, the
 *  default is `medium`. The parameter is only supported for
 *  `grok-imagine-image-2.0`."
 *
 *  The published OpenAPI has no `quality` on `GenerateImageRequest` at all, so
 *  the spec's silence is not evidence — it lags its own SDK. And the WIRE is
 *  wider than the SDK's claim: measured 2026-09-29, `quality: "ultra"` is
 *  refused 422 "Failed to deserialize the JSON body into the target type:
 *  quality: unknown variant" on EVERY imagine model, because that is the request
 *  body being parsed before any model dispatch. A 200 on another model therefore
 *  says the schema accepts the field, not that the model honours it.
 *
 *  So the catalog records the narrower, documented claim, and the wire carries
 *  the field whenever a caller asks for it. */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { XAIMediaAdapter } from '../../../src/llm/providers/xai/media';

const adapter = new XAIMediaAdapter({ apiKey: 'k' });

const body = (params: Record<string, unknown>, model = 'grok-imagine-image-2.0') =>
  adapter.buildImageRequest({ prompt: 'a cube', model, params } as never).body as Record<
    string,
    unknown
  >;

describe('the quality parameter reaches the wire', () => {
  it.each(['low', 'medium'])('sends %s', (quality) => {
    expect(body({ quality }).quality).toBe(quality);
  });

  it('omits the field entirely when the caller asks for nothing', () => {
    // Not `quality: undefined` and not a defaulted value: leaving it out is what
    // lets xAI apply its own default, which is `medium`.
    expect('quality' in body({})).toBe(false);
  });

  it('leaves the other image fields alone', () => {
    const b = body({ quality: 'low', aspectRatio: '16:9', resolution: '2k' });
    expect(b.aspect_ratio).toBe('16:9');
    expect(b.resolution).toBe('2k');
    expect(b.model).toBe('grok-imagine-image-2.0');
  });
});

describe('the catalog records only the documented support', () => {
  const catalog = ModelCatalog.withProviderDefaults();

  it('offers quality on grok-imagine-image-2.0', () => {
    const q = catalog.get('xai', 'grok-imagine-image-2.0')?.mediaParams?.quality;
    expect(q?.values).toEqual(['low', 'medium']);
    expect(q?.default).toBe('medium');
  });

  it.each(['grok-imagine-image', 'grok-imagine-image-quality'])(
    'does not offer it on %s, which the SDK says lacks it',
    (model) => {
      expect(catalog.get('xai', model)?.mediaParams?.quality).toBeUndefined();
    },
  );

  it('still records the resolution vocabulary on all of them', () => {
    for (const model of ['grok-imagine-image', 'grok-imagine-image-2.0']) {
      expect(catalog.get('xai', model)?.mediaParams?.resolution?.values).toContain('1.5k');
    }
  });
});
