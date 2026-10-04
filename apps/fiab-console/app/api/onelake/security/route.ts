/**
 * OneLake catalog — Secure tab BFF.
 *
 * One-for-one with the Microsoft Fabric OneLake catalog **Secure** tab
 * (https://learn.microsoft.com/fabric/governance/secure-your-data), built
 * entirely on Azure-native backends — NO Fabric / Power BI REST is touched
 * (per no-fabric-dependency.md). It rolls up "who has access" to a bound
 * lakehouse container from three real Azure planes:
 *
 *   1. Azure RBAC role-assignments at the container scope
 *      (Storage Blob Data Reader/Contributor/Owner) — ARM, ALL clouds.
 *      → adls-client.listContainerRoleAssignments(container)
 *   2. ADLS Gen2 POSIX ACL entries on the container root (the Azure-native
 *      equivalent of OneLake security roles) — DFS, ALL clouds. Needs
 *      Storage Blob Data Owner on an HNS account; an honest gate is surfaced
 *      on 403.
 *      → adls-client.getAcl(container, '')
 *   3. Workspace role assignments (Admin/Member/Contributor/Viewer) from the
 *      Cosmos system-of-record — ALL clouds.
 *      → workspace-roles-client.listWorkspaceRoles(workspaceId)
 *   4. (Optional, Commercial/GCC only) Databricks Unity Catalog grants on the
 *      matching catalog — UC is not available in GCC-High/IL5/DoD, so the call
 *      is skipped there with an honest gate.
 *      → unity-catalog-client.listPermissions(host, 'CATALOG', name)
 *
 * Principals (Entra object ids) are enriched OID→UPN via Microsoft Graph when
 * LOOM_GRAPH_USERS_ENABLED=true (sovereign-correct scope via cloud-endpoints).
 *
 * GET  ?container=<c>[&workspaceId=<id>][&ucCatalog=<name>]
 *        → { ok, container, rbacAssignments, aclEntries, workspaceRoles,
 *            ucGrants?, matrix, knownRoles, knownContainers, gates }
 * POST { container, principalId, role, principalType }
 *        → grantContainerRole — the new principal shows on the next GET.
 * DELETE ?id=<armId>  → revoke an RBAC role-assignment.
 *
 * No mock principals. Every row originates from ARM, the DFS ACL, Cosmos, or
 * UC — or the surface shows a precise infra gate (no-vaporware.md).
 *
 * Authorization (#4619): every verb is TENANT-ADMIN (`withTenantAdmin`, the
 * gate runs before the query or body is read).
 *   - POST (grant) and DELETE (revoke) change Azure RBAC on a container of the
 *     deployment's shared lake account — the same gate as the lakehouse
 *     permissions POST. A refused caller never reaches `grantContainerRole` /
 *     `revokeContainerRoleAssignment`.
 *   - GET lists the RBAC principals, ACL entries and workspace roles on a
 *     shared container. The Secure tab's principal search already needs the
 *     `admin.permissions` capability, so the read matches the write.
 * POST and GET refuse a `container` that is not a valid storage container name.
 * DELETE accepts `id` only when it is, in full and with nothing before or after
 * it, a role-assignment id at a container scope of THIS deployment's lake
 * account, AND it is one of the assignments `listContainerRoleAssignments`
 * currently returns for that container; the id revoked is the listed one, not
 * the caller's string. (`revokeContainerRoleAssignmentInScope`, being added
 * for the lakehouse permissions route, answers the same question; the two
 * should converge on one helper.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { ArmScopeSegmentError } from '@/lib/azure/arm-scope-segment';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import type { TenantAdminRefusal } from '@/lib/auth/feature-gate';
import { isValidContainerName } from '@/app/api/storage/_lib/validate';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  revokeContainerRoleAssignment,
  getAcl,
  getAccountName,
  listKnownBlobDataRoles,
  KNOWN_CONTAINERS,
  type ContainerRoleAssignment,
  type AclItem,
} from '@/lib/azure/adls-client';
import {
  listWorkspaceRoles,
  type WorkspaceRoleAssignment,
} from '@/lib/azure/workspace-roles-client';
import {
  listWorkspaceHostnames,
  listPermissions,
  UnityCatalogNotConfiguredError,
  type UCPermissionAssignment,
} from '@/lib/azure/unity-catalog-client';
import { isGovCloud, graphBase, graphScope } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Microsoft Graph OID → UPN enrichment (opt-in via LOOM_GRAPH_USERS_ENABLED) ─
// ACA-first UAMI chain (see lib/azure/arm-credential.ts — the ACA MI token bug).
const graphCredential = uamiArmCredential();

async function enrichUpns(oids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (process.env.LOOM_GRAPH_USERS_ENABLED !== 'true') return map;
  const unique = Array.from(new Set(oids.filter(Boolean)));
  if (unique.length === 0) return map;
  let token: string;
  try {
    const t = await graphCredential.getToken(graphScope());
    if (!t?.token) return map;
    token = t.token;
  } catch {
    return map; // graceful — UI falls back to OID prefix
  }
  await Promise.all(
    unique.map(async (oid) => {
      try {
        const res = await fetch(
          `${graphBase()}/directoryObjects/${encodeURIComponent(oid)}?$select=id,displayName,userPrincipalName`,
          { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store' },
        );
        if (res.ok) {
          const j: any = await res.json();
          const name = j?.userPrincipalName || j?.displayName;
          if (name) map.set(oid, String(name));
        }
      } catch {
        /* per-principal failure is non-fatal */
      }
    }),
  );
  return map;
}

