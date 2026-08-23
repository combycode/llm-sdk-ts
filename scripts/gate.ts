/** `bun run gate` — the quality gate, with the live-run keys already resolved.
 *
 *  G12 is the only check that actually sends a request to a provider, and it reports
 *  `cannot-judge` when the provider keys are missing from the
 *  environment. They are never in the environment on this machine — the keys live in
 *  the OS credential store and the sample runners fetch them per run.
 *
 *  That gap has been walked into repeatedly: run the gate, see "no keys", conclude the
 *  live runs cannot be judged, and hand back a change that was never sent to a
 *  provider. The fix is not to remember harder. This wrapper resolves the keys the
 *  same way the sample runners do and passes them to the gate, so the standard command
 *  runs the live checks by default.
 *
 *  The keys are read into this process's child environment and never printed.
 *
 *  Usage — identical to the gate itself, all flags pass through:
 *    bun run gate
 *    bun run gate --only example-runs
 *    bun run gate:snapshot
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const GATE = resolve(import.meta.dir, '../../../quality-gate/gate.mjs');

/** Providers the gate's declared runs need, keyed by the env var it looks for. */
const NEEDED: Array<{ env: string; keyring: string }> = [
  { env: 'OPENAI_API_KEY', keyring: 'openai' },
  { env: 'ANTHROPIC_API_KEY', keyring: 'claude' },
  { env: 'GOOGLE_AI_API_KEY', keyring: 'gemini' },
];

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
const resolved: string[] = [];
const failed: string[] = [];

try {
  // Same helper the sample runners use: OS keyring first, env var as fallback.
  const { getApiKey } = await import('../../official-samples/keys.ts');
  for (const { env: name, keyring } of NEEDED) {
    if (env[name]) {
      resolved.push(`${name} (already set)`);
      continue;
    }
    try {
      env[name] = await getApiKey(keyring);
      resolved.push(name);
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  }
} catch (e) {
  failed.push(`could not load official-samples/keys.ts — ${(e as Error).message}`);
}

console.log(
  resolved.length
    ? `gate: live keys resolved from the OS credential store — ${resolved.join(', ')}\n`
    : 'gate: NO live keys resolved — G12 will not be judged\n',
);
for (const f of failed) console.warn(`gate: ${f}`);

const res = spawnSync('node', [GATE, ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(res.status ?? 2);
