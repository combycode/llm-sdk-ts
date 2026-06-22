/** OaiServer — OpenAI-compatible HTTP front-end for registered LLM clients.
 *
 *  Endpoints:
 *    POST /v1/chat/completions   — primary chat surface
 *    GET  /v1/models             — lists registered model entries
 *    GET  /health                — liveness probe
 *
 *  Plugin slots:
 *    - AuthPlugin: per-request authentication (Bearer keys, OAuth, etc.)
 *    - AgentLoaderPlugin: dynamic AgentLoop resolution (per-user agents)
 *    - ConversationLoaderPlugin: history hydration from external storage
 *
 *  Bun.serve is the runtime; tests can avoid binding a port by calling
 *  `handle(request)` directly. */

import { HookBus } from '../bus/hook-bus';
import { headersToRecord } from '../util/http';
import type { AuthPlugin } from './auth';
import type { AgentLoaderPlugin, ConversationLoaderPlugin } from './loaders';
import { dispatch } from './dispatch';
import {
  buildChatResponse,
  buildErrorBody,
  estimateTokens,
  extractLastUserText,
  extractSystemText,
  validateChatRequest,
} from './oai-adapter';
import { ConversationHistory } from '../agent/history';
import { ModelRouter, type ServerEntry } from './router';
import { ResponseStore } from './response-store';
import type { Persistence } from '../plugins/persistence/types';

interface BunServerHandle {
  port: number;
  hostname: string;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

declare const Bun:
  | {
      serve(opts: {
        port?: number;
        hostname?: string;
        fetch: (req: Request) => Promise<Response> | Response;
      }): BunServerHandle;
    }
  | undefined;

export interface OaiServerConfig {
  entries?: ServerEntry[];
  port?: number;
  hostname?: string;
  hooks?: HookBus;

  auth?: AuthPlugin;
  agentLoader?: AgentLoaderPlugin;
  conversationLoader?: ConversationLoaderPlugin;

  responseStore?: ResponseStore;
  responseStorePersistence?: Persistence;

  /** Fake-streaming chunk size for /v1/chat/completions stream:true. Default 40. */
  streamChunkChars?: number;
}

export class OaiServer {
  readonly id: string;
  readonly hooks: HookBus;
  private readonly router: ModelRouter;
  private readonly store: ResponseStore;
  private readonly auth: AuthPlugin | null;
  private readonly agentLoader: AgentLoaderPlugin | null;
  private readonly conversationLoader: ConversationLoaderPlugin | null;
  private readonly port: number;
  private readonly hostname: string;
  private server: BunServerHandle | null = null;

  constructor(config: OaiServerConfig = {}) {
    this.id = `oai-server-${crypto.randomUUID().slice(0, 6)}`;
    this.hooks = config.hooks ?? new HookBus();
    this.router = new ModelRouter({ entries: config.entries ?? [] });
    this.store =
      config.responseStore ?? new ResponseStore({ persistence: config.responseStorePersistence });
    this.auth = config.auth ?? null;
    this.agentLoader = config.agentLoader ?? null;
    this.conversationLoader = config.conversationLoader ?? null;
    this.port = config.port ?? 4000;
    this.hostname = config.hostname ?? '127.0.0.1';
  }

  // ─── Registration ──────────────────────────────────────────────────────

  register(entry: ServerEntry): void {
    this.router.register(entry);
  }

  unregister(model: string): boolean {
    return this.router.unregister(model);
  }

  // ─── HTTP lifecycle ────────────────────────────────────────────────────

