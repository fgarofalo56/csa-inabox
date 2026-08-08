/**
 * Shared resolver: a stored Loom Connection id → the explicit data-plane
 * credential its backend driver needs.
 *
 * WHY THIS MODULE EXISTS (the bug it fixes)
 * -----------------------------------------
 * The mirroring wizard collects a Loom Connection (whose secret lives in Key
 * Vault) and `/api/items/mirrored-database/[id]/sources` persists the
 * `connectionId` on the item. Until now exactly ONE surface consumed it — the
 * schema-browse route `/[id]/tables` — which carried its own private copy of
 * this resolution logic. The replication path (`/[id]/lifecycle` → the mirror
 * engine) never read `connectionId` at all: `MirrorSource` had no field for it
 * and `mirror-engine.ts` contained zero references to it. So Start/Restart
 * always authenticated as the **Console UAMI**, silently ignoring the
 * credential the operator supplied. Browsing tables worked with the stored
 * login; actually mirroring them did not.
 *
 * Keeping the resolution in one exported function (rather than a second private
 * copy) is deliberate: a fix that lives in a helper only its original caller
 * adopts is the recurring "guard-adoption gap" failure in this repo. Every
 * consumer of a stored connection credential imports from here.
 *
 * SECRET HANDLING (.claude/rules — never persist, never log, never echo)
 * ---------------------------------------------------------------------
 * The Cosmos connection document stores only a Key Vault `secretRef` (a secret
 * NAME, never a value). This module fetches the value from Key Vault at call
 * time, hands it straight to the driver, and never writes it anywhere: not to
 * Cosmos, not to item state, not to a log line, and not into any API response.
 * `describeConnectionAuth()` exists so callers can report WHICH identity a run
 * used without ever touching the secret itself.
 */
import { loadConnection } from './connections-store';
import { getKeyVaultSecretValue } from './kv-secrets-client';
import type { SqlExplicitAuth } from './azure-sql-client';
import type { PgExplicitAuth } from './postgres-flex-client';

/**
 * How a mirror run authenticated, for receipts and the Monitor tab. Carries no
 * secret material — only the connection's non-secret identity metadata.
 */
export interface ConnectionAuthDescriptor {
  /** 'connection' = the operator's stored Loom Connection; 'uami' = the Console managed identity. */
  identity: 'connection' | 'uami';
  /** The connection's display name, when one was used. */
  connectionName?: string;
  /** The connection's auth method ('sql-password' | 'connection-string' | 'entra-mi' | …). Never the secret. */
  authMethod?: string;
  /**
   * Set when a connection was bound but could NOT supply an explicit driver
   * credential, so the run fell back to the Console UAMI. Per deploy-integrity
   * R7 the reason is stated rather than silently swallowed.
   */
  fallbackReason?: string;
}

/** The Console UAMI descriptor — the default when no connection is bound. */
export const UAMI_AUTH: ConnectionAuthDescriptor = { identity: 'uami' };

/**
 * Resolve the SQL (TDS) auth for a stored connection.
 *
 * Returns `undefined` when the caller should authenticate as the Console UAMI:
 * no connectionId, the connection was deleted, it is Entra-MI (no secret by
 * design), or its auth method is not a TDS login (service-principal /
 * account-key are storage/ARM credentials, not SQL logins).
 */
export async function resolveSqlAuth(
  tenantId: string,
  connectionId?: string,
): Promise<SqlExplicitAuth | undefined> {
  const { auth } = await resolveSqlAuthDescribed(tenantId, connectionId);
  return auth;
}

/**
 * `resolveSqlAuth` + a non-secret descriptor of what was used, so a run receipt
 * can state which identity read the source without exposing any credential.
 */
export async function resolveSqlAuthDescribed(
  tenantId: string,
  connectionId?: string,
): Promise<{ auth?: SqlExplicitAuth; descriptor: ConnectionAuthDescriptor }> {
  if (!connectionId) return { descriptor: UAMI_AUTH };
  const conn = await loadConnection(tenantId, connectionId);
  if (!conn) {
    return {
      descriptor: {
        identity: 'uami',
        fallbackReason: 'The connection bound to this mirror no longer exists; the run used the Console managed identity.',
      },
    };
  }
  const base = { connectionName: conn.name, authMethod: conn.authMethod };
  if (conn.authMethod === 'entra-mi') {
    // Entra-MI connections are UAMI by design — not a fallback, the intended path.
    return { descriptor: { identity: 'uami', ...base } };
  }
  if (!conn.secretRef) {
    return {
      descriptor: {
        identity: 'uami', ...base,
        fallbackReason: `Connection "${conn.name}" has no Key Vault secret stored; the run used the Console managed identity.`,
      },
    };
  }
  if (conn.authMethod === 'connection-string') {
    const connectionString = await getKeyVaultSecretValue(conn.secretRef, 'connection-secret');
    return { auth: { connectionString }, descriptor: { identity: 'connection', ...base } };
  }
  if (conn.authMethod === 'sql-password') {
    if (!conn.username) {
      return {
        descriptor: {
          identity: 'uami', ...base,
          fallbackReason: `Connection "${conn.name}" is a SQL-password connection with no username recorded, so no SQL login could be built; the run used the Console managed identity.`,
        },
      };
    }
    const password = await getKeyVaultSecretValue(conn.secretRef, 'connection-secret');
    return { auth: { user: conn.username, password }, descriptor: { identity: 'connection', ...base } };
  }
  // service-principal / account-key are not TDS logins.
  return {
    descriptor: {
      identity: 'uami', ...base,
      fallbackReason: `Connection "${conn.name}" uses ${conn.authMethod}, which is not a SQL login; the run used the Console managed identity.`,
    },
  };
}

