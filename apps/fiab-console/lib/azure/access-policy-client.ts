/**
 * Access-policy enforcement — makes Governance → Policies "Access" rules REAL
 * instead of persist-only. A Loom-native, Azure-native data-access grant =
 * give a PRINCIPAL (Entra user/group/SP) a PERMISSION (read/write/admin) on a
 * data scope, enforced as a real data-plane grant:
 *
 *   - adls-container → Storage RBAC role assignment (Storage Blob Data *).
 *   - warehouse      → Synapse **Dedicated SQL** Entra DB user + role membership
 *                      (db_datareader / db_datawriter / db_owner) via
 *                      `sp_addrolemember` — Dedicated SQL pools do NOT support
 *                      `ALTER ROLE ... ADD MEMBER` (see Microsoft Learn:
 *                      database-level-roles / sql-authentication).
 *   - kql-database   → Azure Data Explorer **database role** (.add database
 *                      viewers / users / admins).
 *
 *   - item / workspace → Loom-native WORKSPACE ROLE assignment (Cosmos
 *                      `workspace-roles`, honored by resolveWorkspaceRole on
 *                      every BFF call; mirrored to Azure RBAC where wired) —
 *                      the real grant for logical assets like data products,
 *                      reports and APIs (#51).
 *
 * No Microsoft Fabric / Purview-policy dependency (no-fabric-dependency.md):
 * everything above is Azure-native or Loom-native. The one scope Loom still
 * can't bind (collection) returns status 'pending' with a precise reason —
 * never a silent no-op (no-vaporware.md).
 */
import { grantContainerRole, revokeContainerRoleAssignment } from './adls-client';
import { dedicatedTarget, executeQuery as synapseExecute } from './synapse-sql-client';
import { getPoolState, resumePool } from './synapse-pool-arm';
import {
  kustoConfigGate,
  addDatabasePrincipal,
  dropDatabasePrincipal,
  showDatabasePrincipals,
} from './kusto-client';
import { escapeSqlLiteral, bracket } from '@/lib/sql/quoting';
import { itemsContainer } from './cosmos-client';
import { addWorkspaceRole } from './workspace-roles-client';

export type AccessPermission = 'read' | 'write' | 'admin';
export type AccessScopeType = 'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database' | 'workspace' | 'item' | 'collection';
export type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';

/** Permission → Storage data-plane role for ADLS-container scopes. */
export const PERMISSION_ROLE: Record<AccessPermission, string> = {
  read: 'Storage Blob Data Reader',
  write: 'Storage Blob Data Contributor',
  admin: 'Storage Blob Data Owner',
};

/** Permission → Synapse Dedicated SQL fixed database role. */
const SQL_ROLE: Record<AccessPermission, string> = {
  read: 'db_datareader',
  write: 'db_datawriter',
  admin: 'db_owner',
};

/** Permission → ADX database role. */
const ADX_ROLE: Record<AccessPermission, string> = {
  read: 'viewers',
  write: 'users',
  admin: 'admins',
};

export interface AccessGrantInput {
  principalId: string;
  /** UPN / display name — required for warehouse (CREATE USER) + helps ADX. */
  principalName?: string;
  principalType: PrincipalType;
  scopeType: AccessScopeType;
  /** adls-container: container name · warehouse: pool/db (informational) · kql-database: ADX db. */
  scopeRef: string;
  permission: AccessPermission;
}

export interface AccessGrantResult {
  status: 'active' | 'pending' | 'error';
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
  /**
   * Whether the principal ALREADY held this role before the grant: `true` when
   * the grant found it in place, `false` when the grant created it, absent when
   * that could not be determined. A caller that later undoes the grant revokes
   * only what it created (lib/access/landed-grants.ts).
   */
  preexisting?: boolean;
}

/** The outcome of undoing a structured (warehouse / KQL) grant. */
export interface StructuredRevokeResult {
  status: 'revoked' | 'skipped' | 'error';
  detail?: string;
}

// ── SQL identifier/literal escaping (no string injection) ─────────────────────
function sqlBracket(ident: string): string { return bracket(ident); }
function sqlString(s: string): string { return `N'${escapeSqlLiteral(s)}'`; }

