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
  type InputRequiredRetry,
  isInputRequired,
  runInputRequiredDriver,
} from './input-required';
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
import { McpResultCache } from './result-cache';
import {
  McpSubscription,
  type McpServerEvent,
  type McpSubscriptionFilter,
} from './subscriptions';
import type {
  McpCacheHints,
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
  /** Cap on `input_required` retry rounds before giving up (default 10, matching every other SDK).
   *  A handler that never satisfies the server would otherwise loop forever. */
  inputRequiredMaxRounds?: number;
  /** Honour the server's `ttlMs` / `cacheScope` hints on list and read results (2026-07-28).
   *
   *  **Off by default.** Caching changes when a caller observes a server-side change, which is the
   *  caller's call to make. A server that sends no hints caches nothing either way, so this is a
   *  no-op against every pre-2026 server. Cache entries are dropped automatically on the matching
   *  `*_changed` notification. */
  cacheResults?: boolean;
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
  private readonly cache: McpResultCache | null;
  private readonly subscriptions = new Map<string | number, McpSubscription>();

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpClientOptions = {},
  ) {
    this.cache = opts.cacheResults ? new McpResultCache() : null;
  }

  /** Drop cached list/read results. Called automatically on the matching `*_changed`
   *  notification; exposed because a caller may know the server moved before it says so. */
  invalidateCache(method?: string): void {
    if (method) this.cache?.clearMethod(method);
    else this.cache?.clear();
  }

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
      onNotification: (method, params) => {
        // A listen-stream frame belongs to its subscription; anything else is a plain notification.
        // Frames are still forwarded to `onNotification` so an existing handler keeps seeing them.
        for (const sub of this.subscriptions.values()) {
          if (sub.handleFrame(method, params)) break;
        }
        // A cached list that outlives the server's own "this changed" notice is worse than no
        // cache at all, so invalidate BEFORE handing the event to the caller — a handler that
        // re-lists synchronously must not read a stale entry.
        this.invalidateOnChange(method, params);
        this.opts.onNotification?.(method, params);
      },
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
    // A failed probe leaves the modern version stamped on the transport, and on HTTP that
    // header is what routes the request — an `initialize` carrying `2026-07-28` would be
    // sent to the very handler that just refused us. Restore the handshake version first.
    this.transport.setProtocolVersion?.(MCP_PROTOCOL_VERSION);
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

  /** One `server/discover` at `version`. No retry, no adoption — the caller decides.
   *
   *  The transport is told the version FIRST because on HTTP it is not just bookkeeping:
   *  a modern server routes by the `MCP-Protocol-Version` header, so a probe sent without
   *  it lands on the legacy handler and is rejected with `400 Missing session ID` — the
   *  connection fails outright instead of negotiating. Invisible over stdio, which has no
   *  headers; found against mcp-py 2.0.0 Streamable HTTP (2026-08-09). */
  private async sendDiscover(version: string): Promise<McpDiscoverResult> {
    this.transport.setProtocolVersion?.(version);
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
        if (!(e instanceof McpError)) {
          // A 4xx to the PROBE is the server refusing the modern wire outright, and on HTTP
          // that is the ONLY way a 2025-era server can say so: the probe must carry
          // `MCP-Protocol-Version: 2026-07-28` for a modern server to route it at all, and a
          // legacy server answers that header with `400 Unsupported protocol version:
          // 2026-07-28. Supported versions: …2025-11-25` before any JSON-RPC is parsed.
          // That is a definitive statement about the wire, not an outage, so fall back.
          //
          // 5xx and network failures still rethrow: an outage must never silently downgrade
          // the protocol (E4 — a transient is not a verdict).
          const status = (e as { status?: number }).status;
          if (typeof status === 'number' && status >= 400 && status < 500) {
            await this.handshake();
            return;
          }
          throw e;
        }

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

  /** Follow cursor pagination for a list method, collecting `field` from each page.
   *
   *  When result caching is enabled and the server sent a `ttlMs`, the assembled list is reused
   *  until it expires. A paginated list is only as fresh as its shortest-lived page, so the
   *  effective TTL is the MINIMUM across pages — taking the last page's value would let an early,
   *  more volatile page go stale unnoticed. */
  private async paginate<T>(method: string, field: string): Promise<T[]> {
    const cacheKey = McpResultCache.key(method);
    const cached = this.cache?.get(cacheKey) as T[] | undefined;
    if (cached) return cached;

    const out: T[] = [];
    let cursor: string | undefined;
    let ttlMs: number | undefined;
    let cacheScope: 'private' | 'public' | undefined;
    do {
      const res = (await this.send(method, cursor ? { cursor } : {})) as Record<string, unknown>;
      const page = res?.[field] as T[] | undefined;
      if (page) out.push(...page);
      const hints = res as McpCacheHints;
      if (typeof hints?.ttlMs === 'number') {
        ttlMs = ttlMs === undefined ? hints.ttlMs : Math.min(ttlMs, hints.ttlMs);
      }
      cacheScope ??= hints?.cacheScope;
      cursor = res?.nextCursor as string | undefined;
    } while (cursor);

    this.cache?.set(cacheKey, out, { ttlMs, cacheScope });
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
      const first = (await this.send('tools/call', { name, arguments: args })) as McpCallResult;
      // A 2026-07-28 server can answer "I need input first" instead of a result; drive that to a
      // terminal result so the caller only ever sees a finished call. Legacy servers never set
      // `resultType`, so this is a no-op there.
      const res = await this.driveInputRequired(first, (responses, requestState) =>
        this.send('tools/call', {
          name,
          arguments: args,
          ...(responses ? { inputResponses: responses } : {}),
          ...(requestState !== undefined ? { requestState } : {}),
        }) as Promise<McpCallResult>,
      );
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
    const cacheKey = McpResultCache.key('resources/read', { uri });
    const cached = this.cache?.get(cacheKey) as McpResourceContent[] | undefined;
    if (cached) return cached;

    const first = (await this.send('resources/read', { uri })) as {
      contents?: McpResourceContent[];
    };
    const res = await this.driveInputRequired(first, (responses, requestState) =>
      this.send('resources/read', {
        uri,
        ...(responses ? { inputResponses: responses } : {}),
        ...(requestState !== undefined ? { requestState } : {}),
      }) as Promise<{ contents?: McpResourceContent[] }>,
    );
    const contents = res?.contents ?? [];
    this.cache?.set(cacheKey, contents, res as McpCacheHints);
    return contents;
  }

  /** Subscribe to updates for a resource (server sends `notifications/resources/updated`).
   *
   *  Handshake era only — 2026-07-28 replaces per-resource subscription with the single
   *  `subscriptions/listen` stream. */
  async subscribeResource(uri: string): Promise<void> {
    this.requireHandshakeEra('resources/subscribe');
    await this.send('resources/subscribe', { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.requireHandshakeEra('resources/unsubscribe');
    await this.send('resources/unsubscribe', { uri });
  }

  /** Open a `subscriptions/listen` stream (2026-07-28) — the single channel that replaces
   *  `resources/subscribe` and the standalone notification stream.
   *
   *  Every kind is **opt-in**: the server may not send what was not requested, and it acknowledges
   *  with the subset it actually honoured — which can be narrower than what was asked for. Check
   *  `subscription.honored` / `isHonored(kind)` rather than assuming the request was granted.
   *
   *  Events are level triggers ("this changed, re-fetch if you care"), so they carry no payload
   *  beyond the change itself. When result caching is on, the matching entries are dropped before
   *  `onEvent` runs, so a handler that immediately re-lists sees fresh data.
   *
   *  Requires a modern session and a duplex transport (stdio / WebSocket) — see
   *  `sendLongLivedRequest` on the HTTP transport for why. */
  async listen(
    filter: McpSubscriptionFilter,
    onEvent: (event: McpServerEvent) => void,
  ): Promise<McpSubscription> {
    if (this.era !== 'modern') {
      throw new McpError({
        code: McpErrorCode.MethodNotFound,
        message:
          `MCP 'subscriptions/listen' requires protocol version 2026-07-28; this session negotiated ` +
          `${this.negotiatedVersion}. Use subscribeResource() plus the change notifications on this wire.`,
      });
    }
    if (!this.transport.sendLongLivedRequest) {
      throw new McpError({
        code: McpErrorCode.MethodNotFound,
        message: `MCP 'subscriptions/listen' is not supported by this transport.`,
      });
    }

    // Declared before the send so an immediately-failing stream still finds it.
    let subscription: McpSubscription | undefined;
    const id = await this.transport.sendLongLivedRequest(
      'subscriptions/listen',
      this.withEnvelope({ notifications: filter }),
      (error) => {
        // The stream ended — cleanly, or because it was rejected/dropped. Either way the
        // subscription is dead; leaving it "open" would let a caller wait forever on events that
        // can no longer arrive.
        subscription?.markEnded(error);
        if (error) {
          const hooks = this.opts.hooks ?? this.opts.telemetry?.hooks;
          hooks?.emitSync('onMcpError', {
            server: this.opts.server ?? this.opts.telemetry?.server ?? 'mcp',
            phase: 'request',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
    subscription = new McpSubscription(
      id,
      filter,
      (event) => {
        this.invalidateForEvent(event);
        onEvent(event);
      },
      () => this.subscriptions.delete(id),
    );
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  // ─── Prompts (P2) ─────────────────────────────────────────────────────

  /** List the server's prompts (follows cursor pagination). */
  async listPrompts(): Promise<McpPrompt[]> {
    return this.paginate<McpPrompt>('prompts/list', 'prompts');
  }

  /** Render a prompt by name with arguments → its messages. */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    const first = (await this.send('prompts/get', { name, arguments: args })) as McpGetPromptResult;
    return this.driveInputRequired(first, (responses, requestState) =>
      this.send('prompts/get', {
        name,
        arguments: args,
        ...(responses ? { inputResponses: responses } : {}),
        ...(requestState !== undefined ? { requestState } : {}),
      }) as Promise<McpGetPromptResult>,
    );
  }

  // ─── Logging (P2) ─────────────────────────────────────────────────────

  /** Set the server's log verbosity (it then sends `notifications/message`).
   *
   *  Handshake era only — `logging/setLevel` was removed at 2026-07-28, where verbosity rides in
   *  each request's `_meta` instead. Throws rather than silently no-opping: a caller who asked for
   *  debug logging and got none would have no way to tell. */
  async setLogLevel(level: McpLogLevel): Promise<void> {
    this.requireHandshakeEra('logging/setLevel');
    await this.send('logging/setLevel', { level });
  }

  /** Argument autocompletion for a prompt or resource template. */
  async completeArgument(ref: McpCompletionRef, argument: { name: string; value: string }): Promise<McpCompletionResult> {
    const res = (await this.send('completion/complete', { ref, argument })) as {
      completion?: McpCompletionResult;
    };
    return res?.completion ?? { values: [] };
  }

  // ─── Tasks — long-running tool calls (P4) ─────────────────────────────

  /** Call a tool as a long-running task; returns the created task immediately. */
  async callToolTask(name: string, args: Record<string, unknown> = {}, meta: McpTaskMetadata = {}): Promise<McpTask> {
    const res = (await this.send('tools/call', { name, arguments: args, task: meta })) as { task: McpTask };
    return res.task;
  }

  /** Current status of a task. */
  async getTask(taskId: string): Promise<McpTask> {
    return (await this.send('tasks/get', { taskId })) as McpTask;
  }

  /** The final result of a completed task. */
  async getTaskResult(taskId: string): Promise<McpCallResult> {
    return (await this.send('tasks/result', { taskId })) as McpCallResult;
  }

  /** List the server's tasks. */
  async listTasks(): Promise<McpTask[]> {
    return this.paginate<McpTask>('tasks/list', 'tasks');
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.send('tasks/cancel', { taskId });
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

  /** Low-level escape hatch: send any request method. Carries the modern-era identity
   *  envelope like every other request. */
  async request(method: string, params?: unknown): Promise<unknown> {
    return this.send(method, params);
  }

  /** Every request goes through here.
   *
   *  At 2026-07-28 there is no handshake and no session id, so each request states its
   *  own identity: `_meta` MUST carry the protocol version and the client capabilities
   *  (client info is optional). Only `server/discover` used to build that envelope, so
   *  every later call on a modern session was rejected:
   *
   *    -32602 params._meta must be an object carrying the required
   *           'io.modelcontextprotocol/protocolVersion' and
   *           'io.modelcontextprotocol/clientCapabilities' envelope keys
   *
   *  Unreachable without a real 2026-07-28 server — no public one exists yet; found by
   *  running mcp-py 2.0.0 over stdio (2026-08-09).
   *
   *  Handshake-era sessions are untouched: identity lives in `initialize` there, and an
   *  unexpected `_meta` is exactly the sort of thing an older server can reject. */
  private async send(method: string, params?: unknown): Promise<unknown> {
    if (this.era !== 'modern') return this.transport.request(method, params);
    return this.transport.request(method, this.withEnvelope(params));
  }

  /** Stamp the modern identity envelope onto a request's params.
   *
   *  Shared by `send()` and the long-lived `subscriptions/listen`, because EVERY request
   *  needs it — and the long-lived path is the one where a missing envelope hides: the
   *  rejection arrives as the stream's end rather than a thrown error, so `listen()`
   *  returned a subscription that looked alive and delivered nothing. */
  private withEnvelope(params?: unknown): Record<string, unknown> {
    const base = (params ?? {}) as Record<string, unknown>;
    const callerMeta = (base._meta ?? {}) as Record<string, unknown>;
    return {
      ...base,
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: this.negotiatedVersion,
        [MCP_CLIENT_CAPABILITIES_META_KEY]: this.opts.capabilities ?? {},
        [MCP_CLIENT_INFO_META_KEY]: this.clientInfo(),
        // A caller-supplied key wins — subscriptions/listen stamps its own id.
        ...callerMeta,
      },
    };
  }

  async close(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    await this.transport.close();
  }

  // ─── internal ───────────────────────────────────────────────────────────

  /** Resolve an `input_required` result to a terminal one.
   *
   *  The dispatcher is `handleServerRequest` — the SAME path that serves a handshake-era server
   *  pushing `sampling/createMessage` at us. That is the whole point of routing MRTR through here:
   *  a caller wires up sampling once and it works on either wire, without knowing which is in play.
   *
   *  Skips instantly when `resultType` is absent or `'complete'`, so the handshake path pays
   *  nothing. */
  private async driveInputRequired<T>(first: T, retry: InputRequiredRetry<T>): Promise<T> {
    if (!isInputRequired(first)) return first;
    return runInputRequiredDriver(first, {
      dispatch: (_key, request) => this.handleServerRequest(request.method, request.params),
      retry,
      maxRounds: this.opts.inputRequiredMaxRounds,
    });
  }

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

  /** Map a change notification onto the cache entries it invalidates. Same vocabulary on both
   *  eras — these methods ride the `subscriptions/listen` stream at 2026-07-28 and the
   *  back-channel before it, but the meaning ("refetch if you care") is identical. */
  private invalidateOnChange(method: string, params: unknown): void {
    if (!this.cache) return;
    switch (method) {
      case 'notifications/tools/list_changed':
        this.cache.clearMethod('tools/list');
        return;
      case 'notifications/prompts/list_changed':
        this.cache.clearMethod('prompts/list');
        return;
      case 'notifications/resources/list_changed':
        this.cache.clearMethod('resources/list');
        this.cache.clearMethod('resources/templates/list');
        return;
      case 'notifications/resources/updated': {
        const uri = (params as { uri?: unknown } | undefined)?.uri;
        // Only the named resource went stale; dropping every read would throw away good entries.
        if (typeof uri === 'string') {
          this.cache.clearMethod(McpResultCache.key('resources/read', { uri }));
        }
        return;
      }
      default:
        return;
    }
  }

  /** Same invalidation as `invalidateOnChange`, driven from a typed listen-stream event. */
  private invalidateForEvent(event: McpServerEvent): void {
    if (!this.cache) return;
    switch (event.type) {
      case 'tools_list_changed':
        this.cache.clearMethod('tools/list');
        break;
      case 'prompts_list_changed':
        this.cache.clearMethod('prompts/list');
        break;
      case 'resources_list_changed':
        this.cache.clearMethod('resources/list');
        this.cache.clearMethod('resources/templates/list');
        break;
      case 'resource_updated':
        this.cache.clearMethod(McpResultCache.key('resources/read', { uri: event.uri }));
        break;
    }
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
