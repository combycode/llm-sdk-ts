/** The module graph must stay a DAG.
 *
 *  This is not style policing. A Rust crate split cannot express a cycle, so any
 *  cycle between top-level layers is a blocker for the port — and cycles arrive
 *  one innocent import at a time. Two existed when this was written:
 *
 *    llm     <-> plugins   (llm/client -> ModelCatalog; provider media -> source-image)
 *    helpers <-> plugins   (internal-tools -> createLLM; mcp/sampling -> complete)
 *
 *  Both were closed by moving shared code DOWN (`catalog/`, `util/source-image`)
 *  and by passing capabilities down instead of importing up
 *  (`EngineHandle.createClient`, `samplingHandlerWith`).
 *
 *  Only VALUE imports count: `import type` is erased at build time and cannot
 *  create a runtime cycle.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const SRC = resolve(import.meta.dir, '../../../src');

/** Built from a char code so this file carries no lone backslash literal: the
 *  shell heredocs used to author it collapse `\` to `\`, which broke the parse. */
const SEP = String.fromCharCode(92);
const POSIX_SEP = '/';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const layerOf = (file: string): string => {
  const rel = relative(SRC, file).split(SEP).join(POSIX_SEP);
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0]! : '<root>';
};

/** layer -> layer -> example edges, from value imports only. */
function buildGraph(): Map<string, Map<string, string[]>> {
  const graph = new Map<string, Map<string, string[]>>();
  for (const file of walk(SRC)) {
    const from = layerOf(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s+(type\s+)?([^;]*?)from\s+'([^']+)'/g)) {
      if (m[1]) continue; // `import type` — erased, cannot cycle at runtime
      const spec = m[3]!;
      if (!spec.startsWith('.')) continue;
      const to = layerOf(resolve(dirname(file), spec));
      if (to === from) continue;
      if (!graph.has(from)) graph.set(from, new Map());
      const inner = graph.get(from)!;
      if (!inner.has(to)) inner.set(to, []);
      inner.get(to)!.push(`${relative(SRC, file).split(SEP).join(POSIX_SEP)} -> ${spec}`);
    }
  }
  return graph;
}

describe('layer dependency graph', () => {
  const graph = buildGraph();

  it('contains no cycles between top-level layers', () => {
    const cycles: string[] = [];
    for (const [a, targets] of graph) {
      for (const b of targets.keys()) {
        if (a < b && graph.get(b)?.has(a)) {
          const ab = graph.get(a)!.get(b)!;
          const ba = graph.get(b)!.get(a)!;
          cycles.push(
            `${a} <-> ${b}\n    ${a} -> ${b}: ${ab[0]}${ab.length > 1 ? ` (+${ab.length - 1} more)` : ''}` +
              `\n    ${b} -> ${a}: ${ba[0]}${ba.length > 1 ? ` (+${ba.length - 1} more)` : ''}`,
          );
        }
      }
    }
    expect(cycles).toEqual([]);
  });

  it('keeps the layers that must stay independent independent', () => {
    // Named explicitly so a regression names itself rather than just failing.
    expect(graph.get('llm')?.has('plugins') ?? false).toBe(false);
    expect(graph.get('llm')?.has('helpers') ?? false).toBe(false);
    expect(graph.get('plugins')?.has('helpers') ?? false).toBe(false);
    expect(graph.get('catalog')?.has('llm') ?? false).toBe(false);
    expect(graph.get('util')?.has('plugins') ?? false).toBe(false);
    expect(graph.get('bus')?.has('plugins') ?? false).toBe(false);
    expect(graph.get('network')?.has('llm') ?? false).toBe(false);
  });
});