/** Build the ADX principal selector for `.add/.drop database role`. */
function adxPrincipalToken(input: AccessGrantInput): { token: string } | { gate: string } {
  const tenant = process.env.AZURE_TENANT_ID;
  const { principalType, principalName, principalId } = input;
  if (principalType === 'User') {
    // UPN form needs no tenant; object-id form does.
    if (principalName && principalName.includes('@')) return { token: `aaduser=${principalName}` };
    if (tenant) return { token: `aaduser=${principalId};${tenant}` };
    return { gate: 'Set AZURE_TENANT_ID (or supply the user UPN) to grant ADX access by object id.' };
  }
  if (principalType === 'Group') {
    if (tenant) return { token: `aadgroup=${principalId};${tenant}` };
    if (principalName) return { token: `aadgroup=${principalName}` };
    return { gate: 'Set AZURE_TENANT_ID to grant ADX access to a group by object id.' };
  }
  // ServicePrincipal
  if (tenant) return { token: `aadapp=${principalId};${tenant}` };
  return { gate: 'Set AZURE_TENANT_ID to grant ADX access to a service principal.' };
}

/** Enforce an access grant. Real data-plane grant per scope; honest gate otherwise. */
export async function enforceAccessGrant(input: AccessGrantInput): Promise<AccessGrantResult> {
  switch (input.scopeType) {
    case 'adls-container': {
      const roleName = PERMISSION_ROLE[input.permission];
      try {
        const grant = await grantContainerRole(input.scopeRef, input.principalId, roleName, input.principalType);
        return { status: 'active', roleName: grant.roleName || roleName, roleAssignmentId: grant.id, preexisting: false };
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 400);
        if (/\b409\b|already exists|RoleAssignmentExists/i.test(msg)) {
          return { status: 'active', roleName, detail: 'Role already assigned at this scope (idempotent).', preexisting: true };
        }
        return { status: 'error', detail: msg };
      }
    }

    case 'warehouse': {
      const roleName = SQL_ROLE[input.permission];
      const name = (input.principalName || '').trim();
      if (!name) {
        return { status: 'error', detail: 'A principal UPN / name is required to grant warehouse (Synapse SQL) access.' };
      }
      // The grant scope must name the warehouse. An empty scopeRef is refused
      // here rather than read as "the deployment's dedicated pool", so an
      // unresolved target can never widen to a store nobody named.
      if (!(input.scopeRef || '').trim()) {
        return { status: 'error', detail: 'A warehouse (dedicated SQL pool) is required for the grant scope; nothing was granted.' };
      }
      let target;
      try { target = dedicatedTarget(); }
      catch {
        return { status: 'pending', detail: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to enforce warehouse grants.' };
      }
      // The grant runs on this deployment's dedicated pool, so the scope must
      // name that pool (as a warehouse item's recorded scope does). Any other
      // name is refused rather than granted on the pool regardless.
      // Azure SQL pool names are case-insensitive.
      const named = input.scopeRef.trim();
      if (named.toLowerCase() !== String(target.database || '').trim().toLowerCase()) {
        return {
          status: 'error',
          detail: `The grant scope names warehouse '${named}', which is not this deployment's dedicated SQL pool (${target.database}); nothing was granted.`,
        };
      }
      // The Dedicated SQL pool may be provisioned start-paused (cost control).
      // A grant needs an Online pool to connect over TDS; if it's paused, kick
      // off a resume and return 'pending' so the operator re-runs once it's
      // Online — never a silent no-op (no-vaporware.md). If the ARM state probe
      // is unavailable (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG unset), fall through
      // and let the TDS connect surface any real error.
      try {
        const { state } = await getPoolState();
        if (state === 'Paused') {
          await resumePool().catch(() => { /* best-effort; operator retries below */ });
          return { status: 'pending', detail: `Dedicated SQL pool ${target.database} is paused — a resume was started. Re-run this grant once the pool is Online (~1-2 min).` };
        }
        if (state === 'Pausing' || state === 'Resuming' || state === 'Scaling') {
          return { status: 'pending', detail: `Dedicated SQL pool ${target.database} is ${state.toLowerCase()} — re-run this grant once it is Online.` };
        }
      } catch {
        /* ARM probe unavailable — proceed and let the TDS attempt report errors */
      }
      // Did the principal already hold the role? `sp_addrolemember` succeeds
      // either way, so the answer has to be read before the grant. The read and
      // the grant are two calls; the decision route holds a per-request lease
      // across them (decision/route.ts, grantLeaseUntil).
      const held = await warehouseRoleHeld(target, roleName, name);
      if (held === true) {
        return { status: 'active', roleName, detail: `Already a member of ${roleName} on ${target.database} (idempotent).`, preexisting: true };
      }
      try {
        // Create the Entra DB user if absent, then add it to the fixed role.
        // Synapse **Dedicated** SQL pools do NOT support `ALTER ROLE ... ADD
        // MEMBER`; database-role membership is managed with `sp_addrolemember`
        // (Microsoft Learn: sql-authentication#non-administrator-users and
        // database-level-roles — "Azure Synapse should use sp_addrolemember").
        const sql =
          `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${sqlString(name)})\n` +
          `  CREATE USER ${sqlBracket(name)} FROM EXTERNAL PROVIDER;\n` +
          `EXEC sp_addrolemember ${sqlString(roleName)}, ${sqlString(name)};`;
        await synapseExecute(target, sql);
        return { status: 'active', roleName, detail: `Granted ${roleName} on ${target.database} to ${name}.`, ...(held === false ? { preexisting: false } : {}) };
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 400);
        if (/already a member|already exists/i.test(msg)) {
          return { status: 'active', roleName, detail: 'Already a member of the role (idempotent).', preexisting: true };
        }
        return { status: 'error', detail: msg };
      }
    }

    case 'kql-database': {
      const gate = kustoConfigGate();
      if (gate) return { status: 'pending', detail: `ADX not configured: set ${gate.missing} to enforce KQL-database grants.` };
      const roleName = ADX_ROLE[input.permission];
      // The grant scope must name the database. An empty scopeRef is refused
      // rather than read as the deployment's default database.
      const db = (input.scopeRef || '').trim();
      if (!db) return { status: 'error', detail: 'A KQL database name is required for the grant scope; nothing was granted.' };
      const principal = adxPrincipalToken(input);
      if ('gate' in principal) return { status: 'pending', detail: principal.gate };
      // `.add database ... <role>` succeeds whether or not the principal already
      // holds the role, so the answer is read from the database's principals first.
      // Read and grant are two calls; see the warehouse arm for the lease note.
      const held = await adxRoleHeld(db, roleName, input);
      if (held === true) {
        return { status: 'active', roleName, detail: `Already ${roleName} on ADX database ${db} (idempotent).`, preexisting: true };
      }
      try {
        // `.add database ["db"] <role> ('<fqn>')` via the typed helper, which
        // allow-lists the role (KUSTO_DATABASE_ROLES) and centralizes escaping.
        await addDatabasePrincipal(db, roleName, principal.token);
        return { status: 'active', roleName, detail: `Granted ${roleName} on ADX database ${db}.`, ...(held === false ? { preexisting: false } : {}) };
      } catch (e: any) {
        return { status: 'error', detail: (e?.message || String(e)).slice(0, 400) };
      }
    }

    case 'item':
    case 'workspace': {
      // LOGICAL assets (#51, live-found 2026-07-16): data products, reports,
      // semantic models, APIs and other items with no dedicated physical store
      // are enforced by Loom's own authorization model — a workspace-role
      // assignment (Cosmos `workspace-roles`, honored by resolveWorkspaceRole
      // on every BFF call, mirrored to Azure RBAC where configured). read →
      // Viewer; write/admin → Contributor (workspace Admin is never granted
      // by an access request).
      const role = input.permission === 'read' ? 'Viewer' as const : 'Contributor' as const;
      try {
        let workspaceId = (input.scopeType === 'workspace' ? input.scopeRef : '').trim();
        if (!workspaceId) {
          const itemId = (input.scopeRef || '').trim();
          if (!itemId) return { status: 'error', detail: 'An item id (scopeRef) is required for item-scope grants.' };
          const items = await itemsContainer();
          const { resources } = await items.items
            .query<{ workspaceId: string }>({
              query: 'SELECT c.workspaceId FROM c WHERE c.id = @id',
              parameters: [{ name: '@id', value: itemId }],
            })
            .fetchAll();
          workspaceId = resources[0]?.workspaceId || '';
          if (!workspaceId) {
            return { status: 'error', detail: 'The requested item no longer exists — nothing to grant.' };
          }
        }
        const res = await addWorkspaceRole({
          workspaceId,
          principalId: input.principalId,
          principalType: input.principalType,
          displayName: input.principalName || input.principalId,
          role,
          addedBy: 'access-request-workflow',
        });
        return {
          status: 'active',
          roleName: role,
          roleAssignmentId: res.roleAssignment?.id,
          detail: `Granted workspace ${role} on ${workspaceId} — Loom-native access to the requested ${input.scopeType}.`,
        };
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 400);
        if (/already|exists|conflict/i.test(msg)) {
          return { status: 'active', roleName: role, detail: 'Role already assigned (idempotent).' };
        }
        return { status: 'error', detail: msg };
      }
    }

    default:
      return {
        status: 'pending',
        detail:
          `Enforcement for ${input.scopeType} scopes isn't wired to a runtime grant yet. ` +
          `The policy is recorded; scope it to an ADLS container, a warehouse, or a KQL database, ` +
          `which Loom enforces automatically.`,
      };
  }
}

