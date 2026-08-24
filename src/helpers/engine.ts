/** createEngine — build an EngineHandle bag of plugin instances.
 *
 *  The EngineHandle is a thin coordinator: shared HookBus + AgentBus,
 *  optional persistence/cache, NetworkEngine (which owns multi-queue HTTP),
 *  and convenience accessors for downstream helpers. Classes never consult
 *  the engine directly; only the createLLM/createAgent/createServer helpers
 *  resolve fetch/hooks against it.
 *
 *  Usage:
 *
 *    const engine = createEngine({
 *      persistence: { type: 'file', dir: './data' },
 *      cache: { type: 'memory' },
 *    });
 *
 *    const llm = createLLM({ provider: 'anthropic', model: '...', apiKey: '...' });
 *    // llm.client uses engine.fetch + engine.hooks automatically. */

import { AgentBus } from '../bus/agent-bus';
import { HookBus } from '../bus/hook-bus';
import type { LLMClient } from '../llm/client';
import { createLLM, type CreateLLMOptions } from './llm';
import type { ProviderName } from '../llm/types/provider';
import { NetworkEngine, type QueueSettings } from '../network/engine';
import type { RetryPolicyOverride } from '../network/queue-state-config';
import type { EngineConnect, EngineFetch, EngineFetchStream, FetchFn } from '../network/types';
import { Cache } from '../plugins/cache/cache';
import { MemoryCacheStore } from '../plugins/cache/memory-store';
import { CostCollector } from '../plugins/cost-collector/collector';
import { ModelCatalog } from '../catalog/catalog';
import { FilePersistence } from '../plugins/persistence/file';
import { TelemetryAdapter, type TelemetryAdapterOptions } from '../plugins/telemetry/telemetry';
import { MemoryPersistence } from '../plugins/persistence/memory';
import type { Persistence } from '../plugins/persistence/types';

// ─── Engine handle ─────────────────────────────────────────────────────

export interface EngineHandle {
  /** Trace session id — minted once for this engine (the holder), shared by
   *  every request built against it. The session half of the OTel trace id. */
  sessionId: string;
  /** Shared HookBus across all subsystems built against this engine. */
  hooks: HookBus;
  /** Shared AgentBus for plugin → tool / module event communication. */
  bus: AgentBus;
  /** Persistence plugin. Always present — defaults to in-memory when no
   *  `persistence` option was passed to `createEngine`. */
  persistence: Persistence;
  /** Optional Cache plugin. */
  cache: Cache | null;
  /** Network engine — owns the queue map and fetch lifecycle. */
  network: NetworkEngine;
  /** Bound NetworkEngine.fetch (function reference for LLMClient injection). */
  fetch: EngineFetch;
  /** Bound NetworkEngine.fetchStream. */
  fetchStream: EngineFetchStream;
  /** Bound NetworkEngine.connect — opens a realtime WebSocket (queue-exempt). */
  connect: EngineConnect;
  /** ModelCatalog. Always present — populated synchronously with provider
   *  defaults when `engine.catalog: 'defaults'` (or `true`), else empty.
   *  CostCollector / MediaOutput / ContextGuard / ContextMeasurer all
   *  consult this. */
  catalog: ModelCatalog;
  /** CostCollector — subscribes to onCompletion + onMediaGenerated and
   *  prices via catalog. Call `engine.cost.total()` for a running tally. */
  cost: CostCollector;
  /** TelemetryAdapter — present only when `telemetry` was configured, because an
   *  unwanted one would sit there accumulating spans for a process that never reads
   *  them. Subscribe with `engine.telemetry.onTrace(...)`, or use it directly. */
  telemetry: TelemetryAdapter | null;
  /** API keys per provider. Helpers (createLLM, createAgent,
   *  createMediaOutput, complete) read these to wire LLM clients without
   *  the caller passing apiKey explicitly. */
  apiKeys: Partial<Record<ProviderName, string>>;
  /** Whether clients built from this engine check response shapes. Read by
   *  `createLLM`; see `checkResponseShapes` on the options. */
  checkResponseShapes: boolean;
  /** Build an LLMClient bound to this engine.
   *
   *  Exists so lower layers can obtain a client without importing the helpers
   *  layer: `plugins/internal-tools` needs one for LLM-backed tools, and
   *  importing `createLLM` directly made `plugins` depend on `helpers` while
   *  `helpers` already depended on `plugins` — a cycle that a Rust crate split
   *  cannot express. The engine is something those plugins already hold, so it
   *  is the natural place to hand the capability down. */
  createClient(options: Omit<CreateLLMOptions, 'engine'>): LLMClient;
  /** Tear down all owned plugins. */
  destroy(): void;
}

