#!/usr/bin/env bun
/**
 * Fail the build when coverage drops below the floor.
 *
 * `bunfig.toml`'s `coverageThreshold` is accepted and ignored by bun 1.3.14 --
 * verified by setting it to an impossible 1.0 and watching the run exit 0 --
 * so the gate has to be its own step. A threshold that does not fail is worse
 * than none, because it reads like protection.
 *
 * The floor is set just below the measured figure: an honest refactor has room,
 * a new untested module does not.
 *
 *     bun run scripts/coverage-gate.ts            # check
 *     bun run scripts/coverage-gate.ts --self-test # prove it can fail
 */

const FLOOR = { lines: 99.0, funcs: 97.0 };

/** `All files | 97.28 | 99.43 |` -> the two numbers. */
export function parseSummary(output: string): { funcs: number; lines: number } | null {
  const row = output.split("\n").find((l) => l.trimStart().startsWith("All files"));
  if (!row) return null;
  const cells = row.split("|").map((c) => c.trim());
  const funcs = Number.parseFloat(cells[1] ?? "");
  const lines = Number.parseFloat(cells[2] ?? "");
  return Number.isFinite(funcs) && Number.isFinite(lines) ? { funcs, lines } : null;
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    // A gate nobody has watched fail is not known to be a gate.
    const cases: Array<[string, boolean]> = [
      ["All files | 97.28 | 99.43 |", true],
      ["All files | 97.28 | 98.99 |", false],
      ["All files | 96.99 | 99.43 |", false],
      ["no summary row here", false],
    ];
    let bad = 0;
    for (const [row, shouldPass] of cases) {
      const got = parseSummary(row);
      const passed = got !== null && got.lines >= FLOOR.lines && got.funcs >= FLOOR.funcs;
      const ok = passed === shouldPass;
      if (!ok) bad++;
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${JSON.stringify(row)} -> ${passed}`);
    }
    process.exit(bad === 0 ? 0 : 1);
  }

  const proc = Bun.spawnSync(["bun", "test", "tests/unit", "--coverage"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;

  if (proc.exitCode !== 0) {
    console.error(output);
    console.error("coverage gate: the suite itself failed");
    process.exit(proc.exitCode ?? 1);
  }

  const got = parseSummary(output);
  if (!got) {
    // Never pass by accident: an unparseable report is a failure, because the
    // alternative is a green gate that measured nothing.
    console.error(output);
    console.error("coverage gate: could not find the 'All files' summary row");
    process.exit(1);
  }

  const short: string[] = [];
  if (got.lines < FLOOR.lines) short.push(`lines ${got.lines} < ${FLOOR.lines}`);
  if (got.funcs < FLOOR.funcs) short.push(`funcs ${got.funcs} < ${FLOOR.funcs}`);

  if (short.length > 0) {
    console.error(`coverage gate FAILED: ${short.join(", ")}`);
    process.exit(1);
  }
  console.log(`coverage gate ok: ${got.lines}% lines, ${got.funcs}% funcs`);
}
