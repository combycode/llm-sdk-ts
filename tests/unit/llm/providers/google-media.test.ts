/** GoogleMediaAdapter — image/TTS routing (Imagen :predict vs gemini inline
 *  generateContent), via a fake EngineFetch that captures the request. */

import { describe, expect, it } from 'bun:test';
import { GoogleMediaAdapter } from '../../../../src/llm/providers/google/media';
import type { EngineFetch, HttpRequest } from '../../../../src/network/types';

function fakeFetch(body: unknown, capture?: (req: HttpRequest) => void): EngineFetch {
  return async (req) => {
    capture?.(req);
    return { status: 200, headers: {}, body };
  };
}
// 'aGk=' is base64 for 'hi' (2 bytes).
const B64 = 'aGk=';

describe('GoogleMediaAdapter — image routing', () => {
  const a = new GoogleMediaAdapter({ apiKey: 'k' });

  it('gemini-* image → generateContent inline with responseModalities IMAGE', async () => {
    let captured: HttpRequest | undefined;
    const res = await a.generateImage(
      { provider: 'google', model: 'gemini-3.1-flash-image', prompt: 'x' },
      fakeFetch(
        {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } },
          ],
        },
        (r) => {
          captured = r;
        },
      ),
    );
    expect(captured?.url).toContain(':generateContent');
    expect(
      (captured?.body as { generationConfig: { responseModalities: string[] } }).generationConfig
        .responseModalities,
    ).toEqual(['IMAGE']);
    expect(res[0].mimeType).toBe('image/png');
    expect(res[0].data.length).toBe(2);
  });

  it('imagen-* image → :predict endpoint, imageSize → sampleImageSize', async () => {
    let captured: HttpRequest | undefined;
    await a.generateImage(
      {
        provider: 'google',
        model: 'imagen-4.0-generate-001',
        prompt: 'x',
        params: { aspectRatio: '16:9', imageSize: '2K', n: 2 },
      },
      fakeFetch({ predictions: [{ bytesBase64Encoded: B64, mimeType: 'image/png' }] }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toContain(':predict');
    const params = (captured?.body as { parameters: Record<string, unknown> }).parameters;
    expect(params.aspectRatio).toBe('16:9');
    expect(params.sampleImageSize).toBe('2K');
    expect(params.sampleCount).toBe(2);
  });

  it('gemini image params → responseFormat.image.{aspectRatio,imageSize}', async () => {
    let captured: HttpRequest | undefined;
    await a.generateImage(
      {
        provider: 'google',
        model: 'gemini-3-pro-image',
        prompt: 'x',
        params: { aspectRatio: '21:9', imageSize: '4K' },
      },
      fakeFetch(
        { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] },
        (r) => {
          captured = r;
        },
      ),
    );
    const gc = (captured?.body as { generationConfig: { responseFormat?: { image: Record<string, unknown> } } })
      .generationConfig;
    expect(gc.responseFormat?.image).toEqual({ aspectRatio: '21:9', imageSize: '4K' });
  });

  it('captures usageMetadata (token-priced gemini image)', async () => {
    const res = await a.generateImage(
      { provider: 'google', model: 'gemini-3-pro-image', prompt: 'x' },
      fakeFetch({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1290, totalTokenCount: 1301 },
      }),
    );
    expect(res[0].usage).toEqual(
      expect.objectContaining({ inputTokens: 11, outputTokens: 1290, totalTokens: 1301 }),
    );
  });

  it('editImage adds the source image as an inline_data part', async () => {
    let captured: HttpRequest | undefined;
    await a.editImage(
      {
        provider: 'google',
        model: 'gemini-2.5-flash-image',
        prompt: 'add a hat',
        sourceImage: { type: 'base64', mimeType: 'image/jpeg', data: B64 },
      },
      fakeFetch(
        { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] },
        (r) => {
          captured = r;
        },
      ),
    );
    const parts = (captured?.body as { contents: Array<{ parts: unknown[] }> }).contents[0].parts;
    expect(parts).toEqual([
      { text: 'add a hat' },
      { inline_data: { mime_type: 'image/jpeg', data: B64 } },
    ]);
  });
});

describe('GoogleMediaAdapter — TTS', () => {
  const a = new GoogleMediaAdapter({ apiKey: 'k' });

  it('generateAudio → generateContent AUDIO + speechConfig voiceName', async () => {
    let captured: HttpRequest | undefined;
    const res = await a.generateAudio(
      {
        provider: 'google',
        model: 'gemini-2.5-flash-preview-tts',
        input: 'hello',
        params: { voice: 'Kore' },
      },
      fakeFetch(
        {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: B64 } }] } },
          ],
        },
        (r) => {
          captured = r;
        },
      ),
    );
    const gc = (captured?.body as { generationConfig: Record<string, unknown> })
      .generationConfig as {
      responseModalities: string[];
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
    };
    expect(gc.responseModalities).toEqual(['AUDIO']);
    expect(gc.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(res.data.length).toBe(2);
  });

  it('capabilities reports audioGeneration true', () => {
    expect(a.capabilities().audioGeneration).toBe(true);
  });
});
