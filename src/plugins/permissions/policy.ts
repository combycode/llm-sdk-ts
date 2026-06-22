/** PermissionPolicy — walk rules in declaration order, first match wins.
 *  No matching rule → default-deny. */

import type { PermissionDecision, PermissionTarget, Rule } from './types';

function arrayMatch(value: string, allowed: string | string[]): boolean {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.includes(value) || list.includes('*');
}

export class PermissionPolicy {
  constructor(private readonly rules: readonly Rule[]) {}

  check(source: string, target: PermissionTarget, action: string): PermissionDecision {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.source !== undefined && !arrayMatch(source, rule.source)) continue;
      if (rule.action !== undefined && !arrayMatch(action, rule.action)) continue;
      if (rule.target !== undefined && !rule.target(target)) continue;
      return {
        allow: rule.effect === 'allow',
        ask: rule.effect === 'ask' ? true : undefined,
        reason: rule.reason,
        matchedRule: i,
      };
    }
    return { allow: false, reason: 'no rule matched (default deny)' };
  }

  withAdditional(extra: readonly Rule[]): PermissionPolicy {
    return new PermissionPolicy([...this.rules, ...extra]);
  }

  get size(): number {
    return this.rules.length;
  }
}
