/** connectMcp() / mcpToolset() / finishMcpAuth() unit tests.
 *
 *  This is the public MCP entry point, and it is where the host-side decisions
 *  live: which transport to build, what NAMESPACE the server's tools get, which
 *  client capabilities are declared, and which server->client requests are
 *  answered. Every one of those is silent when wrong — a bad namespace produces
 *  a tool the model can see but never call, an undeclared capability produces a
 *  server that simply never asks.
 *
 *  Everything runs against in-memory fakes: a fake `engine.connect` returning a
 *  scripted duplex socket for the WebSocket transport, and a fake `engine.fetch`
 *  speaking JSON-RPC for the Streamable-HTTP transport. No socket is opened, no
 *  port is bound, no process is spawned except the one deliberately-missing
 *  binary used to prove the stdio branch is taken. */

import { describe, expect, it } from 'bun:test';
import type { AgentTool } from '../../../src/agent/types';
import { HookBus } from '../../../src/bus/hook-bus';
import type { EngineHandle } from '../../../src/helpers/engine';
import { connectMcp, finishMcpAuth, mcpToolset } from '../../../src/helpers/mcp';
import { isFunctionTool } from '../../../src/llm/types/tools';
import type { RealtimeConnection, RealtimeFrame } from '../../../src/network/types';
import type {
  McpAuthProvider,
  McpOAuthClientInfo,
  McpOAuthTokens,
} from '../../../src/plugins/mcp/oauth';
import { McpUnauthorizedError } from '../../../src/plugins/mcp/oauth';
import type { McpToolDef } from '../../../src/plugins/mcp/types';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const toolCtx = () => ({
  step: 0,
  callId: 'c',
  signal: new AbortController().signal,
  metrics: new Map(),
});

const fnName = (t: AgentTool): string => (isFunctionTool(t.definition) ? t.definition.name : '');
const names = (tools: AgentTool[]): string[] => tools.map(fnName);

const ADD_TOOL: McpToolDef = {
  name: 'add',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
};

interface JsonRpcMsg {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ServerScript {
  /** Tool defs returned by `tools/list` (mutable — used for refresh tests). */
  tools: McpToolDef[];
  /** Extra fields merged into the `tools/list` result (e.g. `ttlMs`). */
  listExtra?: Record<string, unknown>;
  serverName?: string;
  serverVersion?: string;
  /** Fail `initialize` with this JSON-RPC error. */
  failInitialize?: { code: number; message: string };
}

/** The scripted MCP server. Answers the handshake, `tools/list` and
 *  `tools/call`; refuses `server/discover` so the client falls back to the
 *  pre-2026 handshake, which is what the vast majority of servers do today. */
function makeReply(script: ServerScript, log: JsonRpcMsg[]) {
  return (msg: JsonRpcMsg): JsonRpcMsg | null => {
    log.push(msg);
    switch (msg.method) {
      case 'server/discover':
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
      case 'initialize':
        if (script.failInitialize) {
          return { jsonrpc: '2.0', id: msg.id, error: script.failInitialize };
        }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: script.serverName ?? 'fixture',
              version: script.serverVersion ?? '1.2.3',
            },
          },
        };
      case 'notifications/initialized':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: script.tools, ...(script.listExtra ?? {}) },
        };
      case 'tools/call': {
        const { name, arguments: args } = msg.params as {
          name: string;
          arguments: Record<string, number>;
        };
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `${name}:${(args?.a ?? 0) + (args?.b ?? 0)}` }],
            structuredContent: { sum: (args?.a ?? 0) + (args?.b ?? 0) },
          },
        };
      }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
    }
  };
}

// ─── WebSocket rig: a duplex in-memory MCP server ────────────────────────────

interface WsRig {
  engine: EngineHandle;
  /** Every JSON-RPC message the client sent. */
  log: JsonRpcMsg[];
  /** Everything the SERVER pushed to the client (requests + notifications). */
  serverSent: JsonRpcMsg[];
  /** Every reply the client sent back to a server-initiated request. */
  clientReplies: JsonRpcMsg[];
  script: ServerScript;
  connects: number;
  fetches: number;
  closes: number;
  hookEvents: Array<{ name: string; ctx: Record<string, unknown> }>;
  /** Push a server->client message and wait for the client to process it. */
  push(msg: JsonRpcMsg): Promise<void>;
}