/** Remove a previously-enforced ADLS RBAC grant (best-effort). */
export async function revokeAccessGrant(roleAssignmentId: string): Promise<void> {
  await revokeContainerRoleAssignment(roleAssignmentId).catch(() => { /* already gone */ });
}

/**
 * Revoke a non-ADLS structured grant (warehouse / kql-database) by replaying the
 * inverse data-plane command. Never throws (a policy delete must still
 * succeed); it REPORTS what happened, so a caller that records the revoke can
 * tell a revoke from a skip or a failure. ADLS grants are revoked via
 * {@link revokeAccessGrant} by id.
 */
export async function revokeStructuredGrant(input: AccessGrantInput): Promise<StructuredRevokeResult> {
  try {
    if (input.scopeType === 'warehouse') {
      const name = (input.principalName || '').trim();
      if (!name) return { status: 'skipped', detail: 'No principal name to revoke the warehouse role from.' };
      const roleName = SQL_ROLE[input.permission];
      const target = dedicatedTarget();
      // Dedicated SQL pools use sp_droprolemember (not ALTER ROLE ... DROP MEMBER).
      await synapseExecute(target, `EXEC sp_droprolemember ${sqlString(roleName)}, ${sqlString(name)};`);
      return { status: 'revoked' };
    }
    if (input.scopeType === 'kql-database') {
      const gate = kustoConfigGate();
      if (gate) return { status: 'skipped', detail: `ADX not configured (${gate.missing}).` };
      const roleName = ADX_ROLE[input.permission];
      // Like the grant: the scope must name the database. An empty scopeRef is
      // refused rather than read as the deployment's default database.
      const db = (input.scopeRef || '').trim();
      if (!db) return { status: 'error', detail: 'A KQL database name is required for the revoke scope; nothing was revoked.' };
      const principal = adxPrincipalToken(input);
      if ('gate' in principal) return { status: 'skipped', detail: principal.gate };
      await dropDatabasePrincipal(db, roleName, principal.token);
      return { status: 'revoked' };
    }
    return { status: 'skipped', detail: `No structured revoke for ${input.scopeType} scopes.` };
  } catch (e: any) {
    return { status: 'error', detail: (e?.message || String(e)).slice(0, 400) };
  }
}

