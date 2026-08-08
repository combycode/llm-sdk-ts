/** McpClient — the protocol layer over a (bidirectional) transport: initialize
 *  handshake, tools/list (paginated), tools/call, resources, prompts, and
 *  routing of server->client requests (ping, sampling, elicitation, roots) and
 *  notifications. */

import type { HookBus } from '../../bus/hook-bus';
import { McpError, McpErrorCode } from './jsonrpc';
import type { McpTransport } from './transport';
import type { TraceContext } from '../../network/types';
import { MCP_PROTOCOL_VERSION } from './types';
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_LATEST_MODERN_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY,
  type McpEra,
  isHandshakeMcpVersion,
  isModernMcpVersion,
  mcpEraOf,
  newestMutualModernVersion,
} from './protocol-version';
import type {
  McpCallResult,
  McpCompletionRef,
  McpCompletionResult,
  McpDiscoverResult,
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
  /** Send a `ping` every N ms to keep the connection alive (0/undefined = off).
   *  Ignored on a 2026-07-28 session, where `ping` no longer exists. */
  keepAliveMs?: number;
  /** How to negotiate the protocol revision.
   *
   *  - `'auto'` (default) — probe `server/discover`; anything that is not positive evidence of a
   *    modern server falls back to the `initialize` handshake.
   *  - `'legacy'` — skip the probe and run the handshake, byte-identical to pre-2.0 behaviour.
   *    Use this for a server that mishandles unknown methods.
   *  - a version string (e.g. `'2026-07-28'`) — adopt that revision directly, no probe.
   *
   *  Fallback is a DENYLIST: every JSON-RPC error falls back to the handshake except a
   *  `-32022` naming only modern versions we do not share. Transport/network errors are never
   *  treated as an era verdict — an outage must not silently downgrade the wire. */
  protocolMode?: 'auto' | 'legacy' | (string & {});
}

/** Pull `data.supported` off a `-32022`, or undefined when it is not actionable. A malformed
 *  payload must read as "no information", never as an empty-and-therefore-disjoint list. */
function supportedVersionsFrom(data: unknown): string[] | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const raw = (data as { supported?: unknown }).supported;
  if (!Array.isArray(raw)) return undefined;
  const versions = raw.filter((v): v is string => typeof v === 'string');
  return versions.length > 0 ? versions : undefined;
}

