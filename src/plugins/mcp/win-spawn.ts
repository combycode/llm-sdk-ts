/** Windows command resolution + escaping for spawning stdio MCP servers.
 *
 *  Bare commands like `npx`/`uvx` are `.cmd` shims on Windows; spawning them
 *  directly throws ENOENT, and a blanket `shell:true` is a quoting/injection
 *  risk. This replicates the essential `cross-spawn` behavior (zero-dep):
 *  resolve the real file via PATH+PATHEXT, and route `.cmd`/`.bat` through
 *  `cmd.exe /d /s /c "<escaped command line>"` with verbatim args. No-op off
 *  Windows. The pure functions take an `exists` probe so they're testable. */

export interface SpawnPlan {
  file: string;
  args: string[];
  /** -> spawn options.windowsVerbatimArguments. */
  verbatim: boolean;
}

/** Quote one argument per Windows `CommandLineToArgvW` rules. */
export function quoteWinArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes) out += '\\'.repeat(backslashes);
      backslashes = 0;
      out += ch;
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Caret-escape cmd.exe metacharacters. */
export function escapeCmdMeta(s: string): string {
  return s.replace(/[()%!^"<>&|]/g, '^$&');
}

const CMD_EXTS = new Set(['.cmd', '.bat']);

function resolveOnPath(
  command: string,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathVar.split(';').filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = `${dir}\\${command}${ext}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Plan how to spawn `command args` on Windows. */
export function windowsSpawnPlan(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): SpawnPlan {
  const hasSepOrExt = /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command);
  const resolved = hasSepOrExt ? null : resolveOnPath(command, env, exists);
  const target = resolved ?? command;
  const ext = /\.[a-z0-9]+$/i.exec(target)?.[0]?.toLowerCase() ?? '';

  // .cmd/.bat (or an unresolved bare name we hope is a shim) -> cmd.exe.
  if (CMD_EXTS.has(ext) || (!resolved && !hasSepOrExt)) {
    const comspec = env.COMSPEC ?? env.ComSpec ?? 'cmd.exe';
    const line = [target, ...args].map((a) => escapeCmdMeta(quoteWinArg(a))).join(' ');
    // Outer quotes + /s: cmd strips exactly the first/last quote, runs the rest.
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: target, args, verbatim: false };
}
