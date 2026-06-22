/** ContextRegistry types — layered, observable, composable context storage. */

import type { ContentPart } from '../../llm/types/messages';
import type { TokenCounter } from '../types';
import type { ContextRegistry as ContextRegistryClass } from './registry';

/** A named, versioned slice of context. Each mutation bumps `version`. */
export interface ContextLayer {
  /** Unique within a single registry. Also the subscribe() pattern target. */
  name: string;
  /** Free-form content. Strings are most common; ContentPart[] supports multi-modal
   *  and structured hints (tool calls / results). Rendering flattens to text. */
  content: string | ContentPart[];
  /** Sort key when rendering. Lower renders earlier. Default 100. */
  priority: number;
  /** Free-form grouping tags. Render filters by tag. */
  tags: string[];
  /** Who wrote this last. Useful for audit and per-owner filtering. */
  owner?: string;
  /** Monotonic — bumps on every set/patch. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** When true AND a parent registry has a same-named layer, composed render
   *  concatenates parent content BEFORE this layer's content instead of
   *  replacing. Used for additive layers (facts, memory). Default: false. */
  mergeParent?: boolean;
  /** Owner-supplied arbitrary data. Not serialized further. */
  metadata?: Record<string, unknown>;
}

/** Registry construction config. */
export interface ContextRegistryConfig {
  /** Stable ID. Auto-generated if absent. */
  id?: string;
  /** Parent registry — registry inherits layers from parent when rendering.
   *  Child can override same-named layers OR merge them via `mergeParent`. */
  parent?: ContextRegistryClass;
  /** Token counter for sizeTokens() method. */
  counter?: TokenCounter;
  /** Default owner tag for mutations that don't specify one. */
  defaultOwner?: string;
  /** Separator between rendered parts in .flat output. Default '\n\n'. */
  separator?: string;
}

/** Partial fields for set/patch — missing fields inherit from existing layer
 *  (if any) or use defaults. */
export interface SetLayerOptions {
  priority?: number;
  tags?: string[];
  owner?: string;
  mergeParent?: boolean;
  metadata?: Record<string, unknown>;
}

/** Render filter + formatting options. */
export interface RenderOptions {
  /** Only include layers whose name is in this list. */
  include?: string[];
  /** Skip layers whose name is in this list. */
  exclude?: string[];
  /** Only include layers that have this tag. */
  tag?: string;
  /** Only include layers that have AT LEAST ONE of these tags. */
  tags?: string[];
  /** Only include layers with this owner. */
  ownerFilter?: string;
  /** Separator between parts when producing .flat. */
  separator?: string;
  /** When false, skip parent chain — render only this registry's layers.
   *  Default: true (compose parent chain). */
  includeParent?: boolean;
}

/** One entry in the rendered output. */
export interface RenderedPart {
  name: string;
  content: string;
  priority: number;
  tags: string[];
  owner?: string;
  /** ID of the registry this layer was sourced from (this registry or a parent).
   *  Crucial for debugging cascades. */
  registry: string;
}

/** Structured result of render(). .flat is the string for immediate use. */
export interface RenderResult {
  parts: RenderedPart[];
  flat: string;
  totalChars: number;
  rendered: number;
}

/** Change event fired on set/update/remove. Also bubbles from parents. */
export interface ContextRegistryEvent {
  type: 'set' | 'update' | 'remove';
  name: string;
  previous?: ContextLayer;
  current?: ContextLayer;
  /** ID of the registry that originated this change (not the one forwarding). */
  registry: string;
  /** Total chars of the emitting registry BEFORE the change. */
  sizeBefore: number;
  /** Total chars of the emitting registry AFTER the change. */
  sizeAfter: number;
  timestamp: number;
}

export type RegistryEventHandler = (event: ContextRegistryEvent) => void;
export type SizeChangeHandler = (totalChars: number, delta: number) => void;

/** Persistence snapshot. Does NOT serialize parent — that's a runtime relationship. */
export interface RegistrySnapshot {
  v: 1;
  id: string;
  layers: ContextLayer[];
  separator: string;
}
