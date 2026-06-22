/** ToolCatalog — registry of tools, per-agent scopes, gated execution. */

import type { AgentBus } from '../../bus/agent-bus';
import type { PermissionPolicy } from '../permissions/policy';
import type { PermissionTarget } from '../permissions/types';
import { NoToolAccess, PermissionDenied, ToolNotFound, ToolRegistrationError } from './errors';
import type {
  AgentScope,
  CatalogedTool,
  ToolCallRequest,
  ToolCallResult,
  ToolContext,
  ToolDefinition,
} from './types';

export interface ToolCatalogConfig {
  bus?: AgentBus;
  policy?: PermissionPolicy;
}

function newCallId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `tc_${hex}`;
}

function validateRegistration(tool: CatalogedTool): void {
  const def = tool.definition;
  if (!def || typeof def.name !== 'string' || def.name.length === 0) {
    throw new ToolRegistrationError('tool.definition.name must be a non-empty string');
  }
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new ToolRegistrationError(`tool '${def.name}': description must be a non-empty string`);
  }
  if (!def.parameters || typeof def.parameters !== 'object') {
    throw new ToolRegistrationError(
      `tool '${def.name}': parameters must be an object (JSON schema)`,
    );
  }
  if (!Array.isArray(tool.declaredTargets)) {
    throw new ToolRegistrationError(`tool '${def.name}': declaredTargets must be an array`);
  }
  if (!Array.isArray(tool.declaredActions) || tool.declaredActions.length === 0) {
    throw new ToolRegistrationError(
      `tool '${def.name}': declaredActions must contain at least one entry`,
    );
  }
  if (tool.category !== 'internal' && tool.category !== 'external') {
    throw new ToolRegistrationError(
      `tool '${def.name}': category must be 'internal' or 'external'`,
    );
  }
  if (typeof tool.execute !== 'function') {
    throw new ToolRegistrationError(`tool '${def.name}': execute must be a function`);
  }
}

export class ToolCatalog {
  private readonly tools = new Map<string, CatalogedTool>();
  private readonly scopes = new Map<string, AgentScope>();
  private readonly bus: AgentBus | null;
  private readonly defaultPolicy: PermissionPolicy | null;

  constructor(config: ToolCatalogConfig = {}) {
    this.bus = config.bus ?? null;
    this.defaultPolicy = config.policy ?? null;
  }

  // ─── Registration ────────────────────────────────────────────────────

  register(tool: CatalogedTool): void {
    validateRegistration(tool);
    if (this.tools.has(tool.definition.name)) {
      throw new ToolRegistrationError(
        `tool '${tool.definition.name}' is already registered (unregister first to replace)`,
      );
    }
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // ─── Per-agent scope ─────────────────────────────────────────────────

  setAgentScope(agentId: string, scope: AgentScope): void {
    this.scopes.set(agentId, {
      toolNames: scope.toolNames,
      externalAllowed: scope.externalAllowed ?? false,
      policy: scope.policy,
    });
  }

  removeAgentScope(agentId: string): void {
    this.scopes.delete(agentId);
  }

  getAgentScope(agentId: string): AgentScope | undefined {
    return this.scopes.get(agentId);
  }

  // ─── Discovery ───────────────────────────────────────────────────────

  visibleTo(agentId: string): ToolDefinition[] {
    const scope = this.scopes.get(agentId);
    if (!scope) return [];
    return Array.from(this.tools.values())
      .filter((tool) => this.scopeAllows(scope, tool))
      .map((tool) => tool.definition);
  }

  getDefinition(name: string, agentId?: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    if (agentId !== undefined) {
      const scope = this.scopes.get(agentId);
      if (!scope || !this.scopeAllows(scope, tool)) return undefined;
    }
    return tool.definition;
  }

  search(query: { name?: string; description?: string }, agentId?: string): ToolDefinition[] {
    const nameNeedle = query.name?.toLowerCase();
    const descNeedle = query.description?.toLowerCase();
    const scope = agentId !== undefined ? this.scopes.get(agentId) : undefined;
    if (agentId !== undefined && !scope) return [];

    const out: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (scope && !this.scopeAllows(scope, tool)) continue;
      const def = tool.definition;
      if (nameNeedle && !def.name.toLowerCase().includes(nameNeedle)) continue;
      if (descNeedle && !def.description.toLowerCase().includes(descNeedle)) continue;
      out.push(def);
    }
    return out;
  }

  // ─── Execution ───────────────────────────────────────────────────────

  async call(req: ToolCallRequest): Promise<ToolCallResult> {
    const callId = newCallId();
    const startTime = performance.now();

    await this.emitEvent('tool.call.started', req.source, req.correlationId, {
      callId,
      source: req.source,
      toolName: req.toolName,
      input: req.input,
      correlationId: req.correlationId,
    });

    try {
      const tool = this.tools.get(req.toolName);
      if (!tool) throw new ToolNotFound(req.toolName);

      const scope = this.scopes.get(req.source);
      if (!scope) {
        throw new NoToolAccess(req.source, req.toolName, 'no scope registered for agent');
      }
      if (scope.toolNames !== '*' && !scope.toolNames.includes(req.toolName)) {
        throw new NoToolAccess(req.source, req.toolName, 'tool not in agent scope');
      }
      if (tool.category === 'external' && !scope.externalAllowed) {
        throw new NoToolAccess(req.source, req.toolName, 'external tools disabled for this agent');
      }

      const policy = scope.policy ?? this.defaultPolicy;
      const ctx = this.buildContext(req.source, req.correlationId, policy);

      const output = await tool.execute(req.input, ctx);

      const durationMs = performance.now() - startTime;
      await this.emitEvent('tool.call.completed', req.source, req.correlationId, {
        callId,
        source: req.source,
        toolName: req.toolName,
        output,
        durationMs,
      });
      return { callId, output, durationMs };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      const error = (err as Error).message ?? String(err);
      await this.emitEvent('tool.call.failed', req.source, req.correlationId, {
        callId,
        source: req.source,
        toolName: req.toolName,
        error,
        durationMs,
      });
      throw err;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private scopeAllows(scope: AgentScope, tool: CatalogedTool): boolean {
    if (tool.category === 'external' && !scope.externalAllowed) return false;
    if (scope.toolNames === '*') return true;
    return scope.toolNames.includes(tool.definition.name);
  }

  private buildContext(
    source: string,
    correlationId: string | undefined,
    policy: PermissionPolicy | null,
  ): ToolContext {
    const bus = this.bus;
    return {
      source,
      correlationId,
      checkAccess: (target: PermissionTarget, action: string) => {
        if (!policy) {
          throw new PermissionDenied(source, target, action, 'no policy configured (default-deny)');
        }
        const decision = policy.check(source, target, action);
        if (!decision.allow) {
          throw new PermissionDenied(source, target, action, decision.reason);
        }
      },
      emit: async (kind, payload) => {
        if (!bus) return;
        await bus.emit({ source, kind, payload, correlationId });
      },
    };
  }

  private async emitEvent(
    kind: string,
    source: string,
    correlationId: string | undefined,
    payload: unknown,
  ): Promise<void> {
    if (!this.bus) return;
    await this.bus.emit({ source, kind, payload, correlationId });
  }
}
