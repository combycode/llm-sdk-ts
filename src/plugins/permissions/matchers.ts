/** Built-in TargetMatcher factories. */

import { compileGlobs } from './glob';
import type { TargetMatcher } from './types';

export function memoryCategory(...categories: string[]): TargetMatcher {
  const set = new Set(categories);
  return (target) => target.kind === 'memory' && set.has(target.category as string);
}

export function fsGlob(...patterns: string[]): TargetMatcher {
  const test = compileGlobs(patterns);
  return (target) => target.kind === 'fs' && typeof target.path === 'string' && test(target.path);
}

export function shellGlob(...patterns: string[]): TargetMatcher {
  const test = compileGlobs(patterns, { loose: true });
  return (target) =>
    target.kind === 'shell' && typeof target.command === 'string' && test(target.command);
}

export function urlPattern(...patterns: string[]): TargetMatcher {
  const test = compileGlobs(patterns, { loose: true });
  return (target) => target.kind === 'url' && typeof target.url === 'string' && test(target.url);
}

export function anyOfKind(...kinds: string[]): TargetMatcher {
  const set = new Set(kinds);
  return (target) => set.has(target.kind);
}