function wsRig(script: Partial<ServerScript> = {}): WsRig {
  const full: ServerScript = { tools: [ADD_TOOL], ...script };
  const log: JsonRpcMsg[] = [];
  const serverSent: JsonRpcMsg[] = [];
  const clientReplies: JsonRpcMsg[] = [];
  const hookEvents: Array<{ name: string; ctx: Record<string, unknown> }> = [];
  const counters = { connects: 0, fetches: 0, closes: 0 };
  const reply = makeReply(full, log);

  /** One independent scripted socket per `connect()` — a toolset opens several
   *  and they must not cross-talk. */
  const sockets: Array<{ deliver: (msg: JsonRpcMsg) => void }> = [];

  const newConn = (): RealtimeConnection => {
    let onMessage: ((f: RealtimeFrame) => void) | null = null;
    sockets.push({
      deliver: (msg) => onMessage?.({ text: JSON.stringify(msg) }),
    });
    return {
      send: (data) => {
        const msg = JSON.parse(String(data)) as JsonRpcMsg;
        // A message with an id but no method is the client ANSWERING the server.
        if (msg.id !== undefined && msg.method === undefined) {
          clientReplies.push(msg);
          return;
        }
        const out = reply(msg);
        if (out) queueMicrotask(() => onMessage?.({ text: JSON.stringify(out) }));
      },
      on: ((type: string, cb: (a?: unknown) => void) => {
        if (type === 'message') onMessage = cb as (f: RealtimeFrame) => void;
        return () => {};
      }) as RealtimeConnection['on'],
      close: () => {
        counters.closes++;
      },
      readyState: 1, // OPEN — `start()` resolves without waiting
    };
  };

  const hooks = new HookBus();
  for (const name of ['onMcpConnect', 'onMcpError', 'onMcpToolCall'] as const) {
    hooks.on(name, (ctx) => {
      hookEvents.push({ name, ctx: ctx as unknown as Record<string, unknown> });
    });
  }

  const engine = {
    hooks,
    apiKeys: {},
    connect: () => {
      counters.connects++;
      return newConn();
    },
    fetch: async () => {
      counters.fetches++;
      return { status: 200, headers: {}, body: '' };
    },
    fetchStream: async function* () {},
  } as unknown as EngineHandle;

  return {
    engine,
    log,
    serverSent,
    clientReplies,
    script: full,
    hookEvents,
    get connects() {
      return counters.connects;
    },
    get fetches() {
      return counters.fetches;
    },
    get closes() {
      return counters.closes;
    },
    push: async (msg) => {
      serverSent.push(msg);
      sockets[sockets.length - 1]?.deliver(msg);
      // Two macrotask turns: enough for the client's async handler chain
      // (handleRequest -> onServerRequest -> sendMessage) to settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const WS_URL = 'wss://calc.example.com/rpc';

const initParams = (rig: WsRig): Record<string, unknown> =>
  (rig.log.find((m) => m.method === 'initialize')?.params ?? {}) as Record<string, unknown>;

// ─── Namespacing ─────────────────────────────────────────────────────────────

describe('connectMcp() -- tool namespacing', () => {
  it('derives the namespace from the first label of the URL host', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });

  it('a config name beats the URL host', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL, name: 'maths' }, { engine: rig.engine });
    expect(names(mcp.tools)).toEqual(['maths__add']);
    await mcp.close();
  });

  it('an explicit opts.namespace beats the config name', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL, name: 'maths' },
      { engine: rig.engine, namespace: 'chosen' },
    );
    expect(names(mcp.tools)).toEqual(['chosen__add']);
    await mcp.close();
  });

  it('sanitises everything that is not [A-Za-z0-9_]', async () => {
    // The namespace becomes part of a function-tool name, and providers reject
    // names outside that character class — so this is a hard requirement, not
    // cosmetics.
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, namespace: 'my server-2.0!' },
    );
    expect(names(mcp.tools)).toEqual(['my_server_2_0___add']);
    await mcp.close();
  });

  it('replaces illegal characters rather than dropping them', async () => {
    // '###' becomes '___', NOT '' — the namespace keeps its length so two
    // servers whose names differ only in punctuation still differ afterwards.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, namespace: '###' });
    expect(names(mcp.tools)).toEqual(['_____add']);
    await mcp.close();
  });

  it('an empty namespace falls back to "mcp"', async () => {
    // An empty namespace would produce the tool name '__add', which reads as a
    // dunder rather than a namespaced tool.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, namespace: '' });
    expect(names(mcp.tools)).toEqual(['mcp__add']);
    await mcp.close();
  });

  it('a hostname the URL parser rejects falls back to "mcp"', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: 'wss://' }, { engine: rig.engine });
    expect(names(mcp.tools)).toEqual(['mcp__add']);
    await mcp.close();
  });

  it('keeps only the first host label, not the whole domain', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: 'wss://tools.internal.corp/rpc' }, { engine: rig.engine });
    expect(names(mcp.tools)).toEqual(['tools__add']);
    await mcp.close();
  });

  it('namespaces keep two servers collision-free', async () => {
    const a = wsRig();
    const b = wsRig();
    const one = await connectMcp({ url: 'wss://alpha.example.com' }, { engine: a.engine });
    const two = await connectMcp({ url: 'wss://beta.example.com' }, { engine: b.engine });
    expect([...names(one.tools), ...names(two.tools)]).toEqual(['alpha__add', 'beta__add']);
    await one.close();
    await two.close();
  });
});

