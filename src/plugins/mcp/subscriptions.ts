/** `subscriptions/listen` (2026-07-28, SEP-2575) — one stream for every change notification.
 *
 *  At 2026-07-28 the per-resource `resources/subscribe` RPC and the standalone notification channel
 *  are both replaced by a single long-lived `subscriptions/listen` request. The client names the
 *  notification kinds it wants; **every kind is opt-in and the server MUST NOT send one that was
 *  not asked for**. The server acknowledges with the subset it actually honoured, which can be
 *  smaller than what was requested — so "I asked for it" never implies "I will receive it".
 *
 *  Every frame on the stream is stamped with the listen request's id under
 *  `io.modelcontextprotocol/subscriptionId`, which is how frames are attributed to a subscription.
 *
 *  Events are **level triggers**: "this changed, re-fetch if you care". They carry no payload
 *  beyond the fact of the change, so consecutive identical events collapse safely.
 */

import { MCP_SUBSCRIPTION_ID_META_KEY } from './protocol-version';

/** The notification kinds a client may opt into. Mirrors the wire `SubscriptionFilter`. */
export interface McpSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Resource URIs to watch — the replacement for the `resources/subscribe` RPC. */
  resourceSubscriptions?: string[];
}

/** A change the server announced. Level triggers: re-fetch if you care. */
export type McpServerEvent =
  | { type: 'tools_list_changed' }
  | { type: 'prompts_list_changed' }
  | { type: 'resources_list_changed' }
  | { type: 'resource_updated'; uri: string };

/** The notification methods that ride a listen stream at 2026-07-28. */
export const MCP_LISTEN_STREAM_METHODS = [
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
] as const;

/** The ack frame that carries the honoured subset. */
export const MCP_SUBSCRIPTIONS_ACKNOWLEDGED = 'notifications/subscriptions/acknowledged';

/** The event a raw stream frame announces, or undefined when it carries none. */
export function eventFromWire(method: string, params: unknown): McpServerEvent | undefined {
  switch (method) {
    case 'notifications/tools/list_changed':
      return { type: 'tools_list_changed' };
    case 'notifications/prompts/list_changed':
      return { type: 'prompts_list_changed' };
    case 'notifications/resources/list_changed':
      return { type: 'resources_list_changed' };
    case 'notifications/resources/updated': {
      const uri = (params as { uri?: unknown } | undefined)?.uri;
      return typeof uri === 'string' ? { type: 'resource_updated', uri } : undefined;
    }
    default:
      return undefined;
  }
}

/** The subscription id stamped on a frame, or undefined when it is not a listen frame. */
export function subscriptionIdFrom(params: unknown): string | number | undefined {
  const meta = (params as { _meta?: unknown } | undefined)?._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (meta as Record<string, unknown>)[MCP_SUBSCRIPTION_ID_META_KEY];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** A live subscription: the honoured filter once acknowledged, plus event delivery. */
export class McpSubscription {
  /** The subset the server agreed to send. `null` until the ack arrives — and it can be NARROWER
   *  than what was requested, so check it rather than assuming. */
  honored: McpSubscriptionFilter | null = null;
  private closed = false;
  private endState: { error?: unknown } | null = null;

  constructor(
    readonly id: string | number,
    readonly requested: McpSubscriptionFilter,
    private readonly onEvent: (event: McpServerEvent) => void,
    private readonly onClose: () => void,
  ) {}

  /** Feed a raw stream frame. Returns true when it belonged to this subscription. */
  handleFrame(method: string, params: unknown): boolean {
    if (this.closed) return false;
    if (subscriptionIdFrom(params) !== this.id) return false;

    if (method === MCP_SUBSCRIPTIONS_ACKNOWLEDGED) {
      const filter = (params as { notifications?: unknown } | undefined)?.notifications;
      // A missing filter is malformed, NOT an empty one — treating it as empty would silently
      // report that the server honoured nothing.
      if (filter && typeof filter === 'object') this.honored = filter as McpSubscriptionFilter;
      return true;
    }

    const event = eventFromWire(method, params);
    if (!event) return false;
    this.onEvent(event);
    return true;
  }

  /** True when the server acknowledged this kind. Unacknowledged ⇒ do not expect events. */
  isHonored(kind: keyof McpSubscriptionFilter): boolean {
    const value = this.honored?.[kind];
    return Array.isArray(value) ? value.length > 0 : value === true;
  }

  /** Set once the stream ends: `undefined` for a clean server-side teardown, otherwise the error
   *  that killed it. A subscription that stopped delivering is otherwise indistinguishable from one
   *  where nothing has changed yet. */
  get ended(): { error?: unknown } | null {
    return this.endState;
  }

  /** True while the subscription can still deliver. */
  get active(): boolean {
    return !this.closed;
  }

  /** Called by the transport when the underlying stream finishes. */
  markEnded(error?: unknown): void {
    if (this.closed) return;
    this.endState = { ...(error !== undefined ? { error } : {}) };
    this.closed = true;
    this.onClose();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endState = {};
    this.onClose();
  }
}
