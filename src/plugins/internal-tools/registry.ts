/** ToolRegistry — unified access across multiple backends with caching, search, filtering. */

import type { InternalTool, ToolBackend, ToolFilter, SearchOptions } from './types';
import type { ModelCatalog } from '../model-catalog/catalog';

export class ToolRegistry {
  private backends: ToolBackend[] = [];
  private cache: Map<string, InternalTool> | null = null;

  /** Add a backend. First-added wins on ID conflicts. Returns this for chaining. */
  addBackend(backend: ToolBackend): this {
    if (this.backends.some((b) => b.name === backend.name)) {
      throw new Error(`Backend "${backend.name}" already registered`);
    }
    this.backends.push(backend);
    this.invalidate();
    return this;
  }

  removeBackend(name: string): boolean {
    const idx = this.backends.findIndex((b) => b.name === name);
    if (idx < 0) return false;
    this.backends.splice(idx, 1);
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.cache = null;
  }

  async get(id: string): Promise<InternalTool | null> {
    await this.ensureCache();
    return this.cache!.get(id) ?? null;
  }

  async list(): Promise<InternalTool[]> {
    await this.ensureCache();
    return [...this.cache!.values()];
  }

  async find(filter: ToolFilter, catalog?: ModelCatalog): Promise<InternalTool[]> {
    const all = await this.list();
    return all.filter((t) => this.matchesFilter(t, filter, catalog));
  }

  async search(query: string, opts?: SearchOptions): Promise<InternalTool[]> {
    const all = await this.list();
    const q = query.toLowerCase().trim();
    if (!q) return all.slice(0, opts?.limit ?? 20);

    const scored: Array<{ tool: InternalTool; score: number }> = [];
    for (const tool of all) {
      if (opts?.namespace && tool.namespace !== opts.namespace) continue;
      const score = this.scoreMatch(tool, q);
      if (score > 0) scored.push({ tool, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts?.limit ?? 20).map((s) => s.tool);
  }

  /** Models with acceptable compatibility score for this tool, derived from
   *  catalog's `toolCompat` field on each ModelInfo. */
  modelsFor(toolId: string, opts?: { minScore?: number; catalog?: ModelCatalog }): string[] {
    const catalog = opts?.catalog;
    if (!catalog) return [];
    const minScore = opts?.minScore ?? 0.8;

    const matching: string[] = [];
    for (const info of catalog.list()) {
      const compat = (info as { toolCompat?: Record<string, { score: number }> }).toolCompat?.[
        toolId
      ];
      if (compat && compat.score >= minScore) {
        matching.push(`${info.provider}/${info.model}`);
      }
    }
    return matching;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async ensureCache(): Promise<void> {
    if (this.cache) return;
    const cache = new Map<string, InternalTool>();
    for (const backend of this.backends) {
      const tools = await backend.list();
      for (const tool of tools) {
        if (!cache.has(tool.id)) cache.set(tool.id, tool);
      }
    }
    this.cache = cache;
  }

  private matchesFilter(tool: InternalTool, filter: ToolFilter, catalog?: ModelCatalog): boolean {
    if (filter.namespace && tool.namespace !== filter.namespace) return false;
    if (filter.prefix && !tool.id.startsWith(filter.prefix)) return false;
    if (filter.tag && !tool.tags?.includes(filter.tag)) return false;
    if (filter.model && catalog) {
      const info = catalog.get(filter.model.provider, filter.model.model);
      const compat = (info as { toolCompat?: Record<string, { score: number }> } | null)
        ?.toolCompat?.[tool.id];
      if (!compat) return false;
      const minScore = filter.model.minScore ?? 0.8;
      if (compat.score < minScore) return false;
    }
    return true;
  }

  private scoreMatch(tool: InternalTool, q: string): number {
    const name = tool.name.toLowerCase();
    const desc = tool.description.toLowerCase();
    const tags = (tool.tags ?? []).map((t) => t.toLowerCase());

    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    if (tags.some((t) => t === q)) return 50;
    if (tags.some((t) => t.includes(q))) return 40;
    if (desc.includes(q)) return 20;
    return 0;
  }
}