describe('connectMcp() -- stdio namespacing', () => {
  /** Connect to a command that cannot exist and read the namespace back off the
   *  `onMcpError` hook. Nothing is spawned successfully and nothing is bound. */
  async function namespaceOfFailedStdio(
    command: string,
    opts: { namespace?: string } = {},
  ): Promise<string> {
    const events: Array<Record<string, unknown>> = [];
    const hooks = new HookBus();
    hooks.on('onMcpError', (ctx) => {
      events.push(ctx as unknown as Record<string, unknown>);
    });
    const engine = { hooks, apiKeys: {} } as unknown as EngineHandle;
    await connectMcp({ command }, { engine, timeoutMs: 300, ...opts }).catch(() => {});
    expect(events).toHaveLength(1);
    return String(events[0].server);
  }

  it('derives the namespace from the command basename, extension stripped', async () => {
    expect(await namespaceOfFailedStdio('orxa-no-such-binary.js')).toBe('orxa_no_such_binary');
  });

  it('strips a POSIX directory prefix', async () => {
    expect(await namespaceOfFailedStdio('/opt/bin/orxa-no-such-binary')).toBe(
      'orxa_no_such_binary',
    );
  });

  it('strips a Windows directory prefix', async () => {
    expect(await namespaceOfFailedStdio('C:\\tools\\orxa-no-such-binary.exe')).toBe(
      'orxa_no_such_binary',
    );
  });

  it('a config name beats the command basename', async () => {
    const events: Array<Record<string, unknown>> = [];
    const hooks = new HookBus();
    hooks.on('onMcpError', (ctx) => {
      events.push(ctx as unknown as Record<string, unknown>);
    });
    const engine = { hooks, apiKeys: {} } as unknown as EngineHandle;
    await connectMcp(
      { command: '/opt/bin/orxa-no-such-binary.js', name: 'fs' },
      { engine, timeoutMs: 300 },
    ).catch(() => {});
    expect(events[0].server).toBe('fs');
  });
});

// ─── Transport selection ─────────────────────────────────────────────────────

describe('connectMcp() -- transport selection', () => {
  it('a wss:// url opens a WebSocket, never an HTTP request', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(rig.connects).toBe(1);
    expect(rig.fetches).toBe(0);
    await mcp.close();
  });

  it('a ws:// url does too', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: 'ws://calc.example.com/rpc' }, { engine: rig.engine });
    expect(rig.connects).toBe(1);
    expect(rig.fetches).toBe(0);
    await mcp.close();
  });

  it('the scheme test is case-insensitive', async () => {
    // A URL is not required to be lowercased, and treating `WSS://` as HTTP
    // would POST a JSON-RPC body at a socket endpoint.
    const rig = wsRig();
    const mcp = await connectMcp({ url: 'WSS://calc.example.com/rpc' }, { engine: rig.engine });
    expect(rig.connects).toBe(1);
    expect(rig.fetches).toBe(0);
    await mcp.close();
  });

  it('reports the transport kind on the connect hook', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    const connected = rig.hookEvents.find((e) => e.name === 'onMcpConnect');
    expect(connected?.ctx.transport).toBe('ws');
    await mcp.close();
  });

  it('forwards timeoutMs to the transport, so a mute server does not hang forever', async () => {
    // Without the forward the default is 60s: a server that accepts the socket
    // and then says nothing would stall the caller for a full minute.
    const engine = {
      hooks: new HookBus(),
      apiKeys: {},
      connect: () =>
        ({
          send: () => {}, // never answers
          on: () => () => {},
          close: () => {},
          readyState: 1,
        }) as unknown as RealtimeConnection,
    } as unknown as EngineHandle;

    const started = Date.now();
    await expect(connectMcp({ url: WS_URL }, { engine, timeoutMs: 60 })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('closing the connection closes the socket', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(rig.closes).toBe(0);
    await mcp.close();
    expect(rig.closes).toBe(1);
  });
});

// ─── The handshake ───────────────────────────────────────────────────────────

describe('connectMcp() -- handshake', () => {
  it('probes for a modern server, then falls back to initialize', async () => {
    // Default `protocolMode: 'auto'`. A pre-2026 server answers the probe with
    // "method not found", which is NOT an error the caller should ever see.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(rig.log.map((m) => m.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    await mcp.close();
  });

  it("protocolMode 'legacy' skips the probe entirely", async () => {
    // For servers that mishandle an unknown method instead of answering with an
    // error, as the spec requires.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, protocolMode: 'legacy' });
    expect(rig.log.map((m) => m.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    await mcp.close();
  });

  it('exposes the initialize result as serverInfo', async () => {
    const rig = wsRig({ serverName: 'calculator', serverVersion: '4.5.6' });
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(mcp.serverInfo?.serverInfo).toEqual({ name: 'calculator', version: '4.5.6' });
    expect(mcp.serverInfo?.capabilities).toEqual({ tools: {} });
    await mcp.close();
  });

  it('exposes the underlying client for low-level access', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(typeof mcp.client.callTool).toBe('function');
    expect(mcp.client.info).toBe(mcp.serverInfo);
    await mcp.close();
  });

  it('forwards clientInfo to the server', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, clientInfo: { name: 'orxa-tests', version: '9.9.9' } },
    );
    expect(initParams(rig).clientInfo).toEqual({ name: 'orxa-tests', version: '9.9.9' });
    await mcp.close();
  });
});

// ─── Tools ───────────────────────────────────────────────────────────────────

