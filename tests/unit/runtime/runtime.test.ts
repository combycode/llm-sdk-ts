/** Lazy Node-module loaders + browser detection.
 *
 *  These four functions are the ONLY place the SDK is allowed to touch `node:*`.
 *  Two properties matter and neither is visible from a normal Node run:
 *    - on Node/Bun each loader must actually resolve its module (a loader that
 *      silently returns `{}` would break every filesystem feature at the call
 *      site, far from here)
 *    - in a browser each must reject with a message that names the alternative,
 *      BEFORE reaching the `import()` a bundler cannot resolve. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  isBrowser,
  nodeChildProcess,
  nodeFs,
  nodeFsPromises,
  nodePath,
} from '../../../src/runtime/runtime';

const g = globalThis as unknown as { window?: unknown };
const realWindow = g.window;
afterEach(() => {
  if (realWindow === undefined) delete g.window;
  else g.window = realWindow;
});

/** isBrowser() looks for a `window` that has a `document`. */
const pretendBrowser = () => {
  g.window = { document: {} };
};

describe('isBrowser', () => {
  it('is false on Node/Bun', () => {
    expect(isBrowser()).toBe(false);
  });

  it('is true only when window carries a document', () => {
    g.window = {};
    expect(isBrowser()).toBe(false); // a bare `window` global is not a DOM
    pretendBrowser();
    expect(isBrowser()).toBe(true);
  });
});

describe('lazy node module loaders — Node/Bun', () => {
  it('nodeFsPromises resolves the real fs/promises', async () => {
    expect(typeof (await nodeFsPromises()).readFile).toBe('function');
  });

  it('nodeFs resolves the real fs (sync helpers)', async () => {
    expect(typeof (await nodeFs()).existsSync).toBe('function');
  });

  it('nodePath resolves the real path', async () => {
    const path = await nodePath();
    expect(typeof path.join).toBe('function');
    expect(path.join('a', 'b')).toContain('a');
  });

  it('nodeChildProcess resolves the real child_process', async () => {
    expect(typeof (await nodeChildProcess()).spawn).toBe('function');
  });
});

describe('lazy node module loaders — browser', () => {
  it('the three filesystem loaders reject with the filesystem message', async () => {
    pretendBrowser();
    for (const load of [nodeFsPromises, nodeFs, nodePath]) {
      await expect(load()).rejects.toThrow(/needs filesystem access \(Node\/Bun only\)/);
      await expect(load()).rejects.toThrow(/bytes\/base64\/Blob\/URL instead of a path/);
    }
  });

  it('nodeChildProcess rejects with the PROCESS message, naming the HTTP MCP alternative', async () => {
    pretendBrowser();
    await expect(nodeChildProcess()).rejects.toThrow(/spawns a child process \(Node\/Bun only\)/);
    await expect(nodeChildProcess()).rejects.toThrow(/HTTP \(url\) MCP server instead of a stdio/);
  });
});
