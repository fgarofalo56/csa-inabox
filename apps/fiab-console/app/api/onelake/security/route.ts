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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  revokeContainerRoleAssignment,
  getAcl,
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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Microsoft Graph OID → UPN enrichment (opt-in via LOOM_GRAPH_USERS_ENABLED) ─
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const graphCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

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
export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const container = sp.get('container');
  const workspaceId = sp.get('workspaceId');
  const ucCatalog = sp.get('ucCatalog');
  const knownContainers = [...KNOWN_CONTAINERS];

  if (!container) {
    // Bare GET — let the UI populate its container picker before a selection.
    return NextResponse.json({ ok: true, knownContainers, needsContainer: true });
  }

  const gates: { acl?: string; uc?: string; workspace?: string } = {};

  // 1) Storage RBAC at the container scope — required spine of the matrix.
  let rbac: ContainerRoleAssignment[];
  try {
    rbac = await listContainerRoleAssignments(container);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/LOOM_SUBSCRIPTION_ID|LOOM_DLZ_RG/.test(msg)) return rbacGate();
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
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { container, principalId, role, principalType } = body || {};
  if (!container || !principalId || !role) {
    return NextResponse.json(
      { ok: false, error: 'container, principalId and role are required' },
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
    // Re-granting an identical (principal, role, scope) triple 409s — surface it.
    return NextResponse.json({ ok: false, error: msg }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json(
      { ok: false, error: 'id (full ARM role-assignment id) required' },
      { status: 400 },
    );
  }
  try {
    await revokeContainerRoleAssignment(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: e?.status || 502 });
  }
}