describe('connectMcp() -- tools', () => {
  it('wraps each server tool as an AgentTool carrying the server schema', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    const [tool] = mcp.tools;
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (!isFunctionTool(tool.definition)) throw new Error('unreachable');
    expect(tool.definition.description).toBe('Add two numbers');
    expect(tool.definition.parameters).toEqual(ADD_TOOL.inputSchema);
    await mcp.close();
  });

  it('calls the server with the RAW tool name, not the namespaced one', async () => {
    // The namespace exists for the model's benefit only. Sending it to the
    // server produces "unknown tool" on every single call.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL, name: 'maths' }, { engine: rig.engine });
    const out = await mcp.tools[0].execute({ a: 4, b: 5 }, toolCtx());
    expect(out).toBe('add:9');
    const call = rig.log.find((m) => m.method === 'tools/call');
    expect(call?.params?.name).toBe('add');
    await mcp.close();
  });

  it('the tools array is STABLE across a refresh, so a holder sees updates', async () => {
    // An AgentLoop is handed this array once. Replacing it on refresh would
    // leave the loop pointing at a frozen snapshot forever.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    const before = mcp.tools;
    rig.script.tools = [ADD_TOOL, { name: 'sub', inputSchema: { type: 'object' } }];
    const after = await mcp.listTools();
    expect(after).toBe(before); // same array instance
    expect(names(mcp.tools)).toEqual(['calc__add', 'calc__sub']);
    await mcp.close();
  });

  it('a refresh REPLACES the contents rather than appending', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    await mcp.listTools();
    await mcp.listTools();
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });

  it('a server that removed a tool loses it from the array', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    rig.script.tools = [];
    expect(await mcp.listTools()).toHaveLength(0);
    await mcp.close();
  });

  it('reports the tool count on the connect hook', async () => {
    const rig = wsRig({ tools: [ADD_TOOL, { name: 'sub', inputSchema: { type: 'object' } }] });
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    const connected = rig.hookEvents.find((e) => e.name === 'onMcpConnect');
    expect(connected?.ctx).toMatchObject({
      server: 'calc',
      transport: 'ws',
      serverName: 'fixture',
      serverVersion: '1.2.3',
      toolCount: 2,
    });
    await mcp.close();
  });
});

describe('connectMcp() -- lazy and validateOutput are forwarded to every tool', () => {
  it('lazy:true marks every tool lazy', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, lazy: true });
    expect(mcp.tools[0].lazy).toBe(true);
    await mcp.close();
  });

  it('lazy is absent by default', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(mcp.tools[0].lazy).toBeUndefined();
    await mcp.close();
  });

  it('lazy survives a refresh', async () => {
    // The refresh closure re-wraps every tool, so an option dropped there would
    // silently un-lazy the whole server on the first `list_changed`.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, lazy: true });
    await mcp.listTools();
    expect(mcp.tools[0].lazy).toBe(true);
    await mcp.close();
  });

  it('validateOutput declares the server outputSchema on the tool', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, validateOutput: true });
    const def = mcp.tools[0].definition;
    if (!isFunctionTool(def)) throw new Error('unreachable');
    expect((def as { outputSchema?: unknown }).outputSchema).toEqual(ADD_TOOL.outputSchema);
    await mcp.close();
  });

  it('without validateOutput the outputSchema is NOT declared', async () => {
    // Declaring it is a promise to the provider that the result is JSON of that
    // shape; forwarding it unconditionally reshapes every existing tool result.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    const def = mcp.tools[0].definition;
    if (!isFunctionTool(def)) throw new Error('unreachable');
    expect((def as { outputSchema?: unknown }).outputSchema).toBeUndefined();
    await mcp.close();
  });

  it('validateOutput changes the tool result to the structured JSON', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, validateOutput: true });
    expect(await mcp.tools[0].execute({ a: 1, b: 2 }, toolCtx())).toBe('{"sum":3}');
    await mcp.close();
  });
});

// ─── Capability declaration ──────────────────────────────────────────────────

describe('connectMcp() -- declared capabilities', () => {
  it('declares nothing when no server-side handler is configured', async () => {
    // A capability we declare but cannot serve is worse than silence: the
    // server will ask, and every request will fail.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    expect(initParams(rig).capabilities).toEqual({});
    await mcp.close();
  });

  it('sampling declares the sampling capability', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, sampling: async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }) },
    );
    expect(initParams(rig).capabilities).toEqual({ sampling: {} });
    await mcp.close();
  });

  it('elicit declares the elicitation capability', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, elicit: async () => ({ action: 'decline' }) },
    );
    expect(initParams(rig).capabilities).toEqual({ elicitation: {} });
    await mcp.close();
  });

  it('roots declares the roots capability with listChanged:false', async () => {
    // We never push a roots change, so advertising listChanged:true would be a
    // promise we do not keep.
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, roots: [{ uri: 'file:///work' }] },
    );
    expect(initParams(rig).capabilities).toEqual({ roots: { listChanged: false } });
    await mcp.close();
  });

  it('declares all three together', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      {
        engine: rig.engine,
        sampling: async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }),
        elicit: async () => ({ action: 'accept' }),
        roots: [],
      },
    );
    expect(initParams(rig).capabilities).toEqual({
      sampling: {},
      elicitation: {},
      roots: { listChanged: false },
    });
    await mcp.close();
  });
});

// ─── Server -> client request dispatch ───────────────────────────────────────