// ── Matrix shape (mirrored, structurally, in secure-view.tsx) ─────────────────
interface MatrixRow {
  principalId: string;
  displayName: string;
  principalType: string;
  workspaceRole?: string; // Admin | Member | Contributor | Viewer
  storageRbacRole?: string; // Storage Blob Data Reader/Contributor/Owner
  storageRbacAssignmentId?: string; // ARM id — enables revoke from the matrix
  aclPermissions?: { read: boolean; write: boolean; execute: boolean };
  ucPrivileges?: string[];
}

function buildMatrix(
  rbac: ContainerRoleAssignment[],
  acl: AclItem[],
  workspaceRoles: WorkspaceRoleAssignment[],
  ucGrants: UCPermissionAssignment[] | undefined,
  upnByOid: Map<string, string>,
): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();

  const ensure = (principalId: string, principalType: string): MatrixRow => {
    let r = rows.get(principalId);
    if (!r) {
      r = {
        principalId,
        displayName: upnByOid.get(principalId) || principalId,
        principalType,
      };
      rows.set(principalId, r);
    }
    if (r.displayName === r.principalId && upnByOid.has(principalId)) {
      r.displayName = upnByOid.get(principalId)!;
    }
    return r;
  };

  // 1) Storage RBAC at the container scope (keyed by Entra OID).
  for (const a of rbac) {
    if (!a.principalId) continue;
    const r = ensure(a.principalId, a.principalType || 'User');
    r.storageRbacRole = a.roleName || r.storageRbacRole;
    r.storageRbacAssignmentId = a.id || r.storageRbacAssignmentId;
  }

  // 2) POSIX ACL entries (keyed by Entra OID; skip mask/other which have none).
  for (const e of acl) {
    if (e.scope !== 'access') continue; // show effective access ACLs, not default-inherit
    if (!e.entityId || (e.type !== 'user' && e.type !== 'group')) continue;
    const r = ensure(e.entityId, e.type === 'group' ? 'Group' : 'User');
    r.aclPermissions = { ...e.permissions };
  }

  // 3) Workspace roles (keyed by Entra OID; carries its own displayName).
  for (const w of workspaceRoles) {
    if (!w.principalId) continue;
    const r = ensure(w.principalId, w.principalType || 'User');
    r.workspaceRole = w.role;
    if (r.displayName === r.principalId && w.displayName) r.displayName = w.displayName;
  }

  // 4) UC grants key by principal NAME (UPN / group name), not OID — best-effort
  //    merge onto a matrix row whose displayName matches; otherwise the row is
  //    still surfaced (UC principals are real Databricks grantees).
  if (ucGrants) {
    const byName = new Map<string, MatrixRow>();
    for (const r of rows.values()) byName.set(r.displayName.toLowerCase(), r);
    for (const g of ucGrants) {
      const key = String(g.principal || '').toLowerCase();
      const match = byName.get(key);
      if (match) {
        match.ucPrivileges = Array.from(new Set([...(match.ucPrivileges || []), ...(g.privileges || [])]));
      } else {
        const r: MatrixRow = {
          principalId: g.principal,
          displayName: g.principal,
          principalType: 'UC grant',
          ucPrivileges: g.privileges || [],
        };
        rows.set(`uc:${g.principal}`, r);
        byName.set(key, r);
      }
    }
  }

  return Array.from(rows.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function rbacGate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      gate: true,
      surface: 'OneLake container access (Azure RBAC)',
      missing: 'LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG',
      hint: 'The access matrix rolls up Azure RBAC role-assignments at the lakehouse container scope. Set LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG on loom-console (already wired in platform/fiab/bicep/modules/admin-plane/main.bicep) and grant the Console UAMI Role Based Access Control Administrator (constrained) on the storage account via platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep.',
    },
    { status: 503 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
/** What the 403 says for a non-admin on any verb of this route. */
const SECURE_TAB_REFUSAL: TenantAdminRefusal = {
  reason:
    'The OneLake Secure tab lists, grants and revokes Azure RBAC on the deployment\'s shared lake '
    + 'containers. Those assignments apply to the whole container, not to one item, so this surface '
    + 'is restricted to tenant admins.',
};

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/**
 * A resource-group name, per ARM's rule: 1 to 90 characters of Unicode letters
 * (`\p{L}`), Unicode decimal digits (`\p{Nd}`), `_`, `-`, `.`, `(`, `)`, not
 * ending in a period, so `.` and `..` are refused. Its own pattern with the `u`
 * flag, and NOT folded into the id pattern below: that one is case-insensitive,
 * and `iu` together folds some non-ASCII characters into ASCII classes (U+212A
 * KELVIN SIGN matches `[a-z]` and a literal `k`), which would widen the account
 * and the fixed segments. Kept on one line; the test lifts it from this source.
 */
const RESOURCE_GROUP_NAME_RE = /^[-\p{L}\p{Nd}_.()]{0,89}[-\p{L}\p{Nd}_()]$/u;
/**
 * A role-assignment id at a CONTAINER scope, in full. Anchored at both ends (JS
 * `$` without the `m` flag matches only at the end of the input), and no
 * character class admits `/` beyond the literal separators, or `?` / `#`.
 * Captures: 1 resource group (checked by RESOURCE_GROUP_NAME_RE), 2 account,
 * 3 container.
 */
const CONTAINER_ROLE_ASSIGNMENT_ID_RE = new RegExp(
  `^/subscriptions/${GUID}/resourceGroups/([^/?#]{1,90})`
  + '/providers/Microsoft\\.Storage/storageAccounts/([a-z0-9]{3,24})'
  + '/blobServices/default/containers/([a-z0-9-]{3,63})'
  + `/providers/Microsoft\\.Authorization/roleAssignments/${GUID}$`,
  // Case-insensitive: ARM does not guarantee the casing of the fixed segments.
  // The captured account and container are checked separately below, and
  // `isValidContainerName` refuses an upper-case container.
  'i',
);

/**
 * The container a revoke targets, or the reason `id` is refused. Shape and
 * account are checked here; membership in the container's current assignments
 * is checked by the caller against a live list.
 */
function parseRevokeTarget(id: string): { container: string } | { error: string } {
  const m = CONTAINER_ROLE_ASSIGNMENT_ID_RE.exec(id);
  if (!m || !RESOURCE_GROUP_NAME_RE.test(m[1])) {
    return { error: 'id must be a full role-assignment id at a container scope of this deployment\'s lake account' };
  }
  const [, , account, container] = m;
  if (account.toLowerCase() !== getAccountName().toLowerCase()) {
    return { error: 'id names a storage account other than this deployment\'s lake account' };
  }
  if (!isValidContainerName(container)) {
    return { error: 'id names a container that is not a valid storage container name' };
  }
  return { container };
}

// ─────────────────────────────────────────────────────────────────────────────
export const GET = withTenantAdmin(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const container = sp.get('container');
  const workspaceId = sp.get('workspaceId');
  const ucCatalog = sp.get('ucCatalog');
  const knownContainers = [...KNOWN_CONTAINERS];

  if (!container) {
    // Bare GET — let the UI populate its container picker before a selection.
    return NextResponse.json({ ok: true, knownContainers, needsContainer: true });
  }
  if (!isValidContainerName(container)) {
    return NextResponse.json(
      { ok: false, error: 'container must be a storage container name: 3-63 lowercase letters, digits or single hyphens' },
      { status: 400 },
    );
  }

  const gates: { acl?: string; uc?: string; workspace?: string } = {};

  // 1) Storage RBAC at the container scope — required spine of the matrix.
  let rbac: ContainerRoleAssignment[];
  try {
    rbac = await listContainerRoleAssignments(container);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/LOOM_SUBSCRIPTION_ID|LOOM_DLZ_RG/.test(msg)) return rbacGate();
    // A malformed container or role-assignment id is the caller's input, not an upstream failure.
    if (e instanceof ArmScopeSegmentError) return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    return NextResponse.json({ ok: false, error: msg }, { status: e?.status || 502 });
  }

  // 2) ADLS POSIX ACL on the container root — honest gate on 403 (needs Owner).
  let aclEntries: AclItem[] = [];
  try {
    aclEntries = await getAcl(container, '');
  } catch (e: any) {
    const status = e?.statusCode ?? e?.status;
    if (status === 403) {
      gates.acl =
        'POSIX ACLs unavailable: grant the Console UAMI "Storage Blob Data Owner" on the container (see platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep). ACL reads require Owner on the HNS-enabled ADLS Gen2 account.';
    } else if (status === 404 || status === 409) {
      // Non-HNS account (no hierarchical namespace) — ACLs don't apply here.
      gates.acl = 'This storage account is not HNS-enabled, so POSIX ACLs (OneLake security roles) do not apply. Container access is governed by Azure RBAC above.';
    } else {
      gates.acl = `POSIX ACLs unavailable: ${String(e?.message || e).slice(0, 240)}`;
    }
  }

  // 3) Workspace roles (Cosmos system-of-record) — only when a workspace is in scope.
  let workspaceRoles: WorkspaceRoleAssignment[] = [];
  if (workspaceId) {
    try {
      workspaceRoles = await listWorkspaceRoles(workspaceId);
    } catch (e: any) {
      gates.workspace = `Workspace roles unavailable: ${String(e?.message || e).slice(0, 240)}`;
    }
  }

  // 4) Unity Catalog grants — Commercial/GCC only; never in GCC-High/IL5/DoD.
  let ucGrants: UCPermissionAssignment[] | undefined;
  if (isGovCloud()) {
    gates.uc =
      'Databricks Unity Catalog is not available in GCC-High / IL5 / DoD clouds. Azure RBAC and POSIX ACL above remain the access controls.';
  } else if (!process.env.LOOM_DATABRICKS_HOSTNAME && !process.env.LOOM_DATABRICKS_HOSTNAMES) {
    gates.uc =
      'Unity Catalog grants not shown: set LOOM_DATABRICKS_HOSTNAME on loom-console to roll up UC catalog privileges alongside Azure RBAC.';
  } else {
    try {
      const host = listWorkspaceHostnames()[0];
      const catalog = ucCatalog || container; // convention: lakehouse name == UC catalog name
      const perms = await listPermissions(host, 'CATALOG', catalog);
      ucGrants = perms.privilege_assignments || [];
    } catch (e: any) {
      if (e instanceof UnityCatalogNotConfiguredError) {
        gates.uc = e.message;
      } else {
        // Catalog may not exist for this container — honest, real message (no mock).
        gates.uc = `Unity Catalog grants unavailable for catalog "${ucCatalog || container}": ${String(e?.message || e).slice(0, 200)}`;
      }
    }
  }

  // OID → UPN enrichment across every plane's principals.
  const oids = [
    ...rbac.map((r) => r.principalId),
    ...aclEntries.map((a) => a.entityId || ''),
    ...workspaceRoles.map((w) => w.principalId),
  ];
  const upnByOid = await enrichUpns(oids);

  const rbacAssignments = rbac.map((r) =>
    upnByOid.has(r.principalId) ? { ...r, upn: upnByOid.get(r.principalId) } : r,
  );
  const matrix = buildMatrix(rbac, aclEntries, workspaceRoles, ucGrants, upnByOid);

  return NextResponse.json({
    ok: true,
    container,
    rbacAssignments,
    aclEntries,
    workspaceRoles,
    ucGrants,
    matrix,
    knownRoles: listKnownBlobDataRoles(),
    knownContainers,
    gates,
  });
}, SECURE_TAB_REFUSAL);