// ─── Configuration ─────────────────────────────────────────────────────

export interface PersistenceConfig {
  type: 'memory' | 'file';
  /** When type='file': directory under which entries are stored. */
  dir?: string;
}

export interface CacheConfig {
  type: 'memory';
}

export interface EngineConfig {
  /** Trace session id. Pass one from a parent holder (server / orchestrator) to
   *  correlate; omitted → a fresh `sess_…` is minted for this engine's lifetime. */
  sessionId?: string;
  /** Optional shared HookBus — when omitted, a fresh one is created. */
  hooks?: HookBus;
  /** Optional shared AgentBus. */
  bus?: AgentBus;
  /** Optional persistence backing for plugins that want durability. */
  persistence?: PersistenceConfig | Persistence;
  /** Optional cache. */
  cache?: CacheConfig | Cache;
  /** Custom low-level fetch transport — forwarded to the NetworkEngine's queue
   *  (so retry/rate-limit/hooks still apply). Defaults to globalThis.fetch. */
  fetch?: FetchFn;
  /** Warn when a provider's response stops looking like the one we learned to
   *  read: a field never seen before, a field that was always present and is now
   *  absent, or a discriminator carrying a value nothing branches on.
   *
   *  OFF by default. It never changes what is parsed — it only emits `onWarning`,
   *  so subscribe with `hooks.on('onWarning', …)` and look for codes starting
   *  `response_shape_`. Each distinct finding is reported ONCE per client.
   *
   *  Worth turning on in staging and in your test suite: response drift is the
   *  failure this library gives you the least warning about, because a renamed
   *  field still parses — into `undefined`. */
  checkResponseShapes?: boolean;
  /** Catalog wiring. **Defaults to the bundled provider catalogs.**
   *
   *  The catalog is what the adapters read per model: which wire spec builds the
   *  request, what the model costs, which tokenizer counts it. Starting empty
   *  meant every one of those silently fell back — the id-derived spec, an
   *  unknown price, an estimated token count — and nothing said so. The data is
   *  statically imported either way, so leaving it unloaded saved no bytes.
   *
   *    - undefined (default) / `true` / 'defaults' → every bundled catalog.json
   *    - existing ModelCatalog instance → use as-is
   *    - `{ entries: {...} }` → the given entries only
   *    - `false` / 'empty' → no entries. Everything falls back; say so on purpose. */
  catalog?: ModelCatalog | boolean | 'defaults' | 'empty' | { entries: Record<string, unknown> };
  /** Per-provider API keys. Helpers consult this when no apiKey is passed
   *  alongside `model: 'provider/...'`. */
  apiKeys?: Partial<Record<ProviderName, string>>;
  /** Observability. Omitted → no adapter is built and nothing is collected.
   *
   *  ```ts
   *  createEngine({
   *    telemetry: {
   *      types: ['agent', 'tool'],        // http/llm detail stays out
   *      content: 'none',                 // conversation text off by default
   *      sample: 0.05,                    // per trace, not per span
   *      onTrace: (e) => myPipeline.push(e),
   *    },
   *  });
   *  ```
   */
  telemetry?: TelemetryAdapterOptions;
  /** Retry policy for every request this engine makes.
   *
   *  Retry is a cross-cutting concern, so it is configured once here rather than threaded through
   *  each call. Anything omitted falls back to the built-in policy (`DEFAULT_RETRY`).
   *
   *  ```ts
   *  createEngine({ retry: { maxRetries: 5, backoff: { initialMs: 200, maxMs: 8_000 } } });
   *  ```
   *
   *  Three layers, narrowest wins: `HttpRequest.retry` (one request) > `queues[name].retry`
   *  (one provider queue) > this (everything). */
  retry?: RetryPolicyOverride;
  /** Per-queue overrides, keyed by queue name (`provider/model` unless routed otherwise).
   *  Use when one provider needs a different policy from the rest. */
  queues?: Record<string, QueueSettings>;
  /** Register this engine as the default for `coreRegistry.get()` (used by
   *  helpers when the caller doesn't pass an explicit `engine`). Defaults to
   *  `true` so `createEngine({ ... })` followed by helper calls just works.
   *  The FIRST `createEngine()` becomes the default; a second one throws unless
   *  you pass `registerAsDefault: false` (then pass that engine explicitly to
   *  helpers). */
  registerAsDefault?: boolean;
}

// ─── Implementation ────────────────────────────────────────────────────