describe('connectMcp() -- server-initiated requests', () => {
  const SAMPLING_PARAMS = {
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
    maxTokens: 16,
  };

  it('routes sampling/createMessage to the configured handler', async () => {
    const seen: unknown[] = [];
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      {
        engine: rig.engine,
        sampling: async (params) => {
          seen.push(params);
          return { role: 'assistant', content: { type: 'text', text: 'pong' }, model: 'fake-1' };
        },
      },
    );
    await rig.push({ jsonrpc: '2.0', id: 900, method: 'sampling/createMessage', params: SAMPLING_PARAMS });
    expect(seen).toEqual([SAMPLING_PARAMS]);
    expect(rig.clientReplies).toHaveLength(1);
    expect(rig.clientReplies[0].id).toBe(900);
    expect(rig.clientReplies[0].result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'pong' },
      model: 'fake-1',
    });
    await mcp.close();
  });

  it('routes elicitation/create to the configured handler', async () => {
    const seen: unknown[] = [];
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      {
        engine: rig.engine,
        elicit: async (params) => {
          seen.push(params);
          return { action: 'accept', content: { name: 'Alex' } };
        },
      },
    );
    const params = { message: 'your name?', requestedSchema: { type: 'object' } };
    await rig.push({ jsonrpc: '2.0', id: 901, method: 'elicitation/create', params });
    expect(seen).toEqual([params]);
    expect(rig.clientReplies[0].result).toEqual({ action: 'accept', content: { name: 'Alex' } });
    await mcp.close();
  });

  it('answers roots/list from a static array', async () => {
    const roots = [{ uri: 'file:///work', name: 'work' }];
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, roots });
    await rig.push({ jsonrpc: '2.0', id: 902, method: 'roots/list' });
    expect(rig.clientReplies[0].result).toEqual({ roots });
    await mcp.close();
  });

  it('calls a roots function on every request, so the list can change', async () => {
    // The static form is a snapshot; the function form is the reason the option
    // accepts one at all.
    let n = 0;
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, roots: () => [{ uri: `file:///dir${++n}` }] },
    );
    await rig.push({ jsonrpc: '2.0', id: 903, method: 'roots/list' });
    await rig.push({ jsonrpc: '2.0', id: 904, method: 'roots/list' });
    expect(rig.clientReplies.map((r) => r.result)).toEqual([
      { roots: [{ uri: 'file:///dir1' }] },
      { roots: [{ uri: 'file:///dir2' }] },
    ]);
    await mcp.close();
  });

  it('awaits an async roots function', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, roots: async () => [{ uri: 'file:///async' }] },
    );
    await rig.push({ jsonrpc: '2.0', id: 905, method: 'roots/list' });
    expect(rig.clientReplies[0].result).toEqual({ roots: [{ uri: 'file:///async' }] });
    await mcp.close();
  });

  it('refuses a server request we did not declare, with MethodNotFound', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, roots: [] },
    );
    await rig.push({ jsonrpc: '2.0', id: 906, method: 'sampling/createMessage', params: SAMPLING_PARAMS });
    expect(rig.clientReplies[0].error?.code).toBe(-32601);
    expect(rig.clientReplies[0].error?.message).toBe(
      'unsupported server request: sampling/createMessage',
    );
    await mcp.close();
  });

  it('refuses a wholly unknown server method', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, roots: [] });
    await rig.push({ jsonrpc: '2.0', id: 907, method: 'nonsense/method' });
    expect(rig.clientReplies[0].error?.message).toBe(
      'unsupported server request: nonsense/method',
    );
    await mcp.close();
  });

  it('refuses everything when no handler at all is configured', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    await rig.push({ jsonrpc: '2.0', id: 908, method: 'roots/list' });
    expect(rig.clientReplies[0].error?.code).toBe(-32601);
    expect(rig.clientReplies[0].error?.message).toBe('unsupported server request: roots/list');
    await mcp.close();
  });

  it('answers ping without any handler being configured', async () => {
    // Liveness is the one server request that never needed a capability, and
    // failing it looks to the server like a dead client.
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    await rig.push({ jsonrpc: '2.0', id: 909, method: 'ping' });
    expect(rig.clientReplies[0].result).toEqual({});
    expect(rig.clientReplies[0].error).toBeUndefined();
    await mcp.close();
  });
});

// ─── Notifications and auto-refresh ──────────────────────────────────────────

describe('connectMcp() -- notifications', () => {
  const LIST_CHANGED = { jsonrpc: '2.0' as const, method: 'notifications/tools/list_changed' };

  it('forwards every server notification to onNotification', async () => {
    const seen: Array<[string, unknown]> = [];
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, onNotification: (m, p) => seen.push([m, p]) },
    );
    await rig.push({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'hello' },
    });
    expect(seen).toEqual([['notifications/message', { level: 'info', data: 'hello' }]]);
    await mcp.close();
  });

  it('does NOT re-list on list_changed unless autoRefreshTools is on', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine });
    rig.script.tools = [ADD_TOOL, { name: 'sub', inputSchema: { type: 'object' } }];
    await rig.push(LIST_CHANGED);
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });

  it('autoRefreshTools re-lists in place and reports the new tools', async () => {
    const reported: AgentTool[][] = [];
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, autoRefreshTools: true, onToolsChanged: (t) => reported.push(t) },
    );
    const original = mcp.tools;
    rig.script.tools = [ADD_TOOL, { name: 'sub', inputSchema: { type: 'object' } }];
    await rig.push(LIST_CHANGED);
    expect(names(mcp.tools)).toEqual(['calc__add', 'calc__sub']);
    expect(reported).toHaveLength(1);
    // The callback hands back the SAME array the caller already holds.
    expect(reported[0]).toBe(original);
    await mcp.close();
  });

  it('autoRefreshTools ignores notifications that are not list_changed', async () => {
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, autoRefreshTools: true },
    );
    rig.script.tools = [];
    await rig.push({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });

  it('auto-refreshes fine with no onToolsChanged callback', async () => {
    const rig = wsRig();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, autoRefreshTools: true });
    rig.script.tools = [];
    await rig.push(LIST_CHANGED);
    expect(mcp.tools).toHaveLength(0);
    await mcp.close();
  });

  it('onNotification still fires for list_changed while auto-refreshing', async () => {
    const seen: string[] = [];
    const rig = wsRig();
    const mcp = await connectMcp(
      { url: WS_URL },
      { engine: rig.engine, autoRefreshTools: true, onNotification: (m) => seen.push(m) },
    );
    await rig.push(LIST_CHANGED);
    expect(seen).toEqual(['notifications/tools/list_changed']);
    await mcp.close();
  });
});