// Tenant-admin: 401 without a session, then the 403 `admin_only` envelope —
// before the body is read, so a refused caller never grants.
export const POST = withTenantAdmin(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const { container, principalId, role, principalType } = body || {};
  if (!container || !principalId || !role) {
    return NextResponse.json(
      { ok: false, error: 'container, principalId and role are required' },
      { status: 400 },
    );
  }
  if (typeof container !== 'string' || !isValidContainerName(container)) {
    return NextResponse.json(
      { ok: false, error: 'container must be a storage container name: 3-63 lowercase letters, digits or single hyphens' },
      { status: 400 },
    );
  }
  try {
    const assignment = await grantContainerRole(
      container,
      String(principalId).trim(),
      role,
      principalType && ['User', 'Group', 'ServicePrincipal'].includes(principalType) ? principalType : 'User',
    );
    return NextResponse.json({ ok: true, assignment });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/LOOM_SUBSCRIPTION_ID|LOOM_DLZ_RG/.test(msg)) return rbacGate();
    // A malformed container or role-assignment id is the caller's input, not an upstream failure.
    if (e instanceof ArmScopeSegmentError) return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    // Re-granting an identical (principal, role, scope) triple 409s — surface it.
    return NextResponse.json({ ok: false, error: msg }, { status: e?.status || 502 });
  }
}, SECURE_TAB_REFUSAL);

