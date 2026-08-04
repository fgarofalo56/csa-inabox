/**
 * LoomApi — the extension's transport, a thin wrapper over `@csa-loom/sdk`.
 *
 * Reuse-not-reimplement (PRP §2.2, task directive): the bulk of the surface is
 * the SDK's own typed client —
 *   • `client.workspaces.list()`   → GET  /api/workspaces
 *   • `client.items.list()`        → GET  /api/workspaces/:id/items
 *   • `client.items.update()`      → PATCH /api/cosmos-items/:type/:id   (rename)
 *   • `client.items.delete()`      → DELETE /api/cosmos-items/:type/:id
 *   • `client.whoami()`            → GET  /api/v1/whoami   (identity + PAT scope)
 * The SDK's `HttpTransport` (bearer-PAT OR cookie auth, envelope normalization,
 * `LoomApiError`) does the work. Two routes the SDK class does not model are
 * called with a small `raw()` helper that REUSES the SDK's `LoomApiError`,
 * `COOKIE_NAME` and `normalizeBaseUrl` so the error/auth contract is identical:
 *   • POST /api/cosmos-items/:type   (create — the route the Console NewItemGate
 *     uses; PRP W3)
 *   • GET  /api/auth/me              (flat identity for the status bar; PRP A5)
 *
 * Auth is per-deployment: a device-code `loom_session` cookie OR a scoped PAT.
 * Both are supported natively by the SDK's transport.
 */

import {
  LoomClient,
  LoomApiError,
  isLoomApiError,
  normalizeBaseUrl,
  COOKIE_NAME,
  type Workspace,
  type Item,
  type WhoAmI,
} from '@csa-loom/sdk';

export { LoomApiError, isLoomApiError };
export type { Workspace, Item, WhoAmI };

/** A per-deployment credential held in SecretStorage. */
export type Credential =
  | { kind: 'cookie'; value: string }
  | { kind: 'pat'; value: string };

/** Flat identity shape returned by `GET /api/auth/me`. */
export interface MeResult {
  ok: boolean;
  oid?: string;
  upn?: string;
  email?: string;
  name?: string;
}

export class LoomApi {
  readonly baseUrl: string;
  private readonly client: LoomClient;
  private readonly cred: Credential;

  constructor(baseUrl: string, cred: Credential) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.cred = cred;
    this.client = new LoomClient(
      cred.kind === 'pat' ? { baseUrl, token: cred.value } : { baseUrl, cookie: cred.value },
    );
  }

  // --- SDK-covered operations ---------------------------------------------

  /** List workspaces (with item counts). */
  listWorkspaces(): Promise<Workspace[]> {
    return this.client.workspaces.list({ count: true });
  }

  /** List items in a workspace. */
  listItems(workspaceId: string): Promise<Item[]> {
    return this.client.items.list(workspaceId);
  }

  /** Rename an item (PATCH displayName). */
  renameItem(type: string, id: string, displayName: string): Promise<Item> {
    return this.client.items.update(type, id, { displayName });
  }

  /** Delete an item. */
  deleteItem(type: string, id: string): Promise<void> {
    return this.client.items.delete(type, id);
  }

  /** Identity + PAT scope probe (`/api/v1/whoami`) — accepts cookie or PAT. */
  whoami(): Promise<WhoAmI> {
    return this.client.whoami();
  }

  // --- Routes the SDK class does not model (reuse the SDK error contract) ---

  /** Flat identity for the status bar (`GET /api/auth/me`). */
  me(): Promise<MeResult> {
    return this.raw<MeResult>('GET', '/api/auth/me');
  }

  /**
   * Create an item (PRP W3). Hits `POST /api/cosmos-items/:type` — the same
   * route the Console's shared NewItemGate uses — with `{ workspaceId,
   * displayName, description? }`. Returns the created item.
   */
  async createItem(
    type: string,
    workspaceId: string,
    displayName: string,
    description?: string,
  ): Promise<Item> {
    const body: Record<string, unknown> = { workspaceId, displayName };
    if (description && description.trim()) body.description = description.trim();
    const out = await this.raw<{ ok: boolean; item: Item }>(
      'POST',
      `/api/cosmos-items/${encodeURIComponent(type)}`,
      body,
    );
    return out.item;
  }

  private authHeaders(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (this.cred.kind === 'pat') h.Authorization = `Bearer ${this.cred.value}`;
    else h.Cookie = `${COOKIE_NAME}=${this.cred.value}`;
    return h;
  }

  /** Minimal request that mirrors the SDK's error/auth contract exactly. */
  private async raw<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${apiPath}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.authHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LoomApiError(`Network error calling ${method} ${apiPath}: ${msg}`, 0, 'network_error');
    }
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw this.errorFrom(parsed, res);
    if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
      throw this.errorFrom(parsed, res);
    }
    return parsed as T;
  }

  private errorFrom(parsed: unknown, res: Response): LoomApiError {
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { error?: unknown; message?: unknown; code?: unknown; hint?: unknown };
      const msg =
        (typeof p.error === 'string' && p.error) ||
        (typeof p.message === 'string' && p.message) ||
        `${res.status} ${res.statusText}`;
      return new LoomApiError(
        String(msg),
        res.status,
        typeof p.code === 'string' ? p.code : undefined,
        typeof p.hint === 'string' ? p.hint : undefined,
      );
    }
    const msg = typeof parsed === 'string' && parsed ? parsed : `${res.status} ${res.statusText}`;
    return new LoomApiError(msg, res.status);
  }
}