// ─── Connection failure ──────────────────────────────────────────────────────

describe('connectMcp() -- failure reporting', () => {
  it('emits onMcpError with phase "connect" and rethrows', async () => {
    const rig = wsRig({ failInitialize: { code: -32000, message: 'server said no' } });
    await expect(connectMcp({ url: WS_URL }, { engine: rig.engine })).rejects.toThrow(
      /server said no/,
    );
    const errors = rig.hookEvents.filter((e) => e.name === 'onMcpError');
    expect(errors).toHaveLength(1);
    expect(errors[0].ctx.server).toBe('calc');
    expect(errors[0].ctx.phase).toBe('connect');
    expect(errors[0].ctx.error).toBeInstanceOf(Error);
  });

  it('never reports a successful connect after a failed one', async () => {
    const rig = wsRig({ failInitialize: { code: -32000, message: 'nope' } });
    await connectMcp({ url: WS_URL }, { engine: rig.engine }).catch(() => {});
    expect(rig.hookEvents.filter((e) => e.name === 'onMcpConnect')).toHaveLength(0);
  });

  it('wraps a non-Error throw so the hook always receives an Error', async () => {
    // A transport that rejects with a bare string would otherwise put a string
    // on `ctx.error`, and every consumer reads `.message`.
    const events: Array<Record<string, unknown>> = [];
    const hooks = new HookBus();
    hooks.on('onMcpError', (ctx) => {
      events.push(ctx as unknown as Record<string, unknown>);
    });
    const engine = {
      hooks,
      apiKeys: {},
      connect: () => {
        throw 'socket refused';
      },
    } as unknown as EngineHandle;

    await expect(connectMcp({ url: WS_URL }, { engine })).rejects.toBe('socket refused');
    expect(events[0].error).toBeInstanceOf(Error);
    expect((events[0].error as Error).message).toBe('socket refused');
  });
});

// ─── mcpToolset ──────────────────────────────────────────────────────────────

describe('mcpToolset()', () => {
  const TWO = [{ url: 'wss://alpha.example.com' }, { url: 'wss://beta.example.com' }];

  it('returns one flat toolset across every server, namespaced per server', async () => {
    const rig = wsRig();
    const set = await mcpToolset(TWO, { engine: rig.engine });
    expect(rig.connects).toBe(2);
    expect(names(set.tools)).toEqual(['alpha__add', 'beta__add']);
    expect(set.connections).toHaveLength(2);
    await set.close();
  });

  it('applies the shared options to every connection', async () => {
    const rig = wsRig();
    const set = await mcpToolset(TWO, { engine: rig.engine, lazy: true });
    expect(set.tools.every((t) => t.lazy === true)).toBe(true);
    await set.close();
  });

  it('close() closes every connection', async () => {
    const rig = wsRig();
    const set = await mcpToolset(TWO, { engine: rig.engine });
    expect(rig.closes).toBe(0);
    await set.close();
    expect(rig.closes).toBe(2);
  });

  it('an empty server list yields an empty toolset rather than throwing', async () => {
    const rig = wsRig();
    const set = await mcpToolset([], { engine: rig.engine });
    expect(set.tools).toEqual([]);
    expect(set.connections).toEqual([]);
    await set.close();
  });

  it('one failing server fails the whole toolset', async () => {
    // Promise.all semantics, and the right ones: a partially-connected toolset
    // would silently drop half the model's tools.
    const rig = wsRig({ failInitialize: { code: -32000, message: 'alpha is down' } });
    await expect(
      mcpToolset([{ url: 'wss://alpha.example.com' }], { engine: rig.engine }),
    ).rejects.toThrow(/alpha is down/);
  });
});

// ─── Streamable HTTP transport + OAuth ───────────────────────────────────────

const HTTP_URL = 'https://mcp.example.com/mcp';
const OAUTH_ORIGIN = 'https://mcp.example.com';
const ACCESS_TOKEN = 'tok-abc';

interface HttpRig {
  engine: EngineHandle;
  /** Every JSON-RPC message posted to the MCP endpoint. */
  log: JsonRpcMsg[];
  /** Authorization header seen on each MCP POST ('' when absent). */
  authSeen: string[];
  /** Every non-MCP (OAuth) request URL. */
  oauthUrls: string[];
  /** Per-request timeout seen on each MCP POST. */
  timeouts: Array<number | undefined>;
}

