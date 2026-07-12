/**
 * user-pool-registry (EH-P1-OBO, #1800) — the ONE seam that maps a data-plane
 * resource KIND to its per-user delegated-token store, so every BFF route that
 * honors the `accessMode === 'user'` data-access mode resolves the right
 * per-(resource, oid) token the same way.
 *
 * WHY: the per-user stores are deliberately audience-scoped siblings —
 *   sql     → sql-user-token-store      (login-captured, Azure SQL audience)
 *   storage → storage-user-token-store  (Azure Storage audience, this PR)
 *   kusto   → kusto-user-token-store    (per-cluster ADX audience, this PR)
 *   arm     → user-token-store          (login-captured, ARM audience)
 *   powerbi → pbi-user-token-store      (opt-in, Power BI audience)
 * — and before this registry each caller hand-picked its store. The registry
 * centralizes: (1) which store serves which backend, (2) the MSAL
 * silent-acquire REFRESH when the cache misses/expires (the same
 * resolve-account-then-acquireTokenSilent pattern lib/auth/obo.ts uses — MSAL
 * transparently exchanges the user's Cosmos-persisted ~24h refresh token, so a
 * cold replica or an expired cached token self-heals without a new login), and
 * (3) the HONEST GATE copy when no delegated token can be minted (mirroring
 * lib/auth/obo.ts `oboRemediation` — never a silent downgrade to the UAMI).
 *
 * MODE POLICY (data-access-mode): the DEFAULT for every item is
 * `accessMode === 'service'` — this registry is only consulted when an item
 * was explicitly switched to "user's identity" mode, so the always-works
 * service-UAMI path is byte-for-byte unchanged.
 *
 * SECURITY: tokens resolved here are NEVER returned to the browser and NEVER
 * logged; routes hand them straight to the outbound data-plane call.
 */
import type { SqlAccessMode } from './sql-access-mode';

/** Data-plane resource kinds with a per-user delegated-token pool. */
export type UserDataPlaneKind = 'sql' | 'storage' | 'kusto' | 'arm' | 'powerbi';

/** Context for a per-user token resolution. `clusterUri` is kusto-only. */
export interface UserTokenContext {
  oid: string;
  /** Kusto only — the ADX cluster whose per-cluster audience is needed. */
  clusterUri?: string;
}

/** Structured gate codes, one per pool (SQL reuses the shipped F10 code). */
export const USER_TOKEN_GATE_CODE: Record<UserDataPlaneKind, string> = {
  sql: 'NO_USER_SQL_TOKEN',
  storage: 'NO_USER_STORAGE_TOKEN',
  kusto: 'NO_USER_KUSTO_TOKEN',
  arm: 'NO_USER_ARM_TOKEN',
  powerbi: 'NO_USER_PBI_TOKEN',
};

/**
 * Honest, actionable gate copy per pool — names the exact missing delegated
 * consent (oboRemediation style). Shown verbatim in the route's 403 body /
 * MessageBar; never a silent fallback to the service identity.
 */
export function userTokenRemediation(kind: UserDataPlaneKind): string {
  switch (kind) {
    case 'sql':
      return (
        "User's identity mode is on, but no valid SQL token is available for you. Sign out and " +
        'sign back in, then retry. If it still fails, your admin must grant admin consent for the ' +
        'Azure SQL delegated permission (user_impersonation) on the Loom app registration ' +
        '(scripts/csa-loom/grant-sql-delegated-permission.sh).'
      );
    case 'storage':
      return (
        "User's identity mode is on, but no valid Azure Storage token is available for you. Sign " +
        'out and sign back in, then retry. If it still fails, your admin must add the Azure ' +
        'Storage delegated permission (user_impersonation on https://storage.azure.com) to the ' +
        'Loom app registration and grant admin consent — and your account needs Storage Blob ' +
        'Data Reader (or an ACL) on the lake.'
      );
    case 'kusto':
      return (
        "User's identity mode is on, but no valid Azure Data Explorer token is available for you. " +
        'Sign out and sign back in, then retry. If it still fails, your admin must add the Azure ' +
        'Data Explorer delegated permission (user_impersonation on the Kusto resource) to the ' +
        'Loom app registration and grant admin consent — and your account needs a database ' +
        'principal (Viewer or higher) on the target ADX database.'
      );
    case 'arm':
      return (
        "User's identity mode is on, but no valid Azure Resource Manager token is available for " +
        'you. Sign out and sign back in, then retry. If it still fails, your admin must grant ' +
        'admin consent for the Azure Service Management delegated permission (user_impersonation) ' +
        'on the Loom app registration.'
      );
    case 'powerbi':
    default:
      return (
        "User's identity mode is on, but no valid Power BI token is available for you. Sign out " +
        'and sign back in, then retry. If it still fails, your admin must add the delegated Power ' +
        'BI permissions to the Loom app registration and grant admin consent — see ' +
        'docs/fiab/v3-tenant-bootstrap.md (Power BI delegated permissions).'
      );
  }
}

/** Structured 403 gate body for a missing per-user token (bff-error shape). */
export function userTokenGateBody(kind: UserDataPlaneKind): {
  ok: false;
  code: string;
  error: string;
} {
  return { ok: false, code: USER_TOKEN_GATE_CODE[kind], error: userTokenRemediation(kind) };
}

