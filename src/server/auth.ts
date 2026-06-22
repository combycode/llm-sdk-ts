/** AuthPlugin — server-side authentication slot.
 *
 *  Servers without an AuthPlugin treat all requests as unauthenticated
 *  (userId = null). When attached, every request runs through `verify()`;
 *  the returned userId scopes the ResponseStore key. */

export interface AuthVerifyResult {
  /** Stable owner id used to scope ResponseStore entries. */
  userId: string;
  /** Free-form metadata for downstream plugins (roles, scopes, etc.). */
  metadata?: Record<string, unknown>;
}

export interface AuthPlugin {
  /** Inspect request headers and return the authenticated userId, or throw to reject. */
  verify(headers: Record<string, string>): Promise<AuthVerifyResult> | AuthVerifyResult;
}

/** Bearer key auth — the simplest authenticator. Each known key maps to a userId. */
export class BearerKeyAuth implements AuthPlugin {
  private readonly keys: Map<string, string>;

  constructor(config: { keys: Record<string, string> } | { keys: string[] }) {
    this.keys = new Map();
    if (Array.isArray(config.keys)) {
      // Anonymous keys — userId equals the key suffix.
      for (const k of config.keys) this.keys.set(k, `key:${k.slice(0, 8)}`);
    } else {
      for (const [key, userId] of Object.entries(config.keys)) {
        this.keys.set(key, userId);
      }
    }
  }

  verify(headers: Record<string, string>): AuthVerifyResult {
    const auth = headers.authorization ?? headers.Authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new Error('missing or malformed Authorization header (expected "Bearer <key>")');
    }
    const key = auth.slice(7).trim();
    const userId = this.keys.get(key);
    if (!userId) {
      throw new Error('unknown bearer key');
    }
    return { userId };
  }
}
