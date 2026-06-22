/** ClientPool — keys LLMClients by provider (default) or (provider+model)
 *  when catalog marks a model as requiresDedicatedClient. Used by
 *  ClientResolver and (in the legacy SDK) by InternalToolRunner. */

import { LLMClient } from '../llm/client';
import type { LLMClientConfig } from '../llm/client-config';
import type { ModelCatalog } from '../plugins/model-catalog/catalog';

export class ClientPool {
  private clients = new Map<string, LLMClient>();

  constructor(private readonly catalog?: ModelCatalog) {}

  get(provider: string, model: string, config: LLMClientConfig): LLMClient {
    const key = this.keyFor(provider, model);
    let client = this.clients.get(key);
    if (!client) {
      client = new LLMClient({ ...config, model });
      this.clients.set(key, client);
    }
    return client;
  }

  async destroy(): Promise<void> {
    for (const [, client] of this.clients) {
      client.destroy();
    }
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  private keyFor(provider: string, model: string): string {
    const info = this.catalog?.get(provider, model);
    if (info?.requiresDedicatedClient) {
      return `${provider}/${model}`;
    }
    return provider;
  }
}
