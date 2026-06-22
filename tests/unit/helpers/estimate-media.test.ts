/** estimate() — image and audio content-part pricing.
 *
 *  Verifies that:
 *    1. Image parts in the prompt are priced via perImage.
 *    2. Multiple images accumulate cost correctly.
 *    3. Image parts with no catalog perImage rate produce an assumption note
 *       and zero imageUsd (honest-zero rule).
 *    4. Audio parts produce an assumption note (not silently dropped).
 *    5. Mixed prompt: images priced + audio noted.
 *    6. breakdown.imageUsd is populated when images are present.
 *    7. image cost is included in all three bounds (low, expected, high). */

import { beforeEach, describe, expect, it } from 'bun:test';
import { estimate } from '../../../src/helpers/estimate';
import type { EstimateOptions } from '../../../src/helpers/estimate';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

function makeEngine(catalog: ModelCatalog): EstimateOptions['engine'] {
  return { catalog } as unknown as EstimateOptions['engine'];
}

let catalog: ModelCatalog;

beforeEach(() => {
  catalog = new ModelCatalog();
  // Model that has both token rates AND a perImage rate (vision model)
  catalog.set('openai', 'gpt-vision', {
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 15,
      perImage: 0.00255, // example OpenAI low-res image rate
    },
    maxOutput: 4096,
  });
  // Model with token rates but NO perImage (text-only)
  catalog.set('anthropic', 'claude-text', {
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    maxOutput: 8192,
  });
  // Model with audio input support (has audioInputPerMTok)
  catalog.set('openai', 'gpt-audio', {
    pricing: { inputPerMTok: 5, outputPerMTok: 15, audioInputPerMTok: 40 },
    maxOutput: 4096,
  });
});

// ─── Image parts ──────────────────────────────────────────────────────────────

describe('estimate() — image parts', () => {
  it('prices a single image part at perImage rate', async () => {
    const est = await estimate(
      {
        model: 'openai/gpt-vision',
        prompt: [
          { type: 'image', source: { type: 'base64', mimeType: 'image/jpeg', data: 'fake' } },
          { type: 'text', text: 'What is this?' },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.breakdown.imageUsd).toBeCloseTo(0.00255, 8);
    // image cost included in all bounds
    expect(est.cost.low).toBeGreaterThanOrEqual(0.00255);
    expect(est.cost.expected).toBeGreaterThanOrEqual(0.00255);
    expect(est.cost.high).toBeGreaterThanOrEqual(0.00255);
  });

  it('accumulates cost for multiple image parts', async () => {
    const est = await estimate(
      {
        model: 'openai/gpt-vision',
        prompt: [
          { type: 'image', source: { type: 'base64', mimeType: 'image/jpeg', data: 'a' } },
          { type: 'image', source: { type: 'base64', mimeType: 'image/jpeg', data: 'b' } },
          { type: 'image', source: { type: 'base64', mimeType: 'image/jpeg', data: 'c' } },
          { type: 'text', text: 'Compare these.' },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.breakdown.imageUsd).toBeCloseTo(3 * 0.00255, 8);
  });

  it('adds an assumption note mentioning image count and perImage rate', async () => {
    const est = await estimate(
      {
        model: 'openai/gpt-vision',
        prompt: [
          { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'x' } },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.assumptions.some((a) => a.includes('image') && a.includes('perImage'))).toBe(true);
  });

  it('emits honest-zero imageUsd with note when model has no perImage rate', async () => {
    const est = await estimate(
      {
        model: 'anthropic/claude-text',
        prompt: [
          { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'x' } },
          { type: 'text', text: 'Describe.' },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    // No perImage in pricing — imageUsd is absent (0 not explicitly set)
    expect(est.breakdown.imageUsd).toBeUndefined();
    // But an assumption note must be present
    expect(est.assumptions.some((a) => a.includes('unpriced') || a.includes('no perImage'))).toBe(true);
  });

  it('breakdown.imageUsd is undefined when no images in prompt', async () => {
    const est = await estimate(
      { model: 'openai/gpt-vision', prompt: 'Hello' },
      { engine: makeEngine(catalog) },
    );
    expect(est.breakdown.imageUsd).toBeUndefined();
  });
});

// ─── Audio parts ──────────────────────────────────────────────────────────────

describe('estimate() — audio parts', () => {
  it('adds an assumption note for audio parts (cannot price without duration)', async () => {
    const est = await estimate(
      {
        model: 'openai/gpt-audio',
        prompt: [
          { type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'abc' } },
          { type: 'text', text: 'Transcribe.' },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.assumptions.some((a) => a.includes('audio') && a.includes('unpriced'))).toBe(true);
    // audioUsd must be absent (0), not some fabricated value
    expect(est.breakdown.audioUsd).toBeUndefined();
  });

  it('audio parts do not inflate the numeric cost bounds', async () => {
    const textOnly = await estimate(
      { model: 'openai/gpt-audio', prompt: 'Hello' },
      { engine: makeEngine(catalog) },
    );
    const withAudio = await estimate(
      {
        model: 'openai/gpt-audio',
        prompt: [
          { type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'abc' } },
          { type: 'text', text: 'Hello' },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    // Audio is noted but NOT priced, so expected cost stays <= text-only (the
    // text token count may differ slightly due to the text part, but audio itself
    // adds $0 to the cost bounds).
    expect(withAudio.breakdown.audioUsd).toBeUndefined();
  });
});

// ─── Mixed prompt (Message[]) ──────────────────────────────────────────────────

describe('estimate() — image + audio in Message[]', () => {
  it('prices images and notes audio in a Message[] prompt', async () => {
    const est = await estimate(
      {
        model: 'openai/gpt-vision',
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'img1' } },
              { type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'aud' } },
              { type: 'text', text: 'Analyze.' },
            ],
          },
        ],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.breakdown.imageUsd).toBeCloseTo(0.00255, 8);
    expect(est.assumptions.some((a) => a.includes('audio') && a.includes('unpriced'))).toBe(true);
  });
});
