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
 * No Microsoft Fabric / Purview-policy dependency (no-fabric-dependency.md): all
 * three are Azure-native data-plane grants. Scopes Loom still can't bind
 * (workspace / item / collection) return status 'pending' with a precise reason
 * — never a silent no-op (no-vaporware.md).
 */
import { grantContainerRole, revokeContainerRoleAssignment } from './adls-client';
import { dedicatedTarget, executeQuery as synapseExecute } from './synapse-sql-client';
import { getPoolState, resumePool } from './synapse-pool-arm';
import {
  defaultDatabase,
  kustoConfigGate,
  addDatabasePrincipal,
  dropDatabasePrincipal,
} from './kusto-client';

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
}

// ── SQL identifier/literal escaping (no string injection) ─────────────────────
function sqlBracket(ident: string): string { return `[${ident.replace(/]/g, ']]')}]`; }
function sqlString(s: string): string { return `N'${s.replace(/'/g, "''")}'`; }

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
        return { status: 'active', roleName: grant.roleName || roleName, roleAssignmentId: grant.id };
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 400);
        if (/\b409\b|already exists|RoleAssignmentExists/i.test(msg)) {
          return { status: 'active', roleName, detail: 'Role already assigned at this scope (idempotent).' };
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
      let target;
      try { target = dedicatedTarget(); }
      catch {
        return { status: 'pending', detail: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to enforce warehouse grants.' };
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
        return { status: 'active', roleName, detail: `Granted ${roleName} on ${target.database} to ${name}.` };
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 400);
        if (/already a member|already exists/i.test(msg)) {
          return { status: 'active', roleName, detail: 'Already a member of the role (idempotent).' };
        }
        return { status: 'error', detail: msg };
      }
    }

    case 'kql-database': {
      const gate = kustoConfigGate();
      if (gate) return { status: 'pending', detail: `ADX not configured: set ${gate.missing} to enforce KQL-database grants.` };
      const roleName = ADX_ROLE[input.permission];
      const db = (input.scopeRef || defaultDatabase() || '').trim();
      if (!db) return { status: 'error', detail: 'A KQL database name is required for the grant scope.' };
      const principal = adxPrincipalToken(input);
      if ('gate' in principal) return { status: 'pending', detail: principal.gate };
      try {
        // `.add database ["db"] <role> ('<fqn>')` via the typed helper, which
        // allow-lists the role (KUSTO_DATABASE_ROLES) and centralizes escaping.
        await addDatabasePrincipal(db, roleName, principal.token);
        return { status: 'active', roleName, detail: `Granted ${roleName} on ADX database ${db}.` };
      } catch (e: any) {
        return { status: 'error', detail: (e?.message || String(e)).slice(0, 400) };
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
 * inverse data-plane command. Best-effort — never throws (the policy delete must
 * still succeed). ADLS grants are revoked via {@link revokeAccessGrant} by id.
 */
export async function revokeStructuredGrant(input: AccessGrantInput): Promise<void> {
  try {
    if (input.scopeType === 'warehouse') {
      const name = (input.principalName || '').trim();
      if (!name) return;
      const roleName = SQL_ROLE[input.permission];
      const target = dedicatedTarget();
      // Dedicated SQL pools use sp_droprolemember (not ALTER ROLE ... DROP MEMBER).
      await synapseExecute(target, `EXEC sp_droprolemember ${sqlString(roleName)}, ${sqlString(name)};`);
    } else if (input.scopeType === 'kql-database') {
      if (kustoConfigGate()) return;
      const roleName = ADX_ROLE[input.permission];
      const db = (input.scopeRef || defaultDatabase() || '').trim();
      if (!db) return;
      const principal = adxPrincipalToken(input);
      if ('gate' in principal) return;
      await dropDatabasePrincipal(db, roleName, principal.token);
    }
  } catch {
    /* best-effort revoke — never block the policy delete */
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
