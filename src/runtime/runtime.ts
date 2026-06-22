/** Runtime detection + lazy Node-only module access.
 *
 *  The SDK is cross-environment: it runs on Node/Bun (server) and bundles for
 *  the browser. Browser bundlers cannot resolve `node:*` builtins, so NO module
 *  on a reachable import path may statically `import 'node:…'`. Node access goes
 *  through the lazy loaders here instead — the dynamic `import()` only executes
 *  when the feature is actually used, and rejects cleanly in the browser with a
 *  friendly message (callers catch it or let it surface). */

/** True when running inside a browser (DOM present), false on Node/Bun. */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof (window as { document?: unknown }).document !== 'undefined';
}

const BROWSER_FS_MESSAGE =
  'This feature needs filesystem access (Node/Bun only) and is unavailable in the browser. ' +
  'Use in-memory persistence/media stores, or provide content as bytes/base64/Blob/URL instead of a path.';

/** Lazily load `node:fs/promises`; throws a friendly error in the browser.
 *  The isBrowser() guard runs first so the browser bundle never reaches the
 *  (stubbed) import — keeping node: out of the browser graph entirely. */
export async function nodeFsPromises(): Promise<typeof import('node:fs/promises')> {
  if (isBrowser()) throw new Error(BROWSER_FS_MESSAGE);
  try {
    return await import('node:fs/promises');
  } catch {
    throw new Error(BROWSER_FS_MESSAGE);
  }
}

/** Lazily load `node:fs` (sync helpers like existsSync); browser-friendly error. */
export async function nodeFs(): Promise<typeof import('node:fs')> {
  if (isBrowser()) throw new Error(BROWSER_FS_MESSAGE);
  try {
    return await import('node:fs');
  } catch {
    throw new Error(BROWSER_FS_MESSAGE);
  }
}

/** Lazily load `node:path`; browser-friendly error. */
export async function nodePath(): Promise<typeof import('node:path')> {
  if (isBrowser()) throw new Error(BROWSER_FS_MESSAGE);
  try {
    return await import('node:path');
  } catch {
    throw new Error(BROWSER_FS_MESSAGE);
  }
}

const BROWSER_PROC_MESSAGE =
  'This feature spawns a child process (Node/Bun only) and is unavailable in the browser. ' +
  'Use an HTTP (url) MCP server instead of a stdio (command) one.';

/** Lazily load `node:child_process` (stdio MCP transport); browser-friendly error. */
export async function nodeChildProcess(): Promise<typeof import('node:child_process')> {
  if (isBrowser()) throw new Error(BROWSER_PROC_MESSAGE);
  try {
    return await import('node:child_process');
  } catch {
    throw new Error(BROWSER_PROC_MESSAGE);
  }
}
