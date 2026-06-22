import { describe, expect, it } from 'bun:test';
import { escapeCmdMeta, quoteWinArg, windowsSpawnPlan } from '../../../../src/plugins/mcp/win-spawn';

describe('quoteWinArg', () => {
  it('leaves simple args unquoted, quotes spaces/quotes', () => {
    expect(quoteWinArg('simple')).toBe('simple');
    expect(quoteWinArg('has space')).toBe('"has space"');
    expect(quoteWinArg('')).toBe('""');
    expect(quoteWinArg('a"b')).toBe('"a\\"b"');
    expect(quoteWinArg('a\\')).toBe('a\\'); // no space/quote -> not quoted
    expect(quoteWinArg('a b\\')).toBe('"a b\\\\"'); // trailing backslash doubled before closing quote
  });
});

describe('escapeCmdMeta', () => {
  it('carets cmd metacharacters', () => {
    expect(escapeCmdMeta('a&b')).toBe('a^&b');
    expect(escapeCmdMeta('x|y>z')).toBe('x^|y^>z');
  });
});

describe('windowsSpawnPlan', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.exe;.cmd', COMSPEC: 'cmd.exe' };

  it('resolves a bare name to an .exe and spawns it directly', () => {
    const exists = (p: string) => p === 'C:\\bin\\mytool.exe';
    const plan = windowsSpawnPlan('mytool', ['x'], env, exists);
    expect(plan).toEqual({ file: 'C:\\bin\\mytool.exe', args: ['x'], verbatim: false });
  });

  it('routes a resolved .cmd shim through cmd.exe with verbatim args', () => {
    const exists = (p: string) => p === 'C:\\bin\\npx.cmd';
    const plan = windowsSpawnPlan('npx', ['-y', 'server'], env, exists);
    expect(plan.file).toBe('cmd.exe');
    expect(plan.verbatim).toBe(true);
    expect(plan.args[0]).toBe('/d');
    expect(plan.args[2]).toBe('/c');
    expect(plan.args[3]).toContain('npx.cmd');
    expect(plan.args[3].startsWith('"')).toBe(true);
    expect(plan.args[3].endsWith('"')).toBe(true);
  });

  it('passes a path/extension command through unchanged', () => {
    const plan = windowsSpawnPlan('C:\\tools\\server.exe', ['a'], env, () => false);
    expect(plan).toEqual({ file: 'C:\\tools\\server.exe', args: ['a'], verbatim: false });
  });

  it('falls back to cmd.exe for an unresolved bare name', () => {
    const plan = windowsSpawnPlan('uvx', [], env, () => false);
    expect(plan.file).toBe('cmd.exe');
    expect(plan.verbatim).toBe(true);
  });
});
