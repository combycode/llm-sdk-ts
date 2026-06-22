/** LocalBackend — in-repo tool library. Synchronous registration, async access. */

import type { ToolBackend, InternalTool } from '../types';

export class LocalBackend implements ToolBackend {
  readonly name = 'local';
  private tools = new Map<string, InternalTool>();

  register(tool: InternalTool): this {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool ${tool.id} already registered. Use replace() to overwrite.`);
    }
    this.tools.set(tool.id, tool);
    return this;
  }

  replace(tool: InternalTool): this {
    this.tools.set(tool.id, tool);
    return this;
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  get size(): number {
    return this.tools.size;
  }

  async list(): Promise<InternalTool[]> {
    return [...this.tools.values()];
  }

  async get(id: string): Promise<InternalTool | null> {
    return this.tools.get(id) ?? null;
  }
}
