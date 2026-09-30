/** A credential that spans Workspaces has to say which one it is acting in.
 *
 *  Anthropic accounts the Workspace for spend, rate limits and retention, and
 *  `anthropic-workspace-id` is what selects it. A key scoped to one Workspace
 *  may omit the header. A key that can act on SEVERAL and omits it does not
 *  fail — it charges the default Workspace, which is the worst failure mode
 *  available: silent, and only visible on a bill.
 *
 *  So it is sent on every Anthropic request we make, not only completions.
 *  Uploading a file or submitting a batch to the wrong Workspace is the same
 *  mistake as billing a turn there, and a header that covered only `/v1/messages`
 *  would look like the feature while leaving the hole.
 *
 *  Two ways in, because the two surfaces are shaped differently:
 *
 *  - completions: `providerOptions.workspaceId` per request, and an
 *    `AnthropicAdapter` constructed with one as the client-wide default. The
 *    request wins.
 *  - files, batches, counting, model listing: a `workspaceId` on their own
 *    config, since none of them is a completion and none has providerOptions.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { AnthropicFileAdapter } from '../../../src/llm/providers/anthropic/files';
import { AnthropicBatchAdapter } from '../../../src/llm/providers/anthropic/batch';

const WS = 'wrkspc_011CZkZaBF1tNoB5wlCeusgy';
const HEADER = 'anthropic-workspace-id';

/** The minimum a spec build needs from a normalized request. */
function req(providerOptions?: Record<string, unknown>) {
  return {
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    ...(providerOptions ? { providerOptions } : {}),
  } as never;
}

function headersOf(adapter: AnthropicAdapter, providerOptions?: Record<string, unknown>) {
  // The client composes them this way: the adapter's client-wide headers
  // first, the per-request envelope over the top.
  return { ...adapter.authHeaders(), ...(adapter.buildRequest(req(providerOptions)).headers ?? {}) };
}

describe('completions', () => {
  it('sends nothing when no workspace was named', () => {
    // The ordinary single-Workspace credential. Sending the header empty is a
    // different request from not sending it, and only the second one says
    // "this client was given no Workspace".
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k' }))).not.toHaveProperty(HEADER);
  });

  it('sends the client-wide default on every request', () => {
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k', workspaceId: WS }))[HEADER]).toBe(WS);
  });

  it('sends a per-request workspace with no client default', () => {
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k' }), { workspaceId: WS })[HEADER]).toBe(WS);
  });

  it('lets the request override the client default', () => {
    const other = 'wrkspc_other';
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k', workspaceId: WS }), { workspaceId: other })[HEADER]).toBe(
      other,
    );
  });

  it('keeps the client default when the request names none', () => {
    // An unrelated providerOption must not clear it.
    expect(
      headersOf(new AnthropicAdapter({ apiKey: 'k', workspaceId: WS }), { userProfileId: 'u_1' })[HEADER],
    ).toBe(WS);
  });

  it('ignores an empty string rather than sending a blank header', () => {
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k' }), { workspaceId: '' })).not.toHaveProperty(HEADER);
    expect(headersOf(new AnthropicAdapter({ apiKey: 'k', workspaceId: '' }))).not.toHaveProperty(HEADER);
  });

  it('does not disturb the other Anthropic headers', () => {
    const h = headersOf(new AnthropicAdapter({ apiKey: 'k', workspaceId: WS }));
    expect(h['x-api-key']).toBe('k');
    expect(h['anthropic-version']).toBeString();
  });
});

describe('the surfaces that are not completions', () => {
  it('a file upload carries it', () => {
    const adapter = new AnthropicFileAdapter({ apiKey: 'k', workspaceId: WS });
    const built = adapter.buildUploadRequest(
      { filename: 'x.bin', mimeType: 'application/octet-stream' } as never,
      new Uint8Array([1, 2, 3]),
    );
    expect((built.headers as Record<string, string>)[HEADER]).toBe(WS);
  });

  it('so does listing and deleting them', () => {
    const adapter = new AnthropicFileAdapter({ apiKey: 'k', workspaceId: WS });
    expect((adapter.buildListRequest().headers as Record<string, string>)[HEADER]).toBe(WS);
    expect((adapter.buildDeleteRequest('file_1').headers as Record<string, string>)[HEADER]).toBe(WS);
  });

  it('and none of them carries it when none was configured', () => {
    const adapter = new AnthropicFileAdapter({ apiKey: 'k' });
    expect(adapter.buildListRequest().headers as Record<string, string>).not.toHaveProperty(HEADER);
  });

  it('a batch carries it on every call, not only the submission', () => {
    // A batch is submitted once and polled many times; a header on the submit
    // alone would send the polls to the default Workspace.
    const adapter = new AnthropicBatchAdapter({ apiKey: 'k', workspaceId: WS });
    for (const built of [
      adapter.buildSubmitRequest([]),
      adapter.buildStatusRequest('batch_1'),
      adapter.buildResultsRequest('batch_1'),
      adapter.buildCancelRequest('batch_1'),
    ]) {
      expect((built.headers as Record<string, string>)[HEADER]).toBe(WS);
    }
  });

  it('a batch omits it when none was configured', () => {
    const adapter = new AnthropicBatchAdapter({ apiKey: 'k' });
    expect(adapter.buildStatusRequest('batch_1').headers as Record<string, string>).not.toHaveProperty(HEADER);
  });
});

describe('fetching back what a turn produced', () => {
  /** Retrieve one file through the real client, capturing the request. */
  async function retrieve(workspaceId?: string) {
    const seen: Array<Record<string, string>> = [];
    const fetch = ((req: { headers?: Record<string, string> }) => {
      seen.push({ ...(req.headers ?? {}) });
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      });
    }) as never;
    const { LLMClient } = await import('../../../src/llm/client');
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-haiku-4.5',
      apiKey: 'k',
      fetch,
      adapter: new AnthropicAdapter({ apiKey: 'k', ...(workspaceId ? { workspaceId } : {}) }),
    });
    await client.retrieveFile({ id: 'file_1', source: 'code_execution' });
    return seen;
  }

  it('carries the client Workspace', async () => {
    // `files.content` stands alone instead of extending `files.base`, so it
    // did NOT inherit the header the other file calls got -- the download went
    // to the default Workspace while every other call went to the right one.
    const seen = await retrieve(WS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[HEADER]).toBe(WS);
  });

  it('and sends none when the client has none', async () => {
    const seen = await retrieve();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty(HEADER);
  });
});
