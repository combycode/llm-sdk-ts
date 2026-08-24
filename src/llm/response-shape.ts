/** Runtime shape check — tell me when a provider's response stops looking like the
 *  one we learned to read.
 *
 *  Parsing is the half of the library with the least warning before a failure. A
 *  request that goes wrong comes back as a 400. A RESPONSE that goes wrong comes
 *  back as a 200 with a field we do not read: the parse succeeds, the number is
 *  `undefined`, and the first sign is a cost dashboard that quietly reports zero
 *  or a tool call that never arrives. `google/generate` shipped for months
 *  discarding a `responseId` that had been there all along, under a comment saying
 *  it did not exist.
 *
 *  So this compares the body against a description of the shape we understand:
 *
 *    unknown path      a field we have never seen. Either the provider added it —
 *                      possibly the one carrying something we now want — or we are
 *                      talking to something that is not the API we think.
 *    missing path      a field present in EVERY recording is absent from this one.
 *                      That is the shape of a rename, and a rename is what silently
 *                      turns a token count into `undefined`.
 *    unknown value     a discriminator (`type`, `role`, `finish_reason`, …) carries
 *                      a value we do not branch on. A new content-block type is the
 *                      most expensive kind of drift there is, because the content
 *                      is simply dropped and nothing errors.
 *
 *  OFF by default, and it never changes what is parsed: it only emits `onWarning`.
 *  A check that could alter a response would be a new way to break one.
 *
 *  The descriptions in `response-shapes.json` are DERIVED, not hand-written —
 *  `scripts/derive-response-shapes.ts` builds them from the recorded corpus, and a
 *  test asserts every recorded body produces no unknown paths. That is what keeps
 *  the description honest: it cannot drift from real responses without a test going
 *  red, and when a provider does add a field, re-recording surfaces it as a
 *  decision rather than as a silent difference.
 */

import type { HookBus } from '../bus/hook-bus';
import type { SSEEvent } from '../network/types';

/** Keys whose VALUE selects a branch. A new value here is not a new field — it is
 *  a case nothing handles. */
const DISCRIMINATORS = new Set([
  'type',
  'object',
  'role',
  'finish_reason',
  'finishReason',
  'stop_reason',
  'status',
  'event',
]);

/** Guards against a pathological body — a map keyed by id would otherwise produce
 *  an unbounded set of paths and turn a diagnostic into a memory leak. */
const MAX_DEPTH = 10;
const MAX_PATHS = 2000;

export interface ShapeDecl {
  /** Every path seen across the recordings for this target. */
  known: string[];
  /** Paths present in EVERY recording — absence is worth a warning. */
  expected: string[];
  /** Discriminator path → the values we have actually seen. */
  values?: Record<string, string[]>;
}

export interface ShapeSet {
  /** The non-streaming body. */
  response?: ShapeDecl;
  /** One declaration PER SSE event type, keyed by the SSE `event:` name when the
   *  provider sends one and by the payload's own `type` otherwise.
   *
   *  Pooling every event type into one declaration was the first attempt, and it
   *  cost the missing-field check entirely: `message_start` and
   *  `content_block_delta` share almost no fields, so the intersection across a
   *  whole stream came to a single path and nothing could ever be reported
   *  absent. Per type, "this event always carries usage" becomes a statement
   *  worth making. */
  stream?: Record<string, ShapeDecl>;
}

/** How an SSE event names its own kind. The SSE `event:` line wins — Anthropic
 *  routes on it, and its payload `type` merely repeats it — then the payload's
 *  `type`, then a single bucket for providers that discriminate on neither
 *  (chat-completions chunks are all one shape). */
export function streamEventKey(event: SSEEvent, data: unknown): string {
  if (event.event) return event.event;
  const t = (data as { type?: unknown } | null)?.type;
  return typeof t === 'string' ? t : '*';
}

export type ShapeBook = Record<string, ShapeSet>;

export interface ShapeFindings {
  unknown: string[];
  missing: string[];
  /** `[path, value]` for a discriminator carrying something new. */
  unknownValues: Array<[string, string]>;
}

/** Collect the paths of a value. Array indices collapse to `[]` — otherwise a
 *  three-element list would describe a different shape than a four-element one. */
