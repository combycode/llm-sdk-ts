/** Build the publishable JS artifacts (types are emitted separately by
 *  `tsc -p tsconfig.build.json`):
 *
 *    dist/index.js          — Node/Bun ESM bundle. node: builtins + deps stay
 *                             external (resolved at the consumer's runtime).
 *    dist/index.browser.js  — Browser ESM bundle. Fully node-free: node:
 *                             imports are stubbed (unreachable at runtime
 *                             behind isBrowser() guards), the AsyncLocalStorage
 *                             reentrancy context is swapped for the browser
 *                             fallback via the package "browser" field, and the
 *                             optional `tiktoken` dep is externalized.
 *
 *  The two bundles are wired into package.json `exports` via the `node`/`import`
 *  and `browser` conditions, so a consumer's bundler/runtime picks the right one
 *  automatically. */

import { build } from 'esbuild';

const ENTRY = 'src/index.ts';

await build({
  entryPoints: [ENTRY],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  packages: 'external',
  sourcemap: false,
  legalComments: 'none',
});

await build({
  entryPoints: [ENTRY],
  outfile: 'dist/index.browser.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  external: ['tiktoken'],
  plugins: [
    {
      name: 'stub-node-builtins',
      setup(b) {
        // Map every `node:*` specifier to an empty stub. The lazy loaders in
        // src/runtime throw a friendly error before ever touching it in the
        // browser, so the stub is dead code that just keeps node: out of the
        // browser bundle entirely.
        b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
          contents: 'export default {};',
          loader: 'js',
        }));
      },
    },
  ],
});

console.log('build: wrote dist/index.js (node) + dist/index.browser.js (browser)');