  start(): { port: number; hostname: string } {
    if (this.server) throw new Error('OaiServer already started');
    if (typeof Bun === 'undefined') {
      throw new Error('OaiServer.start() requires Bun runtime; use handle(request) for tests');
    }
    this.server = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      fetch: (req: Request) => this.handle(req),
    });
    return { port: this.server.port, hostname: this.server.hostname };
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop(true);
      this.server = null;
    }
  }

  // ─── Request handler ───────────────────────────────────────────────────

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const startPerf = performance.now();
    let userId: string | null = null;
    let model: string | null = null;
    let status = 200;
    let response: Response;

    try {
      // Auth
      if (this.auth) {
        const headers = headersToRecord(request.headers);
        try {
          const result = await this.auth.verify(headers);
          userId = result.userId;
        } catch (e) {
          status = 401;
          await this.hooks.emit('onAuthFail', {
            serverId: this.id,
            requestId,
            reason: (e as Error).message,
          });
          response = json(buildErrorBody((e as Error).message, 'authentication_error'), 401);
          await this.emitResponse(requestId, status, startPerf, userId, model);
          return response;
        }
      }

      await this.hooks.emit('onServerRequest', {
        serverId: this.id,
        requestId,
        method: request.method,
        path: url.pathname,
        userId,
        model,
      });

      // Routing
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204, headers: corsHeaders() });
      } else if (request.method === 'GET' && url.pathname === '/health') {
        response = json({ status: 'ok' }, 200);
      } else if (request.method === 'GET' && url.pathname === '/v1/models') {
        response = json({ object: 'list', data: this.router.list() }, 200);
      } else if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await safeJson(request);
        try {
          const oaiReq = validateChatRequest(body);
          model = oaiReq.model;
          response = await this.handleChatCompletions(oaiReq, userId);
          status = response.status;
        } catch (e) {
          status = 400;
          response = json(buildErrorBody((e as Error).message, 'invalid_request_error'), 400);
        }
      } else {
        status = 404;
        response = json(
          buildErrorBody(`unknown route: ${request.method} ${url.pathname}`, 'not_found'),
          404,
        );
      }
    } catch (e) {
      status = 500;
      response = json(buildErrorBody((e as Error).message, 'server_error'), 500);
    }

    await this.emitResponse(requestId, status, startPerf, userId, model);
    return response;
  }

  // ─── Chat completions ─────────────────────────────────────────────────

  private async handleChatCompletions(
    oaiReq: import('./oai-types').OaiChatRequest,
    userId: string | null,
  ): Promise<Response> {
    const target = (() => {
      try {
        return this.router.resolve(oaiReq.model);
      } catch {
        return null;
      }
    })();

    if (!target) {
      return json(buildErrorBody(`model "${oaiReq.model}" not registered`, 'model_not_found'), 404);
    }

    const userText = extractLastUserText(oaiReq.messages);
    const systemPrompt = extractSystemText(oaiReq.messages);

    // Optional plugin slot: ConversationLoader rehydrates per (userId, model)
    // so multi-turn conversations work across requests. When absent, a fresh
    // history is built every call (stateless mode).
    const conversationId = oaiReq.user ?? userId ?? `default:${oaiReq.model}`;
    const history =
      (this.conversationLoader
        ? await this.conversationLoader.load({ userId, conversationId })
        : null) ??
      new ConversationHistory({
        provider: target.client.provider,
        model: target.model,
      });

    // Optional plugin slot: AgentLoader builds the AgentLoop with custom
    // system prompt / tools / history. When present, it owns the loop and
    // dispatch reuses it. Otherwise dispatch falls back to building from
    // ServerEntry (current default).
    const loop = this.agentLoader
      ? await this.agentLoader.load({ userId, model: target.model, conversationId })
      : null;

    const result = await dispatch({
      target,
      history,
      userText,
      systemPrompt: systemPrompt || undefined,
      externalTools: oaiReq.tools,
      maxOutputTokens: oaiReq.max_tokens,
      temperature: oaiReq.temperature,
      hooks: this.hooks,
      ...(loop ? { agentLoop: loop } : {}),
    });

    if (this.conversationLoader) {
      await this.conversationLoader.save({ userId, conversationId }, history);
    }

    const promptTokens = result.inputTokens || estimateTokens(userText + (systemPrompt ?? ''));
    const completionTokens = result.outputTokens || estimateTokens(result.text);

    return json(
      buildChatResponse({
        model: target.model,
        text: result.text,
        promptTokens,
        completionTokens,
        finishReason: 'stop',
      }),
      200,
    );
  }

  private async emitResponse(
    requestId: string,
    status: number,
    startPerf: number,
    userId: string | null,
    model: string | null,
  ): Promise<void> {
    await this.hooks.emit('onServerResponse', {
      serverId: this.id,
      requestId,
      status,
      latencyMs: performance.now() - startPerf,
      userId,
      model,
    });
  }

  // Expose accessors used by helpers / tests
  get responseStore(): ResponseStore {
    return this.store;
  }
  // Deprecated reference to silence unused-field warnings until 1.11 lands
  // ResponseStore-backed chains and AgentLoader/ConversationLoader integration.
  /** @internal */
  get _agentLoader(): AgentLoaderPlugin | null {
    return this.agentLoader;
  }
  /** @internal */
  get _conversationLoader(): ConversationLoaderPlugin | null {
    return this.conversationLoader;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS, DELETE',
    'access-control-allow-headers': 'authorization, content-type',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

async function safeJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