/** The delegated scope the silent refresh mints for each pool. */
async function scopeFor(kind: UserDataPlaneKind, ctx: UserTokenContext): Promise<string | null> {
  switch (kind) {
    case 'sql': {
      const { getSqlSuffix } = await import('./cloud-endpoints');
      const sqlHost = process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || getSqlSuffix();
      return `https://${sqlHost}/user_impersonation`;
    }
    case 'storage': {
      const { storageOboScope } = await import('./storage-user-token-store');
      return storageOboScope();
    }
    case 'kusto': {
      if (!ctx.clusterUri) return null;
      const { kustoOboScope } = await import('./kusto-user-token-store');
      return kustoOboScope(ctx.clusterUri);
    }
    case 'arm': {
      const { armBase } = await import('./cloud-endpoints');
      return `${armBase()}/user_impersonation`;
    }
    case 'powerbi': {
      const { getPbiScope } = await import('./cloud-endpoints');
      return getPbiScope();
    }
    default:
      return null;
  }
}

/** Read the pool's Cosmos-cached token (per-store delegation). */
async function readCached(kind: UserDataPlaneKind, ctx: UserTokenContext): Promise<string | null> {
  switch (kind) {
    case 'sql':
      return (await import('./sql-user-token-store')).getUserSqlToken(ctx.oid);
    case 'storage':
      return (await import('./storage-user-token-store')).getUserStorageToken(ctx.oid);
    case 'kusto':
      return ctx.clusterUri
        ? (await import('./kusto-user-token-store')).getUserKustoToken(ctx.oid, ctx.clusterUri)
        : null;
    case 'arm':
      return (await import('./user-token-store')).getUserArmToken(ctx.oid);
    case 'powerbi':
      return (await import('./pbi-user-token-store')).getPbiUserToken(ctx.oid);
    default:
      return null;
  }
}

/** Persist a freshly minted token back into the pool's store (best-effort). */
async function writeBack(
  kind: UserDataPlaneKind,
  ctx: UserTokenContext,
  token: string,
  expiresOn: Date | null,
): Promise<void> {
  try {
    switch (kind) {
      case 'sql':
        await (await import('./sql-user-token-store')).saveUserSqlToken(ctx.oid, token, expiresOn);
        break;
      case 'storage':
        await (
          await import('./storage-user-token-store')
        ).saveUserStorageToken(ctx.oid, token, expiresOn);
        break;
      case 'kusto':
        if (ctx.clusterUri) {
          await (
            await import('./kusto-user-token-store')
          ).saveUserKustoToken(ctx.oid, ctx.clusterUri, token, expiresOn);
        }
        break;
      case 'arm':
        await (await import('./user-token-store')).saveUserToken(ctx.oid, token, expiresOn);
        break;
      case 'powerbi':
        await (await import('./pbi-user-token-store')).savePbiUserToken(ctx.oid, token, expiresOn);
        break;
    }
  } catch {
    // Best-effort — the freshly minted token is still returned to the caller.
  }
}

/**
 * MSAL silent-acquire refresh — the SAME resolve-account-then-acquireTokenSilent
 * pattern lib/auth/obo.ts uses (the loom_session cookie carries claims only, so
 * there is no raw assertion for a literal jwt-bearer OBO exchange; MSAL's
 * Cosmos-persisted cache silently exchanges the user's ~24h refresh token
 * instead — the same delegated token an OBO exchange would yield). Returns null
 * on ANY failure (no account, consent missing, transient) — never throws.
 */
async function silentAcquire(
  oid: string,
  scope: string,
): Promise<{ token: string; expiresOn: Date | null } | null> {
  try {
    const { getMsalClient } = await import('@/lib/auth/msal');
    const client = getMsalClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    const account =
      accounts.find((a) => (a.homeAccountId || '').split('.')[0] === oid) ??
      accounts.find((a) => a.localAccountId === oid);
    if (!account) return null;
    const res = await client.acquireTokenSilent({ account, scopes: [scope] });
    if (!res?.accessToken) return null;
    return { token: res.accessToken, expiresOn: res.expiresOn ?? null };
  } catch {
    return null;
  }
}

/**
 * Resolve the signed-in user's delegated data-plane token for `kind`:
 * Cosmos-cached token first (safety-margin enforced by the store), then an
 * MSAL silent-acquire refresh (persisted back best-effort). Returns null when
 * no delegated token can be minted — the caller surfaces the honest gate
 * (userTokenGateBody), never a silent downgrade to the service identity.
 */
export async function getUserDataPlaneToken(
  kind: UserDataPlaneKind,
  ctx: UserTokenContext,
): Promise<string | null> {
  if (!ctx?.oid) return null;
  const cached = await readCached(kind, ctx);
  if (cached) return cached;

  const scope = await scopeFor(kind, ctx);
  if (!scope) return null;
  const minted = await silentAcquire(ctx.oid, scope);
  if (!minted) return null;
  await writeBack(kind, ctx, minted.token, minted.expiresOn);
  return minted.token;
}

/** Outcome of a data-access-mode read resolution (see resolveUserRead). */
export type UserReadResolution =
  | { mode: 'service' }
  | { mode: 'user'; token: string }
  | { mode: 'gate'; status: 403; body: { ok: false; code: string; error: string } };

/**
 * THE route-facing branch decision for the `accessMode` data-access mode:
 *   - 'service' (the DEFAULT) → run as the Loom service identity, unchanged.
 *   - 'user' + token resolvable → run the read with the user's delegated token.
 *   - 'user' + NO token → honest 403 gate naming the missing delegated consent
 *     (NEVER a silent downgrade to the service identity — downgrading would
 *     defeat the mode and leak the UAMI's broader rights).
 */
export async function resolveUserRead(
  accessMode: SqlAccessMode,
  kind: UserDataPlaneKind,
  ctx: UserTokenContext,
): Promise<UserReadResolution> {
  if (accessMode !== 'user') return { mode: 'service' };
  const token = await getUserDataPlaneToken(kind, ctx);
  if (!token) return { mode: 'gate', status: 403, body: userTokenGateBody(kind) };
  return { mode: 'user', token };
}
