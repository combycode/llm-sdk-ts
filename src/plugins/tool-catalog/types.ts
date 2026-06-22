/** ToolCatalog types — strict tool-policy contract. */

import type { JsonSchema } from '../../llm/types/tools';
import type { PermissionPolicy } from '../permissions/policy';
import type { PermissionTarget } from '../permissions/types';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ToolCategory = 'internal' | 'external';

export interface TargetDeclaration {
  kind: string;
  value?: PermissionTarget;
  pattern?: string | string[];
}

export interface CatalogedTool {
  definition: ToolDefinition;
  category: ToolCategory;
  declaredTargets: TargetDeclaration[];
  declaredActions: string[];
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  source: string;
  correlationId?: string;
  checkAccess(target: PermissionTarget, action: string): void;
  emit(kind: string, payload: unknown): Promise<void>;
}

export interface AgentScope {
  toolNames: readonly string[] | '*';
  externalAllowed?: boolean;
  policy?: PermissionPolicy;
}

export interface ToolCallRequest {
  toolName: string;
  source: string;
  input: Record<string, unknown>;
  correlationId?: string;
}

export interface ToolCallResult {
  callId: string;
  output: unknown;
  durationMs: number;
}