// Tenant-admin, same gate as POST: a refused caller never revokes. The id must
// name a CURRENT blob-data role assignment on a container of this deployment's
// lake account; anything else is refused before any ARM call.
export const DELETE = withTenantAdmin(async (req: NextRequest) => {
  const id = (req.nextUrl.searchParams.get('id') || '').trim();
  if (!id) {
    return NextResponse.json(
      { ok: false, error: 'id (full ARM role-assignment id) required' },
      { status: 400 },
    );
  }
  try {
    // Inside the try: `getAccountName` throws when no lake account is configured.
    const target = parseRevokeTarget(id);
    if ('error' in target) return NextResponse.json({ ok: false, error: target.error }, { status: 400 });
    const current = await listContainerRoleAssignments(target.container);
    const listed = current.find((r) => typeof r.id === 'string' && r.id.toLowerCase() === id.toLowerCase());
    if (!listed) {
      return NextResponse.json(
        { ok: false, error: `no blob-data role assignment with that id exists on container "${target.container}"` },
        { status: 404 },
      );
    }
    await revokeContainerRoleAssignment(listed.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/LOOM_SUBSCRIPTION_ID|LOOM_DLZ_RG/.test(msg)) return rbacGate();
    // A malformed container or role-assignment id is the caller's input, not an upstream failure.
    if (e instanceof ArmScopeSegmentError) return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    return NextResponse.json({ ok: false, error: msg }, { status: e?.status || 502 });
  }
}, SECURE_TAB_REFUSAL);