export class McpClient {
  private serverInfo: McpInitializeResult | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private negotiatedVersion: string = MCP_PROTOCOL_VERSION;
  private discovery: McpDiscoverResult | null = null;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpClientOptions = {},
  ) {}

  /** The server's `initialize` result, or null before `connect()`.
   *
   *  On a 2026-07-28 session there is no `initialize`, so this is SYNTHESISED from the
   *  `server/discover` result (capabilities, instructions, and the `_meta` serverInfo stamp).
   *  Deliberate: the shape a caller reads must not depend on which wire was negotiated
   *  (CONSTITUTION.md R2 — absorb the difference, never expose a union). */
  get info(): McpInitializeResult | null {
    return this.serverInfo;
  }

  /** The revision actually negotiated. Defaults to the handshake-era version until `connect()`. */
  get protocolVersion(): string {
    return this.negotiatedVersion;
  }

  /** Which wire this session speaks. `'handshake'` for 2025-11-25 and earlier. */
  get era(): McpEra {
    return mcpEraOf(this.negotiatedVersion);
  }

  /** The raw `server/discover` result on a modern session; `null` on a handshake session.
   *  Carries the fields that have no handshake equivalent (`supportedVersions`, `ttlMs`,
   *  `cacheScope`). */
  get discoverResult(): McpDiscoverResult | null {
    return this.discovery;
  }

  /** Open the transport, run the initialize handshake, and start listening for
   *  server-initiated messages. */
  async connect(): Promise<McpInitializeResult> {
    this.transport.setHandlers({
      onRequest: (method, params) => this.handleServerRequest(method, params),
      onNotification: (method, params) => this.opts.onNotification?.(method, params),
    });
    await this.transport.start();

    const mode = this.opts.protocolMode ?? 'auto';
    if (mode === 'legacy') {
      await this.handshake();
    } else if (mode !== 'auto' && isModernMcpVersion(mode)) {
      await this.adoptModern(await this.sendDiscover(mode), mode);
    } else if (mode !== 'auto' && isHandshakeMcpVersion(mode)) {
      await this.handshake();
    } else {
      await this.negotiateAuto();
    }

    await this.transport.listen?.();
    // `ping` does not exist at 2026-07-28 — starting a keep-alive there would send a method the
    // server has every right to reject. The option is ignored rather than erroring: it is a
    // connection-liveness hint, not a request the caller made.
    if (this.era === 'handshake' && this.opts.keepAliveMs && this.opts.keepAliveMs > 0) {
      this.pingTimer = setInterval(() => {
        void this.transport.request('ping').catch(() => {});
      }, this.opts.keepAliveMs);
      // Don't let the keep-alive timer hold the process open (Node/Bun).
      (this.pingTimer as unknown as { unref?: () => void }).unref?.();
    }
    return this.serverInfo as McpInitializeResult;
  }

  /** The pre-2026 path, unchanged: `initialize` + `notifications/initialized`. */
  private async handshake(): Promise<void> {
    const result = (await this.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.opts.capabilities ?? {},
      clientInfo: this.clientInfo(),
    })) as McpInitializeResult;
    this.serverInfo = result;
    this.negotiatedVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    if (result?.protocolVersion) this.transport.setProtocolVersion?.(result.protocolVersion);
    await this.transport.notify('notifications/initialized');
  }

  /** One `server/discover` at `version`. No retry, no adoption — the caller decides. */
  private async sendDiscover(version: string): Promise<McpDiscoverResult> {
    return (await this.transport.request('server/discover', {
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: version,
        [MCP_CLIENT_INFO_META_KEY]: this.clientInfo(),
        [MCP_CLIENT_CAPABILITIES_META_KEY]: this.opts.capabilities ?? {},
      },
    })) as McpDiscoverResult;
  }

  /** Install a discover result as the live session. */
  private async adoptModern(result: McpDiscoverResult, version: string): Promise<void> {
    this.discovery = result;
    this.negotiatedVersion = version;
    this.transport.setProtocolVersion?.(version);
    this.transport.setEra?.('modern');
    // Synthesise the shape callers already read (R2): a modern server states its identity in the
    // result's `_meta` stamp instead of a handshake payload. Display-only per spec, so a missing
    // or malformed stamp degrades to a placeholder rather than failing the connection.
    const stamp = (result?._meta as Record<string, unknown> | undefined)?.[MCP_SERVER_INFO_META_KEY];
    const info =
      stamp && typeof stamp === 'object'
        ? (stamp as { name?: string; version?: string; title?: string })
        : undefined;
    this.serverInfo = {
      protocolVersion: version,
      capabilities: result?.capabilities ?? {},
      serverInfo: {
        name: info?.name ?? 'unknown',
        version: info?.version ?? '0.0.0',
        ...(info?.title ? { title: info.title } : {}),
      },
      ...(result?.instructions ? { instructions: result.instructions } : {}),
    };
  }

  /** `mode: 'auto'` — probe modern, fall back to the handshake on anything that is not positive
   *  evidence of a modern server.
   *
   *  The fallback is a DENYLIST, matching mcp-py 2.0.0 `client/_probe.py`: every JSON-RPC error
   *  falls back EXCEPT a `-32022` whose `supported` list is modern-only and disjoint from ours —
   *  that one is a real incompatibility and must surface. Transport/network failures are rethrown
   *  untouched: an outage is not an era verdict, and silently downgrading the wire because a
   *  socket blipped would be the worst possible failure mode. */
  private async negotiateAuto(): Promise<void> {
    let version = MCP_LATEST_MODERN_VERSION;

    for (let attempt = 0; attempt < 2; attempt++) {
      let result: McpDiscoverResult;
      try {
        result = await this.sendDiscover(version);
      } catch (e) {
        if (!(e instanceof McpError)) throw e; // network/transport → never an era verdict

        if (e.code === McpErrorCode.UnsupportedProtocolVersion) {
          const supported = supportedVersionsFrom(e.data);
          const mutual = supported ? newestMutualModernVersion(supported) : undefined;
          if (mutual && attempt === 0) {
            version = mutual; // the server named a modern version we share — re-probe at it
            continue;
          }
          if (supported && !supported.some(isHandshakeMcpVersion)) {
            throw e; // modern-only and disjoint: a genuine incompatibility, not a legacy server
          }
        }

        try {
          await this.handshake();
        } catch (handshakeError) {
          if (
            !(handshakeError instanceof McpError) ||
            handshakeError.code !== McpErrorCode.UnsupportedProtocolVersion ||
            attempt !== 0
          ) {
            throw handshakeError;
          }
          // -32022 from the HANDSHAKE is itself modern evidence: a probe that timed out on our
          // side but landed on the server locked the connection modern before this initialize
          // arrived. Re-probe once at a version the server names.
          const supported = supportedVersionsFrom(handshakeError.data);
          const mutual = supported ? newestMutualModernVersion(supported) : undefined;
          if (!mutual) throw handshakeError;
          version = mutual;
          continue;
        }
        return;
      }

      // A server that answers `server/discover` but advertises no modern version is making a
      // legacy advertisement, not offering a modern session.
      const advertised = Array.isArray(result?.supportedVersions) ? result.supportedVersions : [];
      if (!advertised.some(isModernMcpVersion)) {
        await this.handshake();
        return;
      }
      await this.adoptModern(result, newestMutualModernVersion(advertised) ?? version);
      return;
    }
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

  /** Subscribe to updates for a resource (server sends `notifications/resources/updated`).
   *
   *  Handshake era only — 2026-07-28 replaces per-resource subscription with the single
   *  `subscriptions/listen` stream. */
  async subscribeResource(uri: string): Promise<void> {
    this.requireHandshakeEra('resources/subscribe');
    await this.transport.request('resources/subscribe', { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.requireHandshakeEra('resources/unsubscribe');
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

  /** Set the server's log verbosity (it then sends `notifications/message`).
   *
   *  Handshake era only — `logging/setLevel` was removed at 2026-07-28, where verbosity rides in
   *  each request's `_meta` instead. Throws rather than silently no-opping: a caller who asked for
   *  debug logging and got none would have no way to tell. */
  async setLogLevel(level: McpLogLevel): Promise<void> {
    this.requireHandshakeEra('logging/setLevel');
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

  /** Guard a method the 2026-07-28 revision removed. Naming the negotiated version and the
   *  replacement matters: without it the caller sees a bare -32601 from the server and has no way
   *  to know the method existed until the session happened to negotiate modern. */
  private requireHandshakeEra(method: string): void {
    if (this.era === 'handshake') return;
    throw new McpError({
      code: McpErrorCode.MethodNotFound,
      message:
        `MCP '${method}' does not exist at protocol version ${this.negotiatedVersion}. ` +
        `Connect with protocolMode: 'legacy' to use the pre-2026 wire, or use the 2026 replacement ` +
        `(subscriptions/listen for resource updates; per-request _meta for log level).`,
    });
  }

  private clientInfo(): { name: string; version: string } {
    return this.opts.clientInfo ?? { name: '@combycode/llm-sdk', version: '1.0.0' };
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'ping') return {};
    if (this.opts.onServerRequest) return this.opts.onServerRequest(method, params);
    throw new McpError({ code: McpErrorCode.MethodNotFound, message: `unsupported server request: ${method}` });
  }
}
