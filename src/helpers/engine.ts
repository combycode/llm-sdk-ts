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
import type { ProviderName } from '../llm/types/provider';
import { NetworkEngine } from '../network/engine';
import type { EngineConnect, EngineFetch, EngineFetchStream, FetchFn } from '../network/types';
import { Cache } from '../plugins/cache/cache';
import { MemoryCacheStore } from '../plugins/cache/memory-store';
import { CostCollector } from '../plugins/cost-collector/collector';
import { ModelCatalog } from '../plugins/model-catalog/catalog';
import { FilePersistence } from '../plugins/persistence/file';
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
  /** API keys per provider. Helpers (createLLM, createAgent,
   *  createMediaOutput, complete) read these to wire LLM clients without
   *  the caller passing apiKey explicitly. */
  apiKeys: Partial<Record<ProviderName, string>>;
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
  /** Catalog wiring. Pass:
   *    - `true` / 'defaults' → load every bundled provider catalog.json
   *    - existing ModelCatalog instance → use as-is
   *    - `{ entries: {...} }` → build empty + load() the entries
   *    - undefined → empty catalog */
  catalog?: ModelCatalog | true | 'defaults' | { entries: Record<string, unknown> };
  /** Per-provider API keys. Helpers consult this when no apiKey is passed
   *  alongside `model: 'provider/...'`. */
  apiKeys?: Partial<Record<ProviderName, string>>;
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

  const network = new NetworkEngine({ hooks, fetch: config.fetch });
  // `fetch`/`fetchStream` reference the engine's own queue layer.
  const fetchBound: EngineFetch = (req, options) => network.fetch(req, options);
  const fetchStreamBound: EngineFetchStream = (req, options) => network.fetchStream(req, options);
  const connectBound: EngineConnect = (req) => network.connect(req);

  const cost = new CostCollector({ hooks, catalog });

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
    apiKeys: config.apiKeys ?? {},
    destroy(): void {
      cost.destroy();
      network.destroy();
    },
  };

  if (config.registerAsDefault !== false) {
    coreRegistry.set(handle);
  }

  return handle;
}

function resolveCatalog(config: EngineConfig['catalog']): ModelCatalog {
  const c = new ModelCatalog();
  if (!config) return c;
  if (config instanceof ModelCatalog) return config;
  if (config === true || config === 'defaults') {
    c.loadProviderDefaults();
    return c;
  }
  if (typeof config === 'object' && 'entries' in config) {
    c.load(config.entries);
    return c;
  }
  return c;
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
