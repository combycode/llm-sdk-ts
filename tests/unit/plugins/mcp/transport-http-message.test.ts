/** Answering a server-initiated request on Streamable HTTP.
 *
 *  On HTTP the server->client channel is a GET SSE stream, and it is one-way: a request arriving
 *  on it (sampling, elicitation, roots) cannot be answered down the same stream. The transport
 *  therefore POSTs the JSON-RPC response back as a separate call. Without that, every server
 *  request over HTTP would hang until the server timed it out. */

import { describe, expect, it } from 'bun:test';
import { HttpTransport } from '../../../../src/plugins/mcp/transport-http';
import { McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import type { SSEEvent } from '../../../../src/network/types';

/** A GET stream the test feeds frames into, plus a recording plain fetch. */
function makeDeps() {
  const posts: Array<{ method?: string; body: Record<string, unknown> }> = [];
  const queue: SSEEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const push = (ev: SSEEvent) => {
    queue.push(ev);
    wake?.();
    wake = null;
  };
  const end = () => {
    done = true;
    wake?.();
    wake = null;
  };

  const fetchStream = (() => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift() as SSEEvent;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  })) as never;

  const fetch = (async (req: { method?: string; body: Record<string, unknown> }) => {
    posts.push({ method: req.method, body: req.body });
    return { status: 202, headers: {}, body: {}, text: '' };
  }) as never;

  return { deps: { fetch, fetchStream } as never, posts, push, end };
}

/** Deliver one JSON-RPC message on the GET channel and let the transport react. */
async function deliver(push: (ev: SSEEvent) => void, msg: unknown) {
  push({ data: JSON.stringify(msg) });
  await new Promise((r) => setTimeout(r, 10));
}

describe('HttpTransport: answering a server-initiated request', () => {
  it('POSTs the handler result back as a JSON-RPC response echoing the id', async () => {
    const { deps, posts, push, end } = makeDeps();
    const t = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps);
    t.setHandlers({ onRequest: async (method) => ({ answered: method }) });
    t.listen();

    await deliver(push, { jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} });

    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].body).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: { answered: 'roots/list' } });

    end();
    await t.close();
  });

  it('POSTs an error response when no handler is registered, rather than leaving the server waiting', async () => {
    const { deps, posts, push, end } = makeDeps();
    const t = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps);
    t.listen();

    await deliver(push, { jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} });

    expect(posts[0]?.body).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: McpErrorCode.MethodNotFound, message: 'no request handler' },
    });

    end();
    await t.close();
  });

  it('does not POST anything for a plain notification', async () => {
    // Only a request (id + method) is answered; posting a response to a notification would be a
    // protocol violation.
    const { deps, posts, push, end } = makeDeps();
    const t = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps);
    const seen: string[] = [];
    t.setHandlers({ onNotification: (m) => seen.push(m) });
    t.listen();

    await deliver(push, { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });

    expect(seen).toEqual(['notifications/tools/list_changed']);
    expect(posts).toEqual([]);

    end();
    await t.close();
  });
});
