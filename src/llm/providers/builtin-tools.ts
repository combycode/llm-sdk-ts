/** Hosted server-side tools each provider's chat models support.
 *
 *  This is ADAPTER-SOURCED: it reflects what the provider adapters actually map
 *  the unified `{ type: 'web_search' | 'code_interpreter' }` builtins onto (each
 *  to the provider's native shape), verified by the live tools-parity test. It is
 *  applied PROVIDER-LEVEL to tool-capable (chat-family) models at catalog load —
 *  a deliberate first pass; a reliable per-model source can refine it later.
 *
 *  Coverage (verified live 2026-07):
 *    - web_search       → anthropic, openai, google, xai, openrouter
 *    - code_interpreter → anthropic, openai, google, xai   (NOT openrouter: it
 *      proxies function tools + its own plugins, but does not route hosted code
 *      execution — confirmed against the API). */

import type { ProviderName } from '../types/provider';

export const PROVIDER_BUILTIN_TOOLS: Record<ProviderName, readonly string[]> = {
  anthropic: ['web_search', 'code_interpreter'],
  openai: ['web_search', 'code_interpreter'],
  google: ['web_search', 'code_interpreter'],
  xai: ['web_search', 'code_interpreter'],
  openrouter: ['web_search'],
};
