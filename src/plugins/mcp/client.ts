/** McpClient — the protocol layer over a (bidirectional) transport: initialize
 *  handshake, tools/list (paginated), tools/call, resources, prompts, and
 *  routing of server->client requests (ping, sampling, elicitation, roots) and
 *  notifications. */

import type { HookBus } from '../../bus/hook-bus';
import { McpError, McpErrorCode } from './jsonrpc';
import type { McpTransport } from './transport';
import type { TraceContext } from '../../network/types';
import { MCP_PROTOCOL_VERSION } from './types';
import type {
  McpCallResult,
  McpCompletionRef,
  McpCompletionResult,
  McpGetPromptResult,
  McpInitializeResult,
  McpLogLevel,
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpTask,
  McpTaskMetadata,
  McpToolDef,
} from './types';

export interface McpClientOptions {
  clientInfo?: { name: string; version: string };
  /** Capabilities to advertise in `initialize` (e.g. sampling/roots/elicitation). */
  capabilities?: Record<string, unknown>;
  /** Every server->client notification (logging, *_changed, progress, …). */
  onNotification?: (method: string, params: unknown) => void;
  /** Handle a server->client request we don't answer internally (sampling,
   *  elicitation/create, roots/list). Return the result or throw McpError. */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Primary hooks bus for unconditional MCP telemetry (onMcpToolCall / onMcpError).
   *  When set, emission is unconditional — no telemetry adapter is required.
   *  `server` is the namespace label emitted in MCP hook contexts. */
  hooks?: HookBus;
  /** MCP namespace / server label (paired with `hooks`). */
  server?: string;
  /** @deprecated Use `hooks` + `server` instead. Kept for backward compatibility. */
  telemetry?: { hooks: HookBus; server: string };
  /** Send a `ping` every N ms to keep the connection alive (0/undefined = off). */
  keepAliveMs?: number;
}

