/** The version we tell a server has to be the version we are.
 *
 *  `SDK_VERSION` is a constant, not an import of `package.json` — see the note
 *  there for why. The cost of a constant is that it can drift, and this is what
 *  stops it: a release that bumps the manifest and forgets this file fails here
 *  rather than in a server's logs.
 *
 *  Worth guarding mechanically because the value it replaced had already
 *  drifted all the way: the MCP client identified itself as `1.0.0`, hard-coded,
 *  for every release. Nothing in the library could tell, because nothing
 *  compared it to anything.
 */

import { describe, expect, it } from 'bun:test';
import { SDK_VERSION } from '../../src/version';
import pkg from '../../package.json' with { type: 'json' };

describe('SDK_VERSION', () => {
  it('matches package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('is a plain semver, not a placeholder', () => {
    // `0.0.0` and `1.0.0` are what a forgotten constant looks like.
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
});