export function createEngine(config: EngineConfig = {}): EngineHandle {
  const sessionId = config.sessionId ?? `sess_${crypto.randomUUID().slice(0, 12)}`;
  const hooks = config.hooks ?? new HookBus();
  const bus = config.bus ?? new AgentBus();

  const persistence = resolvePersistence(config.persistence);
  const cache = resolveCache(config.cache);
  const catalog = resolveCatalog(config.catalog);

  const network = new NetworkEngine({ hooks, fetch: config.fetch, retry: config.retry, queues: config.queues });
  // `fetch`/`fetchStream` reference the engine's own queue layer.
  const fetchBound: EngineFetch = (req, options) => network.fetch(req, options);
  const fetchStreamBound: EngineFetchStream = (req, options) => network.fetchStream(req, options);
  const connectBound: EngineConnect = (req) => network.connect(req);

  const cost = new CostCollector({ hooks, catalog });
  // The SDK never sends telemetry anywhere. It hands you events, filtered the way you
  // asked, and your pipeline — which already exists and already has the business spans
  // that matter more than ours — decides where they go.
  const telemetry = config.telemetry ? new TelemetryAdapter(hooks, config.telemetry) : null;

  const handle: EngineHandle = {
    sessionId,
    hooks,
    bus,
    persistence,
    cache,
    network,
    fetch: fetchBound,
    fetchStream: fetchStreamBound,
    connect: connectBound,
    catalog,
    cost,
    telemetry,
    apiKeys: config.apiKeys ?? {},
    checkResponseShapes: config.checkResponseShapes ?? false,
    // Bound inside the literal so the closure captures this handle. The body runs
    // only when a caller asks for a client, so referencing `handle` here is safe.
    createClient: (options) => createLLM({ ...options, engine: handle }),
    destroy(): void {
      cost.destroy();
      telemetry?.destroy();
      network.destroy();
    },
  };

  if (config.registerAsDefault !== false) {
    coreRegistry.set(handle);
  }

  return handle;
}

function resolveCatalog(config: EngineConfig['catalog']): ModelCatalog {
  if (config instanceof ModelCatalog) return config;
  // Opting OUT is explicit. Absent means the defaults, because an empty catalog
  // is not a neutral choice — it silently downgrades pinning, pricing and
  // counting all at once.
  if (config === false || config === 'empty') return new ModelCatalog();
  if (config && typeof config === 'object' && 'entries' in config) {
    const c = new ModelCatalog();
    c.load(config.entries);
    return c;
  }
  return ModelCatalog.withProviderDefaults();
}

function resolvePersistence(config: PersistenceConfig | Persistence | undefined): Persistence {
  if (!config) return new MemoryPersistence();
  // Already an instance — has the get/set/delete shape.
  if (typeof (config as Persistence).get === 'function') {
    return config as Persistence;
  }
  const c = config as PersistenceConfig;
  if (c.type === 'memory') return new MemoryPersistence();
  if (c.type === 'file') {
    if (!c.dir) {
      throw new Error('createEngine: persistence type "file" requires a `dir` field');
    }
    return new FilePersistence(c.dir);
  }
  throw new Error(`createEngine: unknown persistence type "${(c as { type: string }).type}"`);
}

function resolveCache(config: CacheConfig | Cache | undefined): Cache | null {
  if (!config) return null;
  if (config instanceof Cache) return config;
  const c = config as CacheConfig;
  if (c.type === 'memory') return new Cache({ store: new MemoryCacheStore() });
  throw new Error(`createEngine: unknown cache type "${(c as { type: string }).type}"`);
}

// ─── coreRegistry ──────────────────────────────────────────────────────

class CoreRegistry {
  private current: EngineHandle | null = null;

  /** Get the current default engine, creating a bare one on first read. */
  get(): EngineHandle {
    if (!this.current) this.current = createEngine();
    return this.current;
  }

  /** Set the default engine. Throws if one is already set unless replace=true.
   *  When replacing, the previous engine is destroyed AFTER the pointer
   *  swap so engine.destroy callbacks can safely query the registry. */
  set(engine: EngineHandle, opts: { replace?: boolean } = {}): void {
    if (this.current && !opts.replace) {
      throw new Error(
        'coreRegistry: an engine is already registered. Create additional engines with ' +
          'createEngine({ registerAsDefault: false }) and pass them explicitly to helpers, ' +
          'or use coreRegistry.set(engine, { replace: true }) to override.',
      );
    }
    const previous = this.current;
    this.current = engine;
    if (previous && opts.replace) {
      previous.destroy();
    }
  }

  /** Clear the default engine. */
  clear(): void {
    this.current?.destroy();
    this.current = null;
  }

  has(): boolean {
    return this.current !== null;
  }
}

export const coreRegistry = new CoreRegistry();
