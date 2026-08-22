/** The extracted request builders must stay identical to what the methods send.
 *
 *  B3 split request construction out of the methods that fetch and parse, so a
 *  request can be built and asserted without performing it. That is only worth
 *  anything if the two cannot drift: a builder nobody calls would rot silently,
 *  and a method that quietly assembles something else would make every
 *  assertion a lie.
 *
 *  So each case builds the request directly AND drives the real method against a
 *  fetch that captures what it sends, then requires them to be identical.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleMediaAdapter } from '../../../../src/llm/providers/google/media';
import { OpenAIMediaAdapter } from '../../../../src/llm/providers/openai/media';

const K = 'k';
const google = new GoogleMediaAdapter({ apiKey: K });
const openai = new OpenAIMediaAdapter({ apiKey: K });

const SRC = { type: 'base64', mimeType: 'image/png', data: 'AAAA' } as const;

/** Capture the first request a method sends, answering with a body shaped
 *  enough for the parse step not to throw. */
async function captured(run: (f: any) => Promise<unknown>): Promise<any> {
  const seen: any[] = [];
  const fetch = (async (r: any) => {
    seen.push(r);
    return {
      status: 200,
      headers: {},
      body: {
        predictions: [{ bytesBase64Encoded: 'AAAA', mimeType: 'image/png' }],
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] } }],
        data: [{ b64_json: 'AAAA' }],
        name: 'op/1',
        id: 'vid_1',
      },
    };
  }) as any;
  try {
    await run(fetch);
  } catch {
    /* the stub response may not satisfy the parse step; the request is captured first */
  }
  return seen[0];
}

describe('media request builders match what the methods send', () => {
  const cases: { name: string; build: () => any; run: (f: any) => Promise<unknown> }[] = [
    {
      name: 'google imagen generateImage',
      build: () => google.buildImageRequest({ provider: 'google', model: 'imagen-4.0-generate-001', prompt: 'a cat', params: { n: 2, aspectRatio: '16:9' } } as any),
      run: (f) => google.generateImage({ provider: 'google', model: 'imagen-4.0-generate-001', prompt: 'a cat', params: { n: 2, aspectRatio: '16:9' } } as any, f),
    },
    {
      name: 'google gemini generateImage',
      build: () => google.buildImageRequest({ provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'a dog', params: { imageSize: '1K' } } as any),
      run: (f) => google.generateImage({ provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'a dog', params: { imageSize: '1K' } } as any, f),
    },
    {
      name: 'google editImage',
      build: () => google.buildEditImageRequest({ provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'bluer', sourceImage: SRC } as any),
      run: (f) => google.editImage({ provider: 'google', model: 'gemini-2.5-flash-image', prompt: 'bluer', sourceImage: SRC } as any, f),
    },
    {
      name: 'google generateAudio',
      build: () => google.buildAudioRequest({ provider: 'google', model: 'gemini-2.5-flash-preview-tts', input: 'hello', params: { voice: 'Puck' } } as any),
      run: (f) => google.generateAudio({ provider: 'google', model: 'gemini-2.5-flash-preview-tts', input: 'hello', params: { voice: 'Puck' } } as any, f),
    },
    {
      name: 'google submitVideo',
      build: () => google.buildVideoRequest({ provider: 'google', model: 'veo-3.1-generate-preview', prompt: 'a river', sourceImage: SRC, params: { duration: 8 } } as any),
      run: (f) => google.submitVideo({ provider: 'google', model: 'veo-3.1-generate-preview', prompt: 'a river', sourceImage: SRC, params: { duration: 8 } } as any, f),
    },
    {
      name: 'openai generateImage (gpt-image)',
      build: () => openai.buildGenerateImageRequest({ provider: 'openai', model: 'gpt-image-1', prompt: 'a cat', params: { n: 2, size: '1024x1024' } } as any),
      run: (f) => openai.generateImage({ provider: 'openai', model: 'gpt-image-1', prompt: 'a cat', params: { n: 2, size: '1024x1024' } } as any, f),
    },
    {
      name: 'openai generateImage (dall-e, legacy response_format)',
      build: () => openai.buildGenerateImageRequest({ provider: 'openai', model: 'dall-e-3', prompt: 'a cat' } as any),
      run: (f) => openai.generateImage({ provider: 'openai', model: 'dall-e-3', prompt: 'a cat' } as any, f),
    },
    {
      name: 'openai editImage',
      build: () => openai.buildEditImageRequest({ provider: 'openai', model: 'gpt-image-1', prompt: 'bluer', sourceImage: SRC, mask: SRC } as any),
      run: (f) => openai.editImage({ provider: 'openai', model: 'gpt-image-1', prompt: 'bluer', sourceImage: SRC, mask: SRC } as any, f),
    },
    {
      name: 'openai generateAudio',
      build: () => openai.buildAudioRequest({ provider: 'openai', model: 'tts-1', input: 'hi', params: { voice: 'nova', format: 'wav' } } as any, 'tts-1'),
      run: (f) => openai.generateAudio({ provider: 'openai', model: 'tts-1', input: 'hi', params: { voice: 'nova', format: 'wav' } } as any, f),
    },
    {
      name: 'openai submitVideo',
      build: () => openai.buildVideoRequest({ provider: 'openai', model: 'sora-2', prompt: 'a river', params: { duration: 8 } } as any),
      run: (f) => openai.submitVideo({ provider: 'openai', model: 'sora-2', prompt: 'a river', params: { duration: 8 } } as any, f),
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const sent = await captured(c.run);
      const built = c.build();
      expect(sent).toBeDefined();
      expect({ url: sent.url, method: sent.method, headers: sent.headers, body: sent.body }).toEqual({
        url: built.url,
        method: built.method,
        headers: built.headers,
        body: built.body,
      });
    });
  }
});
