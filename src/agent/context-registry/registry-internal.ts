/** ContextRegistry rendering helpers — layer filtering, sorting, and text
 *  flattening. Pure functions split out of registry.ts to keep the class file
 *  focused on the registry behavior. */

import type { ContentPart } from '../../llm/types/messages';
import type { ContextLayer, RenderOptions } from './types';

export interface CollectedEntry {
  layer: ContextLayer;
  source: string;
}

export function passesFilter(layer: ContextLayer, opts: RenderOptions): boolean {
  if (opts.include && !opts.include.includes(layer.name)) return false;
  if (opts.exclude?.includes(layer.name)) return false;
  if (opts.tag && !layer.tags.includes(opts.tag)) return false;
  if (opts.tags && !opts.tags.some((t) => layer.tags.includes(t))) return false;
  if (opts.ownerFilter && layer.owner !== opts.ownerFilter) return false;
  return true;
}

export function sortLayers(a: CollectedEntry, b: CollectedEntry): number {
  if (a.layer.priority !== b.layer.priority) return a.layer.priority - b.layer.priority;
  if (a.layer.updatedAt !== b.layer.updatedAt) return a.layer.updatedAt - b.layer.updatedAt;
  return a.layer.name.localeCompare(b.layer.name);
}

export function layerToText(layer: ContextLayer): string {
  if (typeof layer.content === 'string') return layer.content;
  return contentPartsToText(layer.content);
}

function contentPartsToText(content: ContentPart[]): string {
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text);
    else if (p.type === 'tool_call')
      parts.push(`[tool_call ${p.name}](${JSON.stringify(p.arguments)})`);
    else if (p.type === 'tool_result') {
      const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
      parts.push(`[tool_result] ${c}`);
    }
    // Images / audio / video don't contribute to text size — skipped.
  }
  return parts.join('\n');
}

export function concatContent(
  a: string | ContentPart[],
  b: string | ContentPart[],
): string | ContentPart[] {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  const aStr = typeof a === 'string' ? a : contentPartsToText(a);
  const bStr = typeof b === 'string' ? b : contentPartsToText(b);
  return `${aStr}\n\n${bStr}`;
}

export function cryptoRandomShort(): string {
  return crypto.randomUUID().slice(0, 8);
}
