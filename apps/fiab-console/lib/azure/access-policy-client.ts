/**
 * Access-policy enforcement — makes Governance → Policies "Access" rules REAL
 * instead of persist-only. A Loom-native, Azure-native data-access grant =
 * give a PRINCIPAL (Entra user/group/SP) a PERMISSION (read/write/admin) on a
 * data scope, enforced as a real data-plane grant:
 *
 *   - adls-container → Storage RBAC role assignment (Storage Blob Data *).
 *   - warehouse      → Synapse **Dedicated SQL** Entra DB user + role membership
 *                      (db_datareader / db_datawriter / db_owner).
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
import { executeMgmtCommand, defaultDatabase, kustoConfigGate } from './kusto-client';

export type AccessPermission = 'read' | 'write' | 'admin';
export type AccessScopeType = 'adls-container' | 'warehouse' | 'kql-database' | 'workspace' | 'item' | 'collection';
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
      try {
        // Create the Entra DB user if absent, then add it to the fixed role.
        const sql =
          `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${sqlString(name)})\n` +
          `  CREATE USER ${sqlBracket(name)} FROM EXTERNAL PROVIDER;\n` +
          `ALTER ROLE ${roleName} ADD MEMBER ${sqlBracket(name)};`;
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
        const cmd = `.add database ["${db.replace(/"/g, '')}"] ${roleName} ('${principal.token}') 'Granted via Loom access policy'`;
        await executeMgmtCommand(db, cmd);
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
      await synapseExecute(target, `ALTER ROLE ${roleName} DROP MEMBER ${sqlBracket(name)};`);
    } else if (input.scopeType === 'kql-database') {
      if (kustoConfigGate()) return;
      const roleName = ADX_ROLE[input.permission];
      const db = (input.scopeRef || defaultDatabase() || '').trim();
      if (!db) return;
      const principal = adxPrincipalToken(input);
      if ('gate' in principal) return;
      await executeMgmtCommand(db, `.drop database ["${db.replace(/"/g, '')}"] ${roleName} ('${principal.token}')`);
    }
  } catch {
    /* best-effort revoke — never block the policy delete */
  }
}
