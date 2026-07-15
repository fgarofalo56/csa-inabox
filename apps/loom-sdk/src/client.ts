/**
 * LoomClient — the typed entrypoint to the Loom REST API.
 *
 *   import { LoomClient } from '@csa-loom/sdk';
 *
 *   const loom = new LoomClient({
 *     baseUrl: 'https://csa-loom.limitlessdata.ai',
 *     token: process.env.LOOM_TOKEN,   // loom_pat_<id>_<secret>
 *   });
 *
 *   const ws = await loom.workspaces.create({ name: 'Analytics' });
 *   const lake = await loom.items.create(ws.id, { itemType: 'lakehouse', displayName: 'Bronze' });
 *
 * Auth is either a scoped API token (`token`) or a session cookie (`cookie`).
 * For CI without a stored token, `loginServicePrincipal()` mints a session
 * cookie from a service principal and wires it into subsequent calls.
 */

import { HttpTransport, type LoomClientOptions } from './http.js';
import { WorkspacesResource } from './resources/workspaces.js';
import { ItemsResource } from './resources/items.js';
import { CatalogResource } from './resources/catalog.js';
import { ThreadResource } from './resources/thread.js';
import { TokensResource } from './resources/tokens.js';
import type { WhoAmI, SessionResult } from './types.js';

export class LoomClient {
  private readonly http: HttpTransport;

  readonly workspaces: WorkspacesResource;
  readonly items: ItemsResource;
  readonly catalog: CatalogResource;
  readonly thread: ThreadResource;
  readonly tokens: TokensResource;

  constructor(options: LoomClientOptions) {
    this.http = new HttpTransport(options);
    this.workspaces = new WorkspacesResource(this.http);
    this.items = new ItemsResource(this.http);
    this.catalog = new CatalogResource(this.http);
    this.thread = new ThreadResource(this.http);
    this.tokens = new TokensResource(this.http);
  }

  /** The resolved base URL (trailing slash stripped). */
  get baseUrl(): string {
    return this.http.base;
  }

  /**
   * Echo the caller identity + token scope. The canonical "is my token working
   * / what can it do" probe (`GET /api/v1/whoami`).
   */
  async whoami(): Promise<WhoAmI> {
    return this.http.request<WhoAmI>('GET', '/api/v1/whoami');
  }

  /**
   * Non-interactive service-principal login (CI). Mints a `loom_session`
   * cookie from `POST /api/auth/cli-session` and wires it into this client for
   * subsequent calls. Returns the session (cookie + expiry) so callers can
   * persist it if they wish.
   */
  async loginServicePrincipal(creds: { clientId: string; clientSecret: string; tenantId?: string }): Promise<SessionResult> {
    const out = await this.http.request<{ ok: boolean; cookie: string; expiresAt: number; claims?: SessionResult['claims'] }>(
      'POST',
      '/api/auth/cli-session',
      { flow: 'service-principal', ...creds },
    );
    this.http.setCookie(out.cookie);
    return { cookie: out.cookie, expiresAt: out.expiresAt, claims: out.claims };
  }
}
