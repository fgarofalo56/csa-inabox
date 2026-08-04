/**
 * M5 `loom-admin` — the ADMIN (escalation) MCP server. Composes the shared core
 * factory with the three admin tools and the STRICTEST authorization policy:
 *
 *   { allowMutations:true, requireAdmin:true, rejectPat:true, enabled:<env> }
 *
 * - **default-OFF** (§5.4.1): `LOOM_MCP_ADMIN_ENABLED` must be `1`/`true` or every
 *   call is refused (`admin_disabled`). The server still lists its tools
 *   (discovery) so a client can see what it WOULD expose.
 * - **no PAT** (§5.1): a PAT credential is refused unconditionally.
 * - **admin scope** (§5.4a): the caller's scope must be `admin` (server-wide
 *   `requireAdmin`) AND meet each tool's `minScope:'admin'`.
 * - **dry-run-default** + **mandatory audit with target** live in the tools.
 *
 * Admin-scope resolution: a PAT would carry its own `LOOM_TOKEN_SCOPE`, but PATs
 * are rejected, so admin power comes from an interactive Entra session (cookie).
 * A cookie resolves to `read-write` by default (→ denied); to run admin tools the
 * operator must EXPLICITLY assert `LOOM_TOKEN_SCOPE=admin`. That is the LOCAL,
 * deny-by-default floor — the AUTHORITATIVE live tenant-admin re-check + PDP are
 * performed by the BFF route each tool calls (§5.4.2), not re-implemented here.
 */
import { createLoomMcpServer } from '../../core/server.js';
import { resolveAuth, type ResolveAuthOptions } from '../../core/auth.js';
import { adminTools } from './tools.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditSink, AuthContext, AuthzPolicy, TokenScope } from '../../core/index.js';

export const ADMIN_SERVER_NAME = 'loom-admin';
export const ADMIN_SERVER_VERSION = '0.1.0';

/** Is the admin server explicitly enabled? Default-OFF (§5.4.1). */
export function adminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LOOM_MCP_ADMIN_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function coerceScope(v: string | undefined): TokenScope | undefined {
  return v === 'read-only' || v === 'read-write' || v === 'admin' ? v : undefined;
}

/**
 * Resolve the admin caller. Uses the shared resolver, then — for a cookie
 * session only — honors an EXPLICIT `LOOM_TOKEN_SCOPE=admin` assertion (a cookie
 * otherwise resolves to `read-write`, which the gate denies). A PAT is returned
 * as-is and refused by `rejectPat`. `null` (anonymous) stays `null`.
 */
export async function resolveAdminAuth(opts: ResolveAuthOptions = {}): Promise<AuthContext | null> {
  const env = opts.env ?? process.env;
  const auth = await resolveAuth(opts);
  if (auth && auth.mode === 'cookie') {
    const explicit = coerceScope(env.LOOM_TOKEN_SCOPE);
    if (explicit) return { ...auth, scope: explicit };
  }
  return auth;
}

/** M5 authorization policy — the strict admin floor. */
export function adminAuthz(enabled: boolean): AuthzPolicy {
  return { allowMutations: true, requireAdmin: true, rejectPat: true, enabled, server: ADMIN_SERVER_NAME };
}

export interface CreateAdminServerOptions {
  /** Pre-resolved auth (tests). When omitted, {@link resolveAdminAuth} runs. */
  auth?: AuthContext | null;
  /** Audit sink override (tests). */
  audit?: AuditSink;
  /** Force the enabled flag (tests). Defaults to {@link adminEnabled}. */
  enabled?: boolean;
}

/** Build (but do not connect) the loom-admin MCP server. */
export async function createAdminServer(opts: CreateAdminServerOptions = {}): Promise<McpServer> {
  const auth = opts.auth !== undefined ? opts.auth : await resolveAdminAuth();
  const enabled = opts.enabled !== undefined ? opts.enabled : adminEnabled();
  return createLoomMcpServer({
    name: ADMIN_SERVER_NAME,
    version: ADMIN_SERVER_VERSION,
    tools: adminTools(),
    auth,
    audit: opts.audit,
    authz: adminAuthz(enabled),
  });
}