/**
 * Whether `name` is already a member of the database role `roleName` on the
 * dedicated pool: true / false, or undefined when that could not be read.
 */
async function warehouseRoleHeld(target: ReturnType<typeof dedicatedTarget>, roleName: string, name: string): Promise<boolean | undefined> {
  try {
    const res = await synapseExecute(
      target,
      'SELECT COUNT(*) FROM sys.database_role_members rm '
        + 'JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id '
        + 'JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id '
        + 'WHERE r.name = @role AND m.name = @member;',
      60_000,
      [{ name: 'role', value: roleName }, { name: 'member', value: name }],
    );
    const n = Number((res.rows?.[0] as unknown[] | undefined)?.[0] ?? NaN);
    return Number.isFinite(n) ? n > 0 : undefined;
  } catch {
    return undefined;
  }
}

/** ADX role names are plural (`viewers`); `.show database principals` reports them singular. */
const ADX_ROLE_LABEL: Record<string, string> = { viewers: 'viewer', users: 'user', admins: 'admin' };

/** The ADX FQN prefix for each principal type (`aaduser=…`, `aadgroup=…`, `aadapp=…`). */
const ADX_FQN_KIND: Record<PrincipalType, string> = { User: 'aaduser', Group: 'aadgroup', ServicePrincipal: 'aadapp' };

