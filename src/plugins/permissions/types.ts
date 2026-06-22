/** Permissions — pure rule evaluator for `(source, target, action)` tuples. */

export interface PermissionTarget {
  kind: string;
  [key: string]: unknown;
}

export type TargetMatcher = (target: PermissionTarget) => boolean;

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