export function pathsOf(value: unknown, prefix = '', out = new Set<string>(), depth = 0): Set<string> {
  if (depth > MAX_DEPTH || out.size > MAX_PATHS) return out;
  if (Array.isArray(value)) {
    const p = `${prefix}[]`;
    out.add(p);
    for (const item of value) pathsOf(item, p, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${key}` : key;
      out.add(p);
      pathsOf(v, p, out, depth + 1);
    }
    return out;
  }
  return out;
}

/** Collect `path → value` for the discriminator keys only. */
export function discriminatorsOf(
  value: unknown,
  prefix = '',
  out: Array<[string, string]> = [],
  depth = 0,
): Array<[string, string]> {
  if (depth > MAX_DEPTH || out.length > MAX_PATHS) return out;
  if (Array.isArray(value)) {
    for (const item of value) discriminatorsOf(item, `${prefix}[]`, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (DISCRIMINATORS.has(key) && typeof v === 'string') out.push([p, v]);
      discriminatorsOf(v, p, out, depth + 1);
    }
    return out;
  }
  return out;
}

/** Compare one body against a declaration. Pure — the caller decides what to do. */
export function checkShape(body: unknown, decl: ShapeDecl): ShapeFindings {
  const seen = pathsOf(body);
  const known = new Set(decl.known);
  const unknown: string[] = [];
  for (const path of seen) if (!known.has(path)) unknown.push(path);

  const missing: string[] = [];
  for (const path of decl.expected) if (!seen.has(path)) missing.push(path);

  const unknownValues: Array<[string, string]> = [];
  if (decl.values) {
    for (const [path, value] of discriminatorsOf(body)) {
      const allowed = decl.values[path];
      // A path with no recorded values is not a claim about values — only a path
      // we HAVE seen values for can have an unexpected one.
      if (allowed && !allowed.includes(value)) unknownValues.push([path, value]);
    }
  }

  return { unknown: unknown.sort(), missing: missing.sort(), unknownValues };
}

/** Per-client checker. Holds what it has already reported, because the alternative
 *  is the same warning on every request for the rest of the process — which is how
 *  a diagnostic gets muted by the person reading it. */
export class ResponseShapeChecker {
  private readonly reported = new Set<string>();

  constructor(
    private readonly hooks: HookBus,
    private readonly provider: string,
    private readonly api: string,
    private readonly book: ShapeBook,
  ) {}

  /** The declaration for this client, or undefined when nothing was recorded for
   *  it — in which case the check stays silent rather than calling every field
   *  unknown. */
  private get set(): ShapeSet | undefined {
    return this.book[`${this.provider}/${this.api}`];
  }

  checkResponse(body: unknown): void {
    const decl = this.set?.response;
    if (decl) this.report('response', checkShape(body, decl));
  }

  checkStreamEvent(event: SSEEvent): void {
    const stream = this.set?.stream;
    if (!stream) return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      // A non-JSON payload is the stream's own business — `[DONE]` sentinels and
      // keep-alives are not shape drift.
      return;
    }
    const key = streamEventKey(event, data);
    const decl = stream[key];
    if (!decl) {
      // A whole event type nobody has seen. This is the one that matters most in
      // a stream: an unhandled event is skipped silently, so the reply is simply
      // missing a piece and nothing anywhere errors.
      this.warn('stream', 'unknown_event', `stream:@${key}`, `unhandled event type "${key}"`);
      return;
    }
    this.report(`stream ${key}`, checkShape(data, decl));
  }

  private report(kind: string, f: ShapeFindings): void {
    for (const path of f.unknown) this.warn(kind, 'unknown_field', `${kind}:${path}`, `new field ${path}`);
    for (const path of f.missing)
      this.warn(kind, 'missing_field', `${kind}:!${path}`, `field ${path} was always present and is now absent`);
    for (const [path, value] of f.unknownValues)
      this.warn(kind, 'unknown_value', `${kind}:${path}=${value}`, `${path} carries an unhandled value "${value}"`);
  }

  private warn(kind: string, code: string, dedupeKey: string, message: string): void {
    if (this.reported.has(dedupeKey)) return;
    this.reported.add(dedupeKey);
    this.hooks.emitSync('onWarning', {
      source: 'llm',
      code: `response_shape_${code}`,
      message: `${this.provider}/${this.api} ${kind}: ${message}`,
      details: { provider: this.provider, api: this.api, kind },
    });
  }
}
