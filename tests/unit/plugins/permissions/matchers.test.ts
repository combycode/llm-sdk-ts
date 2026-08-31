/** Glob compilation and the built-in target matchers.
 *
 *  These decide whether a tool may touch a path, run a command, or reach a URL,
 *  so the difference between `*` and `**` is a security boundary, not a
 *  convenience. Strict mode (`fs`) must NOT let a single `*` cross a directory
 *  separator; loose mode (`shell`, `url`) deliberately does, because a command
 *  line and a URL have no meaningful path segments to protect.
 */

import { describe, expect, it } from 'bun:test';
import { compileGlobs, globToRegex } from '../../../../src/plugins/permissions/glob';
import {
  anyOfKind,
  fsGlob,
  memoryCategory,
  shellGlob,
  urlPattern,
} from '../../../../src/plugins/permissions/matchers';
import type { PermissionTarget } from '../../../../src/plugins/permissions/types';

describe('globToRegex — strict (path) mode', () => {
  it('a single * matches within one segment and stops at a slash', () => {
    const re = globToRegex('src/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/deep/index.ts')).toBe(false);
  });

  it('a bare * does not swallow a path', () => {
    const re = globToRegex('*');
    expect(re.test('file.ts')).toBe(true);
    expect(re.test('dir/file.ts')).toBe(false);
  });

  it('** crosses directories and swallows the slash that follows it', () => {
    const re = globToRegex('src/**/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/a/b/c/index.ts')).toBe(true);
    expect(re.test('other/index.ts')).toBe(false);
  });

  it('a trailing ** matches the rest of the path', () => {
    const re = globToRegex('src/**');
    expect(re.test('src/a/b')).toBe(true);
    expect(re.test('src/')).toBe(true);
  });

  it('? matches exactly one character, and never a slash', () => {
    const re = globToRegex('a?c');
    expect(re.test('abc')).toBe(true);
    expect(re.test('ac')).toBe(false);
    expect(re.test('abbc')).toBe(false);
    expect(globToRegex('a?c').test('a/c')).toBe(false);
  });

  it('regex metacharacters in the pattern are literal', () => {
    const re = globToRegex('a.b+c(d)[e]{f}^g$h|i');
    expect(re.test('a.b+c(d)[e]{f}^g$h|i')).toBe(true);
    // '.' must not act as "any character".
    expect(globToRegex('a.c').test('abc')).toBe(false);
  });

  it('is anchored at both ends', () => {
    const re = globToRegex('secret.txt');
    expect(re.test('secret.txt')).toBe(true);
    expect(re.test('/etc/secret.txt')).toBe(false);
    expect(re.test('secret.txt.bak')).toBe(false);
  });

  it('an empty pattern matches only the empty string', () => {
    expect(globToRegex('').test('')).toBe(true);
    expect(globToRegex('').test('x')).toBe(false);
  });
});

describe('globToRegex — loose mode', () => {
  it('a single * crosses separators', () => {
    expect(globToRegex('git *', { loose: true }).test('git log --oneline')).toBe(true);
    expect(globToRegex('https://*.example.com/*', { loose: true }).test(
      'https://api.example.com/v1/users',
    )).toBe(true);
    // The same pattern in strict mode stops at the first slash.
    expect(globToRegex('https://*.example.com/*').test('https://api.example.com/v1/users')).toBe(
      false,
    );
  });

  it('? in loose mode matches any single character, slash included', () => {
    expect(globToRegex('a?c', { loose: true }).test('a/c')).toBe(true);
    expect(globToRegex('a?c').test('a/c')).toBe(false);
  });

  it('** behaves the same in both modes', () => {
    expect(globToRegex('a/**/b', { loose: true }).test('a/x/y/b')).toBe(true);
  });

  it('loose:false is explicitly strict', () => {
    expect(globToRegex('a/*', { loose: false }).test('a/b/c')).toBe(false);
  });
});

describe('compileGlobs', () => {
  it('is an OR across every pattern', () => {
    const test = compileGlobs(['src/*.ts', 'docs/*.md']);
    expect(test('src/a.ts')).toBe(true);
    expect(test('docs/a.md')).toBe(true);
    expect(test('src/a.md')).toBe(false);
  });

  it('an empty pattern list matches nothing — default-deny, not default-allow', () => {
    expect(compileGlobs([])('anything at all')).toBe(false);
  });

  it('passes its options through to every pattern', () => {
    expect(compileGlobs(['a/*'], { loose: true })('a/b/c')).toBe(true);
    expect(compileGlobs(['a/*'])('a/b/c')).toBe(false);
  });
});