export class McpClient {
  private serverInfo: McpInitializeResult | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpClientOptions = {},
  ) {}

  /** The server's `initialize` result, or null before `connect()`. */
  get info(): McpInitializeResult | null {
    return this.serverInfo;
  }

  /** Open the transport, run the initialize handshake, and start listening for
   *  server-initiated messages. */
  async connect(): Promise<McpInitializeResult> {
    this.transport.setHandlers({
      onRequest: (method, params) => this.handleServerRequest(method, params),
      onNotification: (method, params) => this.opts.onNotification?.(method, params),
    });
    await this.transport.start();
    const result = (await this.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.opts.capabilities ?? {},
      clientInfo: this.opts.clientInfo ?? { name: '@combycode/llm-sdk', version: '1.0.0' },
    })) as McpInitializeResult;
    this.serverInfo = result;
    if (result?.protocolVersion) this.transport.setProtocolVersion?.(result.protocolVersion);
    await this.transport.notify('notifications/initialized');
    await this.transport.listen?.();
    if (this.opts.keepAliveMs && this.opts.keepAliveMs > 0) {
      this.pingTimer = setInterval(() => {
        void this.transport.request('ping').catch(() => {});
      }, this.opts.keepAliveMs);
      // Don't let the keep-alive timer hold the process open (Node/Bun).
      (this.pingTimer as unknown as { unref?: () => void }).unref?.();
    }
    return result;
  }

  /** List every tool the server exposes (follows cursor pagination). */
  async listTools(): Promise<McpToolDef[]> {
    return this.paginate<McpToolDef>('tools/list', 'tools');
  }

  /** Follow cursor pagination for a list method, collecting `field` from each page. */
  private async paginate<T>(method: string, field: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.transport.request(method, cursor ? { cursor } : {})) as Record<string, unknown>;
      const page = res?.[field] as T[] | undefined;
      if (page) out.push(...page);
      cursor = res?.nextCursor as string | undefined;
    } while (cursor);
    return out;
  }

  /** Invoke a tool by its (un-namespaced) server name.
   *  Pass `trace` when the call originates from an AgentLoop run so that
   *  `onMcpToolCall` and `onMcpError` carry the run's sessionId/requestId. */
  async callTool(name: string, args: Record<string, unknown> = {}, trace?: TraceContext): Promise<McpCallResult> {
    const hooks = this.opts.hooks ?? this.opts.telemetry?.hooks;
    const server = this.opts.server ?? this.opts.telemetry?.server ?? 'mcp';
    const t0 = performance.now();
    try {
      const res = (await this.transport.request('tools/call', { name, arguments: args })) as McpCallResult;
      hooks?.emitSync('onMcpToolCall', { server, tool: name, latencyMs: performance.now() - t0, isError: res.isError ?? false, trace });
      return res;
    } catch (e) {
      hooks?.emitSync('onMcpError', { server, phase: 'request', error: e instanceof Error ? e : new Error(String(e)), trace });
      throw e;
    }
  }

  // ─── Resources (P2) ───────────────────────────────────────────────────

  /** List the server's resources (follows cursor pagination). */
  async listResources(): Promise<McpResource[]> {
    return this.paginate<McpResource>('resources/list', 'resources');
  }

  /** List the server's resource templates. */
  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    return this.paginate<McpResourceTemplate>('resources/templates/list', 'resourceTemplates');
  }

  /** Read a resource's contents by URI. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const res = (await this.transport.request('resources/read', { uri })) as { contents?: McpResourceContent[] };
    return res?.contents ?? [];
  }

  /** Subscribe to updates for a resource (server sends `notifications/resources/updated`). */
  async subscribeResource(uri: string): Promise<void> {
    await this.transport.request('resources/subscribe', { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.transport.request('resources/unsubscribe', { uri });
  }

  // ─── Prompts (P2) ─────────────────────────────────────────────────────

  /** List the server's prompts (follows cursor pagination). */
  async listPrompts(): Promise<McpPrompt[]> {
    return this.paginate<McpPrompt>('prompts/list', 'prompts');
  }

  /** Render a prompt by name with arguments → its messages. */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    return (await this.transport.request('prompts/get', { name, arguments: args })) as McpGetPromptResult;
  }

  // ─── Logging (P2) ─────────────────────────────────────────────────────

  /** Set the server's log verbosity (it then sends `notifications/message`). */
  async setLogLevel(level: McpLogLevel): Promise<void> {
    await this.transport.request('logging/setLevel', { level });
  }

  /** Argument autocompletion for a prompt or resource template. */
  async completeArgument(ref: McpCompletionRef, argument: { name: string; value: string }): Promise<McpCompletionResult> {
    const res = (await this.transport.request('completion/complete', { ref, argument })) as {
      completion?: McpCompletionResult;
    };
    return res?.completion ?? { values: [] };
  }

  // ─── Tasks — long-running tool calls (P4) ─────────────────────────────

  /** Call a tool as a long-running task; returns the created task immediately. */
  async callToolTask(name: string, args: Record<string, unknown> = {}, meta: McpTaskMetadata = {}): Promise<McpTask> {
    const res = (await this.transport.request('tools/call', { name, arguments: args, task: meta })) as { task: McpTask };
    return res.task;
  }

  /** Current status of a task. */
  async getTask(taskId: string): Promise<McpTask> {
    return (await this.transport.request('tasks/get', { taskId })) as McpTask;
  }

  /** The final result of a completed task. */
  async getTaskResult(taskId: string): Promise<McpCallResult> {
    return (await this.transport.request('tasks/result', { taskId })) as McpCallResult;
  }

  /** List the server's tasks. */
  async listTasks(): Promise<McpTask[]> {
    return this.paginate<McpTask>('tasks/list', 'tasks');
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.transport.request('tasks/cancel', { taskId });
  }

  /** Poll `tasks/get` until the task reaches a terminal status. */
  async awaitTask(taskId: string, opts: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<McpTask> {
    const start = Date.now();
    const timeout = opts.timeoutMs ?? 120_000;
    for (;;) {
      const task = await this.getTask(taskId);
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task;
      if (Date.now() - start > timeout) {
        throw new McpError({ code: McpErrorCode.RequestTimeout, message: `MCP task ${taskId} did not finish in time` });
      }
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? task.pollInterval ?? 500));
    }
  }

  /** Low-level escape hatch: send any request method. */
  async request(method: string, params?: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }

  async close(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    await this.transport.close();
  }

  // ─── internal ───────────────────────────────────────────────────────────

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'ping') return {};
    if (this.opts.onServerRequest) return this.opts.onServerRequest(method, params);
    throw new McpError({ code: McpErrorCode.MethodNotFound, message: `unsupported server request: ${method}` });
  }
}
