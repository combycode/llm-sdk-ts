/** Three hardening fixes from the 2026-08-05 cycle:
 *   #4  — the stdio read buffer is bounded (mcp-ts 1.30 `maxBufferSize`)
 *   #22 — Content-Type is compared by media-type essence, not substring
 *   #7  — RFC 9207 `iss` validation + OIDC `application_type` at registration
 */

import { describe, expect, it } from 'bun:test';
import { validateAuthorizationResponseIss } from '../../../../src/plugins/mcp/oauth';
import { mediaTypeEssence } from '../../../../src/plugins/mcp/transport-http';

// ─── #7 RFC 9207: the mix-up-attack defence ──────────────────────────────────

describe('RFC 9207 iss validation', () => {
  const meta = { issuer: 'https://as.example.com', authorization_response_iss_parameter_supported: true };

  it('accepts an exact match', () => {
    expect(() => validateAuthorizationResponseIss('https://as.example.com', meta)).not.toThrow();
  });

  it('rejects a code minted by a different authorization server', () => {
    expect(() => validateAuthorizationResponseIss('https://evil.example.com', meta)).toThrow(
      /iss mismatch/,
    );
  });

  it('does NOT normalise the URL — a trailing slash is a mismatch', () => {
    // RFC 9207 §2.4 mandates simple string comparison (RFC 3986 §6.2.1). Normalising here would be
    // exactly the leniency an attacker looks for.
    expect(() => validateAuthorizationResponseIss('https://as.example.com/', meta)).toThrow(
      /iss mismatch/,
    );
  });

  it('rejects a MISSING iss when the server advertises that it sends one', () => {
    // Otherwise stripping the parameter would be enough to skip the check entirely.
    expect(() => validateAuthorizationResponseIss(undefined, meta)).toThrow(/missing the iss/);
  });

  it('allows a missing iss when the server never advertised support', () => {
    expect(() =>
      validateAuthorizationResponseIss(undefined, {
        issuer: 'https://as.example.com',
        authorization_response_iss_parameter_supported: false,
      }),
    ).not.toThrow();
  });

  it('rejects an iss when we have no issuer to compare against', () => {
    expect(() => validateAuthorizationResponseIss('https://as.example.com', {})).toThrow(
      /iss mismatch/,
    );
  });
});

// ─── #22 media-type essence ───────────────────────────────────────────────────

describe('Content-Type media-type essence', () => {
  it('matches the ordinary parameterised header', () => {
    expect(mediaTypeEssence('text/event-stream; charset=utf-8')).toBe('text/event-stream');
    expect(mediaTypeEssence('  TEXT/Event-Stream  ')).toBe('text/event-stream');
  });

  it('does not match a type that merely CONTAINS the token', () => {
    // The substring test that shipped before routed BOTH of these to the SSE parser.
    expect(mediaTypeEssence('application/json; profile="text/event-stream"')).not.toBe(
      'text/event-stream',
    );
    expect(mediaTypeEssence('application/vnd.text/event-stream+json')).not.toBe('text/event-stream');
    // ...and both are still recognised as what they actually are.
    expect(mediaTypeEssence('application/json; profile="text/event-stream"')).toBe('application/json');
  });

  it('handles a bare type and an empty header', () => {
    expect(mediaTypeEssence('application/json')).toBe('application/json');
    expect(mediaTypeEssence('')).toBe('');
  });
});

// ─── #4 stdio buffer bound ────────────────────────────────────────────────────

describe('stdio read buffer', () => {
  it('bounds a single unterminated line at 10 MB by default', async () => {
    const { StdioTransport } = await import('../../../../src/plugins/mcp/transport-stdio');
    const transport = new StdioTransport({ command: 'noop' });
    // Default comes from the transport, not the caller.
    expect((transport as unknown as { maxBufferSize: number }).maxBufferSize).toBe(10 * 1024 * 1024);
  });

  it('honours an explicit maxBufferSize and fails the pending requests on overflow', async () => {
    const { StdioTransport } = await import('../../../../src/plugins/mcp/transport-stdio');
    const transport = new StdioTransport({ command: 'noop' }, { maxBufferSize: 64 });

    let failed: unknown;
    (transport as unknown as { pending: Map<number, unknown> }).pending.set(1, {
      resolve: () => {},
      reject: (e: unknown) => {
        failed = e;
      },
      timer: setTimeout(() => {}, 0),
    });

    // A server that never emits a newline: the unbounded case this guards.
    (transport as unknown as { onData(c: string): void }).onData('x'.repeat(100));

    expect(failed).toBeDefined();
    expect(String((failed as Error).message)).toMatch(/no newline/);
    // The buffer is dropped, otherwise the next chunk would re-trigger immediately.
    expect((transport as unknown as { buffer: string }).buffer).toBe('');
  });

  it('does not trip on a large burst of COMPLETE lines', async () => {
    const { StdioTransport } = await import('../../../../src/plugins/mcp/transport-stdio');
    const transport = new StdioTransport({ command: 'noop' }, { maxBufferSize: 64 });

    let failed = false;
    (transport as unknown as { pending: Map<number, unknown> }).pending.set(1, {
      resolve: () => {},
      reject: () => {
        failed = true;
      },
      timer: setTimeout(() => {}, 0),
    });

    // 400 bytes total, but every line is terminated — the limit is about a single unbounded line.
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x' })}\n`;
    (transport as unknown as { onData(c: string): void }).onData(line.repeat(8));

    expect(failed).toBe(false);
  });
});
