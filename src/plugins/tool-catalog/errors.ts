/** Typed errors thrown by ToolCatalog. */

import type { PermissionTarget } from '../permissions/types';

export class ToolNotFound extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(`Tool '${toolName}' not registered`);
    this.name = 'ToolNotFound';
    this.toolName = toolName;
  }
}

export class NoToolAccess extends Error {
  readonly source: string;
  readonly toolName: string;
  readonly reasonDetail: string;
  constructor(source: string, toolName: string, reasonDetail: string) {
    super(`Agent '${source}' cannot call '${toolName}': ${reasonDetail}`);
    this.name = 'NoToolAccess';
    this.source = source;
    this.toolName = toolName;
    this.reasonDetail = reasonDetail;
  }
}

export class PermissionDenied extends Error {
  readonly source: string;
  readonly target: PermissionTarget;
  readonly action: string;
  readonly reasonDetail?: string;
  constructor(source: string, target: PermissionTarget, action: string, reasonDetail?: string) {
    super(
      `Permission denied: '${source}' → ${target.kind} '${action}'${
        reasonDetail ? ` (${reasonDetail})` : ''
      }`,
    );
    this.name = 'PermissionDenied';
    this.source = source;
    this.target = target;
    this.action = action;
    this.reasonDetail = reasonDetail;
  }
}

export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}
