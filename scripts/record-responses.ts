/** Record what providers actually SEND BACK, so the parse side has the same kind
 *  of evidence the request side already has.
 *
 *  All seven frozen corpora are REQUEST corpora: what we put on the wire, captured
 *  from real behaviour and each proven to fail on deliberate corruption. The parse
 *  side had no equivalent — `parseResponse` is exercised against literals written
 *  by hand in the test files, which tests what the author BELIEVED the provider
 *  returns. Let a provider rename `usage.output_tokens` and cost silently goes to
 *  zero while every one of those tests stays green.
 *
 *  So this records the real thing, straight off the bus: `onCompletion.responseBody`
 *  is the pre-parse body, and `onStreamChunk.raw` is each SSE event exactly as
 *  `createStreamParser()` receives it. Replaying needs no network and no stub.
 *
 *  Alongside each recording it stores what our parser makes of it TODAY. The two
 *  have different jobs:
 *
 *    `raw`    is the provider's truth. It changes only when a provider changes,
 *             and only when this script is re-run with --refresh.
 *    `parsed` is our behaviour. The differential recomputes it and compares, so a
 *             parser change surfaces as a failing test rather than as a quiet
 *             difference in what every consumer receives.
 *
 *  Usage:
 *    bun run scripts/record-responses.ts                 # add missing cells only
 *    bun run scripts/record-responses.ts --refresh       # re-record everything
 *    bun run scripts/record-responses.ts --target anthropic/messages
 *    bun run scripts/record-responses.ts --scenario stream.text
 *
 *  Cells are ADDED and REFRESHED, never dropped: a target that fails today must
 *  not delete a recording made when it worked. Failures are reported; the existing
 *  cell stays exactly as it was.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEngine, createLLM } from '../src/index';
import type { HookEvent } from '../src/bus/hook-map';
import type { SSEEvent } from '../src/network/types';
import {
  adapterFor,
  cellId,
  RESPONSE_SCENARIOS,
  RESPONSE_TARGETS,
  type ResponseCell,
} from '../tests/unit/llm/response-corpus';

const FIXTURE = resolve(import.meta.dir, '../tests/fixtures/response-golden.json');

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const fixture: Record<string, ResponseCell> = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, ResponseCell>)
  : {};
const before = Object.keys(fixture).length;

const onlyTarget = arg('target');
const onlyScenario = arg('scenario');
const refresh = flag('refresh');

const { getApiKey } = await import('../../official-samples/keys.ts');

const added: string[] = [];
const refreshed: string[] = [];
const failed: string[] = [];
let kept = 0;

for (const target of RESPONSE_TARGETS) {
  if (onlyTarget && target.key !== onlyTarget) continue;

  let apiKey: string;
  try {
    apiKey = await getApiKey(target.keyring);
  } catch (e) {
    failed.push(`${target.key}: no key — ${(e as Error).message}`);
    continue;
  }

  for (const scenario of RESPONSE_SCENARIOS) {
    if (onlyScenario && scenario.name !== onlyScenario) continue;
    const id = cellId(target.key, scenario.name);

    if (fixture[id] && !refresh) {
      kept++;
      continue;
    }

    // A fresh engine per cell: the tap must see one call's events, not a mix.
    const engine = createEngine({ registerAsDefault: false });
    const sse: SSEEvent[] = [];
    let body: unknown;

    const untap = engine.hooks.onAny((event: HookEvent) => {
      if (event.type === 'onStreamChunk') sse.push(event.ctx.raw as SSEEvent);
      else if (event.type === 'onCompletion') body = event.ctx.responseBody;
    });

    try {
      const llm = createLLM({
        engine,
        provider: target.provider,
        model: target.model,
        apiKey,
        ...(target.api ? { api: target.api } : {}),
      } as Parameters<typeof createLLM>[0]);

      // The adapter is rebuilt rather than read off the client, which keeps it
      // private and makes the recorder use the identical construction the
      // differential will use to replay.
      const adapter = adapterFor(target, apiKey);
      let parsed: unknown;

      if (scenario.streaming) {
        // Drained on purpose: the events are the recording, the text is incidental.
        for await (const _event of llm.stream(scenario.input, scenario.options)) void _event;
        if (sse.length === 0) throw new Error('no SSE events reached the bus');
        const parse = adapter.createStreamParser();
        parsed = sse.flatMap((e) => parse(e));
      } else {
        await llm.complete(scenario.input, scenario.options);
        if (body === undefined) throw new Error('no response body reached the bus');
        // Latency is fixed: it is wall-clock, and a corpus must not depend on it.
        parsed = adapter.parseResponse(body, 0);
      }

      const cell: ResponseCell = {
        target: target.key,
        scenario: scenario.name,
        provider: target.provider,
        model: target.model,
        ...(target.api ? { api: target.api } : {}),
        streaming: scenario.streaming,
        recordedAt: new Date().toISOString().slice(0, 10),
        raw: scenario.streaming ? sse : body,
        parsed,
      };
      (fixture[id] ? refreshed : added).push(id);
      fixture[id] = cell;
      console.log(`  ok  ${id}`);
    } catch (e) {
      // A failure never deletes what is already there.
      failed.push(`${id}: ${(e as Error).message}`);
      console.log(`  --  ${id}: ${(e as Error).message}`);
    } finally {
      untap();
      await engine.destroy();
    }
  }
}

writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);

const sizeKb = Math.round(readFileSync(FIXTURE).byteLength / 1024);
console.log(`\nresponse corpus: ${Object.keys(fixture).length} cells (was ${before}), ${sizeKb} KB`);
console.log(`  added:     ${added.length}${added.length ? ` — ${added.join(', ')}` : ''}`);
console.log(`  refreshed: ${refreshed.length}${refreshed.length ? ` — ${refreshed.join(', ')}` : ''}`);
console.log(`  kept:      ${kept}`);
if (failed.length) {
  console.log(`  FAILED:    ${failed.length}`);
  for (const f of failed) console.log(`    - ${f}`);
  process.exitCode = 1;
}