function httpRig(
  script: Partial<ServerScript> = {},
  opts: { registerStatus?: number; requireToken?: string } = {},
): HttpRig {
  const full: ServerScript = { tools: [ADD_TOOL], ...script };
  const log: JsonRpcMsg[] = [];
  const authSeen: string[] = [];
  const oauthUrls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const reply = makeReply(full, []);

  const fetch = async (req: {
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeout?: number;
  }) => {
    const url = String(req.url);
    if (url.includes('/.well-known/oauth-authorization-server')) {
      oauthUrls.push(url);
      return {
        status: 200,
        headers: {},
        body: {
          issuer: OAUTH_ORIGIN,
          authorization_endpoint: `${OAUTH_ORIGIN}/authorize`,
          token_endpoint: `${OAUTH_ORIGIN}/token`,
          registration_endpoint: `${OAUTH_ORIGIN}/register`,
        },
      };
    }
    if (url.endsWith('/register')) {
      oauthUrls.push(url);
      return {
        status: opts.registerStatus ?? 200,
        headers: {},
        body: { client_id: 'cid-1' },
      };
    }
    if (url.endsWith('/token')) {
      oauthUrls.push(url);
      return {
        status: 200,
        headers: {},
        body: { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 },
      };
    }
    // The MCP endpoint.
    const auth = req.headers?.authorization ?? '';
    authSeen.push(auth);
    timeouts.push(req.timeout);
    if (opts.requireToken && auth !== `Bearer ${opts.requireToken}`) {
      return { status: 401, headers: {}, body: '' };
    }
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    let msg: JsonRpcMsg;
    try {
      msg = JSON.parse(raw) as JsonRpcMsg;
    } catch {
      return { status: 200, headers: {}, body: '' };
    }
    log.push(msg);
    const out = reply(msg);
    if (!out) return { status: 202, headers: {}, body: '' };
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
      body: JSON.stringify(out),
    };
  };

  const engine = {
    hooks: new HookBus(),
    apiKeys: {},
    fetch,
    // No server->client GET channel — the same as a 405 from a real server.
    fetchStream: async function* () {},
    connect: () => {
      throw new Error('connect must not be used for an https:// MCP url');
    },
  } as unknown as EngineHandle;

  return { engine, log, authSeen, oauthUrls, timeouts };
}

describe('connectMcp() -- Streamable HTTP transport', () => {
  it('an https:// url speaks JSON-RPC over engine.fetch', async () => {
    const rig = httpRig();
    const mcp = await connectMcp({ url: HTTP_URL, name: 'calc' }, { engine: rig.engine });
    expect(rig.log.map((m) => m.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });

  it('reports transport "http" on the connect hook', async () => {
    const events: Array<Record<string, unknown>> = [];
    const rig = httpRig();
    (rig.engine.hooks as HookBus).on('onMcpConnect', (ctx) => {
      events.push(ctx as unknown as Record<string, unknown>);
    });
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine });
    expect(events[0].transport).toBe('http');
    expect(events[0].server).toBe('mcp'); // first host label
    await mcp.close();
  });

  it('puts timeoutMs on every request it posts', async () => {
    const rig = httpRig();
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine, timeoutMs: 1234 });
    expect(rig.timeouts.length).toBeGreaterThan(0);
    expect(rig.timeouts.every((t) => t === 1234)).toBe(true);
    await mcp.close();
  });

  it('cacheResults reaches the client, so a TTL-hinted list is reused', async () => {
    // This option was shipped on McpClient but never plumbed through connectMcp,
    // making `cacheResults: true` silently a no-op at the documented entry
    // point. The observable proof is a second listTools() that does not ask.
    const rig = httpRig({ listExtra: { ttlMs: 60_000 } });
    const mcp = await connectMcp(
      { url: HTTP_URL },
      { engine: rig.engine, cacheResults: true },
    );
    const before = rig.log.filter((m) => m.method === 'tools/list').length;
    await mcp.listTools();
    expect(rig.log.filter((m) => m.method === 'tools/list').length).toBe(before);
    await mcp.close();
  });

  it('without cacheResults the same list is re-fetched every time', async () => {
    const rig = httpRig({ listExtra: { ttlMs: 60_000 } });
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine });
    const before = rig.log.filter((m) => m.method === 'tools/list').length;
    await mcp.listTools();
    expect(rig.log.filter((m) => m.method === 'tools/list').length).toBe(before + 1);
    await mcp.close();
  });
});

// ─── OAuth ───────────────────────────────────────────────────────────────────

function makeAuthProvider(seed: { tokens?: McpOAuthTokens } = {}) {
  const store: {
    tokens?: McpOAuthTokens;
    verifier: string;
    state: string;
    client?: McpOAuthClientInfo;
    redirected: string;
  } = { tokens: seed.tokens, verifier: '', state: '', redirected: '' };

  const provider: McpAuthProvider = {
    redirectUrl: 'https://app.example.com/cb',
    clientMetadata: {
      redirect_uris: ['https://app.example.com/cb'],
      client_name: 'orxa-tests',
      scope: 'mcp',
    },
    clientInformation: () => store.client,
    saveClientInformation: (i) => {
      store.client = i;
    },
    tokens: () => store.tokens,
    saveTokens: (t) => {
      store.tokens = t;
    },
    redirectToAuthorization: (u) => {
      store.redirected = u;
    },
    saveCodeVerifier: (v) => {
      store.verifier = v;
    },
    codeVerifier: () => store.verifier,
    saveState: (s) => {
      store.state = s;
    },
    state: () => store.state,
  };
  return { provider, store };
}

