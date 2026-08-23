/** No spec may put a credential in a URL.
 *
 *  A key in a query string is copied into every access log, proxy log and
 *  telemetry span the request passes through, and can leak through a Referer
 *  header. Google accepts `?key=`, which is why thirteen endpoints drifted into
 *  using it while the chat adapter had already been fixed to send a header.
 *
 *  One exemption, and it is a real one: `google/realtime` is a WebSocket
 *  handshake, and a browser cannot set a header on one. It is named here so the
 *  exemption is a decision on the record rather than the one that got missed.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SPEC_DIR = resolve(import.meta.dir, '../../../src/wire/specs');

const EXEMPT = new Map([
  ['google/realtime', 'WebSocket handshake — a browser cannot set a header on one'],
]);

/** Anything that looks like a credential riding in a URL or query value. */
const SUSPECT = /(\?|&)(key|api_?key|access_?token|token|password|secret)=/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}

describe('credentials never travel in a URL', () => {
  const specs = walk(SPEC_DIR).map((f) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>);

  it('reads every shipped spec, so a pass cannot mean it found nothing', () => {
    expect(specs.length).toBeGreaterThan(140);
  });

  it('no url, path or query value carries one', () => {
    const offenders: string[] = [];
    for (const spec of specs) {
      const id = String(spec.id);
      const addressing = JSON.stringify({
        envelope: (spec.envelope as Record<string, unknown>)?.url,
        path: (spec.envelope as Record<string, unknown>)?.path,
        query: (spec.envelope as Record<string, unknown>)?.query,
        operations: spec.operations,
      });
      if (SUSPECT.test(addressing) && !EXEMPT.has(id)) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });

  it('every exemption still exists and still needs to be one', () => {
    // An exemption for a spec that has been deleted or fixed is stale, and a stale
    // exemption is how the next one gets waved through.
    for (const [id] of EXEMPT) {
      const spec = specs.find((s) => s.id === id);
      expect(spec, `${id} is exempt but no longer exists`).toBeDefined();
      expect(JSON.stringify(spec?.operations ?? spec?.envelope)).toMatch(SUSPECT);
    }
  });
});
