/** End-to-end MCP OAuth: a server that 401s until a Bearer token is presented.
 *  First connect -> redirect -> McpUnauthorizedError; finishMcpAuth exchanges the
 *  code; second connect succeeds with the bearer attached. */

import { describe, expect, it } from 'bun:test';
import type { AgentTool } from '../../src/agent/types';
import { createEngine } from '../../src/helpers/engine';
import { connectMcp, finishMcpAuth } from '../../src/helpers/mcp';
import { isFunctionTool } from '../../src/llm/types/tools';
import type { McpAuthProvider, McpOAuthClientInfo, McpOAuthTokens } from '../../src/plugins/mcp/oauth';
import { McpUnauthorizedError } from '../../src/plugins/mcp/oauth';

const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });
const fnName = (t: AgentTool) => (isFunctionTool(t.definition) ? t.definition.name : '');
const TOKEN = 'tok-123';

function mcpReply(msg: { id?: number; method: string; params?: Record<string, unknown> }): unknown {
  switch (msg.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'secure', version: '1' } } };
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami', description: 'who', inputSchema: { type: 'object' } }] } };
    case 'tools/call':
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'authed' }] } };
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
}

describe('MCP OAuth (real flow)', () => {
  it('redirects, exchanges the code, then connects with the bearer', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const base = `${url.protocol}//${url.host}`;
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
        }
        if (url.pathname === '/register') return Response.json({ client_id: 'cid-1' });
        if (url.pathname === '/token') return Response.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 });
        if (url.pathname === '/mcp') {
          if (req.method === 'GET') return new Response(null, { status: 405 });
          if (req.method === 'DELETE') return new Response(null, { status: 200 });
          if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 });
          const out = mcpReply(await req.json());
          return out === null ? new Response(null, { status: 202 }) : Response.json(out);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const base = `http://localhost:${server.port}`;
    let tokens: McpOAuthTokens | undefined;
    let verifier = '';
    let savedState = '';
    let clientInfo: McpOAuthClientInfo | undefined;
    let redirected = '';
    const provider: McpAuthProvider = {
      redirectUrl: 'http://localhost/cb',
      clientMetadata: { redirect_uris: ['http://localhost/cb'], client_name: 'test', scope: 'mcp' },
      clientInformation: () => clientInfo,
      saveClientInformation: (i) => {
        clientInfo = i;
      },
      tokens: () => tokens,
      saveTokens: (t) => {
        tokens = t;
      },
      redirectToAuthorization: (u) => {
        redirected = u;
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
      saveState: (s) => {
        savedState = s;
      },
      state: () => savedState,
    };

    // Local-dev test server uses http://localhost; opt-in to the escape hatches explicitly.
    const localDevSecurity = { allowInsecureHttp: true, allowLoopback: true };
    const engine = createEngine({ registerAsDefault: false });
    try {
      // 1) no tokens -> redirect -> McpUnauthorizedError
      await expect(connectMcp({ url: `${base}/mcp`, name: 'sec' }, { engine, auth: provider, security: localDevSecurity })).rejects.toThrow(McpUnauthorizedError);
      expect(redirected).toContain('code_challenge=');
      expect(redirected).toContain('state=');
      expect(clientInfo?.client_id).toBe('cid-1'); // registered during redirect setup

      // 2) finish the grant (exchange the callback code) — pass the state from the redirect URL
      const stateFromCallback = new URL(redirected).searchParams.get('state') ?? '';
      await finishMcpAuth(`${base}/mcp`, 'authcode', stateFromCallback, { auth: provider, engine, security: localDevSecurity });
      expect(tokens?.access_token).toBe(TOKEN);

      // 3) reconnect — now authorized
      const mcp = await connectMcp({ url: `${base}/mcp`, name: 'sec' }, { engine, auth: provider, security: localDevSecurity });
      const tool = mcp.tools.find((t) => fnName(t) === 'sec__whoami');
      expect(tool).toBeDefined();
      expect(await tool?.execute({}, ctx())).toBe('authed');
      await mcp.close();
    } finally {
      engine.destroy();
      server.stop(true);
    }
  });
});