const target = (t: Record<string, unknown>): PermissionTarget => t as unknown as PermissionTarget;

describe('memoryCategory', () => {
  it('matches only memory targets in one of the named categories', () => {
    const m = memoryCategory('secrets', 'notes');
    expect(m(target({ kind: 'memory', category: 'secrets' }))).toBe(true);
    expect(m(target({ kind: 'memory', category: 'notes' }))).toBe(true);
    expect(m(target({ kind: 'memory', category: 'other' }))).toBe(false);
    // The kind must match too — a filesystem path in a 'secrets' folder is not
    // a memory category.
    expect(m(target({ kind: 'fs', category: 'secrets' }))).toBe(false);
  });

  it('a category-less memory target does not match', () => {
    expect(memoryCategory('secrets')(target({ kind: 'memory' }))).toBe(false);
  });

  it('with no categories it matches nothing', () => {
    expect(memoryCategory()(target({ kind: 'memory', category: 'secrets' }))).toBe(false);
  });
});

describe('fsGlob', () => {
  it('matches fs targets whose path matches, in strict mode', () => {
    const m = fsGlob('/repo/src/*.ts');
    expect(m(target({ kind: 'fs', path: '/repo/src/a.ts' }))).toBe(true);
    // Strict: a single * must not escape into a subdirectory.
    expect(m(target({ kind: 'fs', path: '/repo/src/deep/a.ts' }))).toBe(false);
    expect(m(target({ kind: 'fs', path: '/repo/src/a.md' }))).toBe(false);
  });

  it('rejects a non-fs kind and a non-string path', () => {
    const m = fsGlob('**');
    expect(m(target({ kind: 'shell', path: '/repo/a.ts' }))).toBe(false);
    expect(m(target({ kind: 'fs' }))).toBe(false);
    expect(m(target({ kind: 'fs', path: 42 }))).toBe(false);
  });
});

describe('shellGlob', () => {
  it('matches shell targets loosely, so one * covers a whole command line', () => {
    const m = shellGlob('git *');
    expect(m(target({ kind: 'shell', command: 'git log --oneline -n 5' }))).toBe(true);
    // A command line is full of slashes; a strict single * would refuse this
    // and quietly deny a rule the operator believed they had granted.
    expect(m(target({ kind: 'shell', command: 'git log -- src/plugins/index.ts' }))).toBe(true);
    expect(m(target({ kind: 'shell', command: 'rm -rf /' }))).toBe(false);
  });

  it('rejects a non-shell kind and a non-string command', () => {
    const m = shellGlob('*');
    expect(m(target({ kind: 'fs', command: 'ls' }))).toBe(false);
    expect(m(target({ kind: 'shell' }))).toBe(false);
  });
});

describe('urlPattern', () => {
  it('matches url targets loosely, so one * spans host and path', () => {
    const m = urlPattern('https://*.example.com/*');
    expect(m(target({ kind: 'url', url: 'https://api.example.com/v1/users' }))).toBe(true);
    expect(m(target({ kind: 'url', url: 'https://evil.com/v1' }))).toBe(false);
  });

  it('rejects a non-url kind and a non-string url', () => {
    const m = urlPattern('*');
    expect(m(target({ kind: 'fs', url: 'https://x' }))).toBe(false);
    expect(m(target({ kind: 'url' }))).toBe(false);
  });
});

describe('anyOfKind', () => {
  it('matches on kind alone, ignoring every other field', () => {
    const m = anyOfKind('fs', 'shell');
    expect(m(target({ kind: 'fs', path: '/anything' }))).toBe(true);
    expect(m(target({ kind: 'shell', command: 'rm -rf /' }))).toBe(true);
    expect(m(target({ kind: 'url', url: 'https://x' }))).toBe(false);
  });

  it('with no kinds it matches nothing', () => {
    expect(anyOfKind()(target({ kind: 'fs' }))).toBe(false);
  });
});
