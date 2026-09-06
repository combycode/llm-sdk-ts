/** The checked-in gate files must describe the PROJECT, not the machine.
 *
 *  They are committed on purpose — the config describes this library's API and
 *  the two baselines are ratchets the checks read out of git. Which means
 *  anything that leaks into them is published. `last-run.json` is the counter-
 *  example and is gitignored: it records the absolute `dist` path of whichever
 *  machine produced it.
 *
 *  A one-time scan is not a guarantee. These files are rewritten by
 *  `--update` / `--update-debt`, so the next regeneration is the one that
 *  quietly reintroduces a path. This test is the thing that notices. */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

/** Committed on purpose. `last-run.json` is deliberately absent. */
const TRACKED = ['config.json', 'api-snapshot.json', 'example-debt.json'] as const;

/** A Windows drive letter, a POSIX home, or this workspace's own layout. */
const ABSOLUTE = /[A-Za-z]:[\\/]{1,2}|\/(?:Users|home)\/|\/[a-z]\/WORKSPACE|WORKSPACE[\\/]/;

/** Who ran it, rather than what it checks. */
const MACHINE = /this machine|my machine|localhost|127\.0\.0\.1/i;

describe('the committed gate files', () => {
  for (const name of TRACKED) {
    const text = () => readFileSync(join(ROOT, '.quality-gate', name), 'utf8');

    it(`${name} carries no absolute path`, () => {
      const offending = text()
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => ABSOLUTE.test(line))
        .map(([n, line]) => `${name}:${n}: ${line.trim().slice(0, 120)}`);
      expect(offending).toEqual([]);
    });

    it(`${name} does not describe one workstation`, () => {
      expect(text()).not.toMatch(MACHINE);
    });

    it(`${name} is valid JSON`, () => {
      expect(() => JSON.parse(text())).not.toThrow();
    });
  }

  it('last-run.json is not committed — it is where the absolute path lives', () => {
    // Named rather than assumed: if a future change starts tracking it, the
    // failure should say why that is wrong, not just that a file appeared.
    const tracked = Bun.spawnSync(['git', 'ls-files', '.quality-gate/last-run.json'], {
      cwd: ROOT,
    });
    expect(new TextDecoder().decode(tracked.stdout).trim()).toBe('');
  });
});
