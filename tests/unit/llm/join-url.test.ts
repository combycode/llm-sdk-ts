/** Joining a base URL to a path without destroying the base's query string.
 *
 *  `base + path` is correct for every base this library SHIPS, because each is
 *  only a host. It is wrong for the one shape callers configure by hand — an
 *  Azure-style endpoint carrying `?api-version=…`:
 *
 *      'https://x.openai.azure.com/openai?api-version=2026-05-01' + '/v1/responses'
 *      -> '…/openai?api-version=2026-05-01/v1/responses'
 *
 *  The path has become part of the `api-version` VALUE. The request reaches the
 *  base path with a nonsense version, and the error that comes back is about the
 *  version — so the only clue points at the wrong thing.
 *
 *  The realtime half of the same fault was worse than a bad join: the OpenAI
 *  realtime adapter ACCEPTED a `baseURL`, handed it to the spec, and the spec
 *  never read it. A caller who configured one got silence and the default host.
 *  Google's realtime adapter has always honoured its own.
 */

import { describe, expect, it } from 'bun:test';
import { joinUrl, wsUrl } from '../../../src/llm/join-url';
import { OpenAIRealtimeAdapter } from '../../../src/llm/providers/openai/realtime';

const AZURE = 'https://x.openai.azure.com/openai?api-version=2026-05-01';

describe('joinUrl', () => {
  it('puts the path before the query, not inside its value', () => {
    expect(joinUrl(AZURE, '/v1/responses')).toBe(
      'https://x.openai.azure.com/openai/v1/responses?api-version=2026-05-01',
    );
  });

  it('behaves exactly like concatenation for a plain host', () => {
    // The regression that matters: every shipped base is this shape, so this path
    // carries all existing traffic.
    expect(joinUrl('https://api.openai.com', '/v1/responses')).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(joinUrl('https://api.anthropic.com', '/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('collapses a doubled slash', () => {
    // The two halves come from different places — our adapter's constant and the
    // caller's config — so neither can know what the other ended with, and `//` is
    // a different path to a strict router.
    expect(joinUrl('https://host/', '/v1/x')).toBe('https://host/v1/x');
    expect(joinUrl('https://host', '/v1/x')).toBe('https://host/v1/x');
    expect(joinUrl('https://host/', 'v1/x')).toBe('https://host/v1/x');
  });

  it('keeps a multi-parameter query whole', () => {
    expect(joinUrl('https://h/p?a=1&b=2', '/x')).toBe('https://h/p/x?a=1&b=2');
  });

  it('returns base plus query untouched when the path is empty', () => {
    expect(joinUrl('https://h/p?a=1', '')).toBe('https://h/p?a=1');
  });

  it('drops a fragment rather than carrying it into the middle', () => {
    // `#x` is never sent to a server, and keeping it mid-URL would move it
    // somewhere it means even less.
    expect(joinUrl('https://h/p?a=1#frag', '/x')).toBe('https://h/p/x?a=1');
  });
});

describe('wsUrl', () => {
  it('switches the scheme and merges the parameters into the base query', () => {
    // The three faults at once: scheme, path-before-query, and `model` MERGING
    // rather than starting a second `?`.
    expect(wsUrl(AZURE, '/realtime', { model: 'gpt-realtime' })).toBe(
      'wss://x.openai.azure.com/openai/realtime?api-version=2026-05-01&model=gpt-realtime',
    );
  });

  it('produces exactly the GA URL from the default host', () => {
    // What the frozen service corpus pins. If this changed, every realtime
    // session would move.
    expect(wsUrl('https://api.openai.com', '/v1/realtime', { model: 'gpt-realtime' })).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    );
  });

  it('maps each scheme to its websocket twin, and leaves ws alone', () => {
    // `https` -> `wss` and `http` -> `ws`: a plain `ws` from an `https` base would
    // be an unencrypted socket to an encrypted endpoint.
    expect(wsUrl('https://h', '/x')).toBe('wss://h/x');
    expect(wsUrl('http://h', '/x')).toBe('ws://h/x');
    expect(wsUrl('wss://h', '/x', { a: '1' })).toBe('wss://h/x?a=1');
    expect(wsUrl('ws://h', '/x')).toBe('ws://h/x');
  });

  it('drops an undefined parameter instead of sending it empty', () => {
    // A provider that validates its query rejects `model=` differently from an
    // absent `model`, and absent is what "not specified" means.
    expect(wsUrl('https://h', '/x', { model: undefined })).toBe('wss://h/x');
  });

  it('overrides a parameter the base already carried', () => {
    expect(wsUrl('https://h?model=old', '/x', { model: 'new' })).toBe('wss://h/x?model=new');
  });
});

describe('the OpenAI realtime adapter honours its baseURL', () => {
  const connect = (over: { baseURL?: string } = {}) =>
    new OpenAIRealtimeAdapter({ apiKey: 'k', ...over }).buildConnectRequest({
      model: 'gpt-realtime',
    } as never).url;

  it('still produces the GA URL by default', () => {
    expect(connect()).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
  });

  it('uses a configured host instead of ignoring it', () => {
    // Before this, `baseURL` was accepted, passed to the spec, and never read —
    // the caller got no error and the default host.
    expect(connect({ baseURL: 'https://gateway.internal' })).toBe(
      'wss://gateway.internal/v1/realtime?model=gpt-realtime',
    );
  });

  it('survives a host that carries its own query', () => {
    expect(connect({ baseURL: AZURE })).toBe(
      'wss://x.openai.azure.com/openai/v1/realtime?api-version=2026-05-01&model=gpt-realtime',
    );
  });
});
