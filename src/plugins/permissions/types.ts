/** Permissions — pure rule evaluator for `(source, target, action)` tuples. */

export interface PermissionTarget {
  kind: string;
  /** The arguments of the call being decided, when the decision is about one.
   *
   *  Why it is here rather than a `requiresApproval` callback on each tool:
   *  "a transfer over 1000 needs a human" is a POLICY statement, and it belongs
   *  beside "deploy needs approval" where someone auditing what requires
   *  approval can read all of it at once. Scattered over tool definitions, the
   *  answer to that question is only available by reading every tool.
   *
   *  **Absent on a decision made before any call exists** -- a pre-flight
   *  capability check, a catalog lookup. A matcher that reads it must therefore
   *  tolerate `undefined`, or it throws on the paths that have nothing to offer
   *  it and takes the whole run down with it. `t.arguments?.amount` rather than
   *  `t.arguments.amount`. */
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TargetMatcher = (target: PermissionTarget) => boolean;

/** A matcher's view of a tool call's arguments, with the absence handled.
 *
 *  `withArgs('amount', (v) => Number(v) > 1000)` reads as the rule it is, and
 *  cannot be the version that throws when the arguments are not there. A rule
 *  about an argument should not match a decision made before the call exists:
 *  the safe reading of "no arguments" is "this rule has nothing to say". */
export function withArgs(
  key: string,
  predicate: (value: unknown) => boolean,
): (target: PermissionTarget) => boolean {
  return (target) => {
    const args = target.arguments;
    if (args === undefined || !(key in args)) return false;
    return predicate(args[key]);
  };
}

export interface Rule {
  source?: string | string[];
  target?: TargetMatcher;
  action?: string | string[];
  /** 'allow' — proceed; 'deny' — block; 'ask' — suspend for human approval. */
  effect: 'allow' | 'deny' | 'ask';
  reason?: string;
}

export interface PermissionDecision {
  /** True when effect is 'allow'. False for 'deny' and 'ask'. */
  allow: boolean;
  /** True when effect is 'ask' — caller must request human approval. */
  ask?: boolean;
  reason?: string;
  matchedRule?: number;
}