/**
 * Split an ADX principal FQN (`aaduser=alice@contoso.com`,
 * `aadgroup=<oid>;<tenant>`) into its kind and identifier, both lower-cased.
 * The tenant segment after `;` is not compared. Returns null for any other
 * shape, so an unparseable row never counts as a match.
 */
export function parseAdxFqn(fqn: string): { kind: string; id: string } | null {
  const m = /^\s*(aaduser|aadgroup|aadapp)=([^;]+?)\s*(?:;.*)?$/i.exec(fqn || '');
  if (!m) return null;
  return { kind: m[1].toLowerCase(), id: m[2].trim().toLowerCase() };
}

/**
 * Whether the principal already holds `roleName` on ADX database `db`: true /
 * false, or undefined when the principals could not be read. A row matches on
 * exact objectId equality, or on an FQN of the same kind whose identifier is
 * exactly the principal's object id or UPN (case-insensitive) — never a
 * substring, so `aaduser=jalice@contoso.com` does not match `alice@contoso.com`.
 */
async function adxRoleHeld(db: string, roleName: string, input: AccessGrantInput): Promise<boolean | undefined> {
  try {
    const rows = await showDatabasePrincipals(db);
    const want = ADX_ROLE_LABEL[roleName] || roleName;
    const id = (input.principalId || '').trim().toLowerCase();
    const upn = (input.principalName || '').trim().toLowerCase();
    const kind = ADX_FQN_KIND[input.principalType] || 'aaduser';
    return rows.some((r) => {
      const role = (r.role || '').toLowerCase();
      // Exactly `Database <Role>` (or the bare role): never `Database Unrestricted Viewer`.
      if (!new RegExp(`^(database\\s+)?${want}$`).test(role.trim())) return false;
      if (!!id && (r.objectId || '').trim().toLowerCase() === id) return true;
      const p = parseAdxFqn(r.fqn);
      if (!p || p.kind !== kind) return false;
      return (!!id && p.id === id) || (!!upn && upn.includes('@') && p.id === upn);
    });
  } catch {
    return undefined;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DLP RESTRICT — schema-level enforcement on Synapse dedicated SQL.
//
// Restrict-access semantics map to **DENY** (an explicit block that overrides
// any role-based grant), per the Microsoft Purview "Restrict access" action for
// Fabric/Synapse. `DENY SELECT ON SCHEMA::[s]` is honored for Azure Synapse
// dedicated pools and Fabric Warehouse. NOTE: DENY/REVOKE does not terminate
// in-flight sessions — to cut access immediately, active requests must also be
// killed (surfaced to the caller).
//   https://learn.microsoft.com/sql/t-sql/statements/deny-schema-permissions-transact-sql
//   https://learn.microsoft.com/azure/synapse-analytics/sql/shared-databases-access-control
// ══════════════════════════════════════════════════════════════════════════

export interface SchemaDenyInput {
  /** UPN / display name of the Entra principal to block (required: CREATE USER). */
  principalName: string;
  /** SQL schema to deny SELECT on (e.g. `sales`, `dbo`). */
  schema: string;
}

export interface SchemaDenyResult {
  status: 'active' | 'pending' | 'error';
  /** The exact DDL executed (for the audit record). */
  statement?: string;
  database?: string;
  detail?: string;
}

/**
 * Enumerate user schemas in the env-bound Synapse dedicated pool so the DLP
 * wizard can present a dropdown (no free-text schema per loom-no-freeform-config).
 * Returns an honest gate when the warehouse is not configured.
 */
export async function listWarehouseSchemas(): Promise<{ schemas: string[] } | { gate: string }> {
  let target;
  try { target = dedicatedTarget(); }
  catch {
    return { gate: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to enumerate SQL schemas.' };
  }
  // User schemas only (system schema_ids fall outside 5..16383).
  const res = await synapseExecute(
    target,
    `SELECT name FROM sys.schemas WHERE schema_id BETWEEN 5 AND 16383 ORDER BY name;`,
  );
  const schemas = (res.rows || [])
    .map((r) => String((r as unknown[])[0] ?? '').trim())
    .filter(Boolean);
  return { schemas };
}

/** DLP restrict: DENY SELECT on a SQL schema to a principal (creating the user if absent). */
export async function denySchemaAccess(input: SchemaDenyInput): Promise<SchemaDenyResult> {
  const name = (input.principalName || '').trim();
  const schema = (input.schema || '').trim();
  if (!name) return { status: 'error', detail: 'A principal UPN / name is required to DENY warehouse schema access.' };
  if (!schema) return { status: 'error', detail: 'A SQL schema name is required.' };
  let target;
  try { target = dedicatedTarget(); }
  catch {
    return { status: 'pending', detail: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to enforce schema-level restrict.' };
  }
  const statement =
    `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${sqlString(name)})\n` +
    `  CREATE USER ${sqlBracket(name)} FROM EXTERNAL PROVIDER;\n` +
    `DENY SELECT ON SCHEMA::${sqlBracket(schema)} TO ${sqlBracket(name)};`;
  try {
    await synapseExecute(target, statement);
    return { status: 'active', statement, database: target.database, detail: `Denied SELECT on schema [${schema}] to ${name}.` };
  } catch (e: any) {
    return { status: 'error', statement, detail: (e?.message || String(e)).slice(0, 400) };
  }
}

/**
 * Enumerate the Entra principals that currently hold any data-access role
 * (db_datareader / db_datawriter / db_owner) in the env-bound Synapse dedicated
 * pool. Used by the protection-policy reconciler to compute "live − allow" and
 * REVOKE members not on the policy allow-list (positive-grant + remove-others —
 * apps cannot author Azure DENY). Returns names (UPNs) so they compare 1:1 with
 * the SQL grant path (which keys on principalName). Honest gate when the
 * warehouse is unset. Real TDS query — no mock.
 */
export async function listWarehousePrincipals(): Promise<{ principals: string[] } | { gate: string }> {
  let target;
  try { target = dedicatedTarget(); }
  catch {
    return { gate: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to list/converge warehouse access.' };
  }
  const res = await synapseExecute(
    target,
    `SELECT DISTINCT m.name FROM sys.database_role_members rm\n` +
      `  JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id\n` +
      `  JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id\n` +
      `  WHERE r.name IN ('db_datareader','db_datawriter','db_owner') AND m.type IN ('E','X','S');`,
  );
  const principals = (res.rows || [])
    .map((r) => String((r as unknown[])[0] ?? '').trim())
    .filter(Boolean);
  return { principals };
}

/** Inverse of {@link denySchemaAccess}: REVOKE the schema DENY (best-effort). */
export async function revokeSchemaDeny(input: SchemaDenyInput): Promise<void> {
  try {
    const name = (input.principalName || '').trim();
    const schema = (input.schema || '').trim();
    if (!name || !schema) return;
    const target = dedicatedTarget();
    await synapseExecute(target, `REVOKE SELECT ON SCHEMA::${sqlBracket(schema)} TO ${sqlBracket(name)};`);
  } catch {
    /* best-effort */
  }
}