/**
 * Attach a mirror's stored source credential to a MirrorSource.
 *
 * Lives HERE, not in a route, because `mirrored-database` has TWO Start paths
 * (`/[id]/lifecycle` and `/[id]/state`) that both build a MirrorSource from the
 * same item state. A per-route copy is how the original bug survived in the
 * first place, and how the fix would have half-landed: one route credential-
 * aware, its sibling still silently running as the Console UAMI.
 *
 * `sourceType` selects the family, so a PostgreSQL mirror gets `pgAuth` and a
 * SQL-family mirror gets `auth` — never both, and never the wrong one.
 *
 * The resolved secret rides on the returned object for the duration of ONE
 * request. Persist the `descriptor`, never the source.
 */
export async function withSourceAuth<T extends { sourceType: string }>(
  tenantId: string,
  src: T,
  connectionId?: string,
): Promise<{ src: T & { auth?: SqlExplicitAuth; pgAuth?: PgExplicitAuth }; descriptor: ConnectionAuthDescriptor }> {
  if (!connectionId) return { src, descriptor: UAMI_AUTH };
  if (PG_SOURCE_TYPES.has(src.sourceType)) {
    const { auth, descriptor } = await resolvePgAuthDescribed(tenantId, connectionId);
    return { src: { ...src, pgAuth: auth }, descriptor };
  }
  const { auth, descriptor } = await resolveSqlAuthDescribed(tenantId, connectionId);
  return { src: { ...src, auth }, descriptor };
}

/**
 * PostgreSQL mirror source types. Duplicated as a literal rather than imported
 * from `mirror-engine` on purpose: importing the engine here would pull its
 * mssql / ADLS / Spark native chain into every route that only needs to resolve
 * a credential. Kept in sync with `MIRROR_PG_FAMILY`, and asserted by a test.
 */
export const PG_SOURCE_TYPES = new Set(['AzurePostgreSql']);

/**
 * Resolve the PostgreSQL auth for a stored connection. PostgreSQL flexible
 * server accepts either an Entra token (the UAMI default) or a plain
 * user/password login, so a `sql-password` connection maps directly.
 * `connection-string` is NOT translated here — a libpq URI would have to be
 * parsed to extract a user/password pair, and guessing at that is worse than
 * saying so, per deploy-integrity R7.
 */
export async function resolvePgAuthDescribed(
  tenantId: string,
  connectionId?: string,
): Promise<{ auth?: PgExplicitAuth; descriptor: ConnectionAuthDescriptor }> {
  if (!connectionId) return { descriptor: UAMI_AUTH };
  const conn = await loadConnection(tenantId, connectionId);
  if (!conn) {
    return {
      descriptor: {
        identity: 'uami',
        fallbackReason: 'The connection bound to this mirror no longer exists; the run used the Console managed identity.',
      },
    };
  }
  const base = { connectionName: conn.name, authMethod: conn.authMethod };
  if (conn.authMethod === 'entra-mi') return { descriptor: { identity: 'uami', ...base } };
  if (!conn.secretRef) {
    return {
      descriptor: {
        identity: 'uami', ...base,
        fallbackReason: `Connection "${conn.name}" has no Key Vault secret stored; the run used the Console managed identity.`,
      },
    };
  }
  if (conn.authMethod === 'sql-password' && conn.username) {
    const password = await getKeyVaultSecretValue(conn.secretRef, 'connection-secret');
    return { auth: { user: conn.username, password }, descriptor: { identity: 'connection', ...base } };
  }
  return {
    descriptor: {
      identity: 'uami', ...base,
      fallbackReason: `Connection "${conn.name}" uses ${conn.authMethod}, which this PostgreSQL path cannot use as a login; the run used the Console managed identity.`,
    },
  };
}