const VALID_TOKENS: McpOAuthTokens = {
  access_token: ACCESS_TOKEN,
  token_type: 'Bearer',
  expires_in: 3600,
  obtained_at: Date.now(),
} as unknown as McpOAuthTokens;

describe('connectMcp() -- OAuth', () => {
  it('attaches the bearer to every MCP request when a token is already held', async () => {
    const rig = httpRig();
    const { provider } = makeAuthProvider({ tokens: VALID_TOKENS });
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider });
    expect(rig.authSeen.length).toBeGreaterThan(0);
    expect(rig.authSeen.every((a) => a === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    await mcp.close();
  });

  it('sends no Authorization header when no auth provider is configured', async () => {
    const rig = httpRig();
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine });
    expect(rig.authSeen.every((a) => a === '')).toBe(true);
    await mcp.close();
  });

  it('throws McpUnauthorizedError after starting an interactive grant', async () => {
    // No tokens yet: the provider is redirected and the caller is told to come
    // back through finishMcpAuth. The MCP endpoint is never contacted.
    const rig = httpRig();
    const { provider, store } = makeAuthProvider();
    await expect(
      connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider }),
    ).rejects.toThrow(McpUnauthorizedError);
    expect(store.redirected).toContain('code_challenge=');
    expect(store.redirected).toContain('state=');
    expect(store.client?.client_id).toBe('cid-1');
    expect(rig.log).toHaveLength(0); // no handshake was attempted
  });

  it('names the server URL in the unauthorized error', async () => {
    const rig = httpRig();
    const { provider } = makeAuthProvider();
    await expect(
      connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider }),
    ).rejects.toThrow(new RegExp(`MCP server ${HTTP_URL.replace(/\//g, '\\/')} requires`));
  });

  it('reports the failed grant through onMcpError like any other connect failure', async () => {
    const events: Array<Record<string, unknown>> = [];
    const rig = httpRig();
    (rig.engine.hooks as HookBus).on('onMcpError', (ctx) => {
      events.push(ctx as unknown as Record<string, unknown>);
    });
    const { provider } = makeAuthProvider();
    await connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider }).catch(() => {});
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('connect');
    expect(events[0].error).toBeInstanceOf(McpUnauthorizedError);
  });

  it('a 401 mid-session refreshes the token and retries the request', async () => {
    // `onUnauthorized` is the other half of the OAuth wiring: without it an
    // expired session surfaces as a dead connection rather than refreshing.
    const rig = httpRig({}, { requireToken: ACCESS_TOKEN });
    const { provider, store } = makeAuthProvider({
      tokens: { access_token: 'stale-token', refresh_token: 'rt-1' } as McpOAuthTokens,
    });
    const mcp = await connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider });
    // First attempt carried the stale token and was refused; the retry carried
    // the refreshed one and the handshake completed.
    expect(rig.authSeen[0]).toBe('Bearer stale-token');
    expect(rig.authSeen).toContain(`Bearer ${ACCESS_TOKEN}`);
    expect(store.tokens?.access_token).toBe(ACCESS_TOKEN);
    expect(names(mcp.tools)).toEqual(['mcp__add']);
    await mcp.close();
  });

  it('does NOT build an OAuth client for a WebSocket url', async () => {
    // OAuth here is HTTP-only: a ws:// config with `auth` must connect
    // normally rather than half-apply an authorization flow it cannot finish.
    const rig = wsRig();
    const { provider, store } = makeAuthProvider();
    const mcp = await connectMcp({ url: WS_URL }, { engine: rig.engine, auth: provider });
    expect(store.redirected).toBe('');
    expect(names(mcp.tools)).toEqual(['calc__add']);
    await mcp.close();
  });
});

describe('finishMcpAuth()', () => {
  it('exchanges the code for tokens and saves them through the provider', async () => {
    const rig = httpRig();
    const { provider, store } = makeAuthProvider();
    // Start the grant so the provider holds a state + verifier.
    await connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider }).catch(() => {});
    const state = new URL(store.redirected).searchParams.get('state') ?? '';

    await finishMcpAuth(HTTP_URL, 'the-code', state, { auth: provider, engine: rig.engine });
    expect(store.tokens?.access_token).toBe(ACCESS_TOKEN);
    expect(rig.oauthUrls.some((u) => u.endsWith('/token'))).toBe(true);
  });

  it('rejects a state that does not match the one persisted (CSRF guard)', async () => {
    const rig = httpRig();
    const { provider } = makeAuthProvider();
    await connectMcp({ url: HTTP_URL }, { engine: rig.engine, auth: provider }).catch(() => {});
    await expect(
      finishMcpAuth(HTTP_URL, 'the-code', 'attacker-state', {
        auth: provider,
        engine: rig.engine,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('rejects a callback for a grant this client never started', async () => {
    const rig = httpRig();
    const { provider } = makeAuthProvider();
    await expect(
      finishMcpAuth(HTTP_URL, 'the-code', 'some-state', { auth: provider, engine: rig.engine }),
    ).rejects.toThrow(/no state found/);
  });
});
