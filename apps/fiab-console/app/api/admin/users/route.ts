/**
 * GET /api/admin/users — list users with access to this tenant's Loom surfaces,
 * with license assignments + per-user workspace-role expansion. Layered strategy:
 *
 *   1. Primary (always works): enumerate from Cosmos workspace-permissions +
 *      workspace createdBy + item.createdBy across the tenant to build the user
 *      set, owner/member counts, items-created, and last-activity.
 *
 *   2. License + identity enrichment (when LOOM_GRAPH_USERS_ENABLED + the
 *      Console UAMI has Microsoft Graph Directory.Read.All + User.Read.All):
 *        • fetchSubscribedSkus()    → tenant license-SKU roll-up cards
 *        • listUsersWithLicenses()  → per-user displayName, department,
 *          accountEnabled, objectId, and assignedLicenses[].skuId resolved to
 *          skuPartNumber via the subscribedSkus join.
 *
 *   3. Workspace-role expansion (F5 system-of-record): the principalId-keyed
 *      `workspace-roles` container is read across all tenant workspaces and
 *      joined back to each user by their Entra objectId (from Graph). When Graph
 *      is not enabled, no objectId is available so wsRoles is empty — the legacy
 *      UPN-keyed `roles` (from workspace-permissions) still shows.
 *
 * The page works without Graph by default; license + role-expansion light up
 * transparently when the admin grant lands. No mocks, no placeholder arrays.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer, itemsContainer, workspacePermissionsContainer } from '@/lib/azure/cosmos-client';
import { fetchSubscribedSkus, listUsersWithLicenses } from '@/lib/azure/graph-identity-client';
import { listAllWorkspaceRolesForWorkspaces } from '@/lib/azure/workspace-roles-client';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserRow {
  upn: string;
  /** Entra objectId — from Graph; needed for the M365 admin deep-link + wsRoles join. */
  objectId?: string;
  displayName?: string;
  department?: string;
  accountEnabled?: boolean;
  workspacesOwned: number;
  workspacesMember: number;
  itemsCreated: number;
  lastActivity?: string;
  /** Legacy roles from the UPN-keyed workspace-permissions container. */
  roles: Set<string>;
  /** Per-workspace roles from the F5 principalId-keyed workspace-roles container. */
  wsRoles: Array<{ workspaceId: string; role: string }>;
  /** Resolved skuPartNumbers from assignedLicenses. */
  licenses: string[];
  graphEnriched: boolean;
}

/**
 * Microsoft 365 admin center base URL, sovereign-cloud aware:
 *   Commercial / GCC : admin.microsoft.com
 *   GCC-High         : admin.microsoft.us
 *   DoD (IL5/L5)     : admin.apps.mil
 */
function m365AdminBaseFor(): string {
  switch (detectLoomCloud()) {
    case 'DoD':
      return 'https://admin.apps.mil';
    case 'GCC-High':
      return 'https://admin.microsoft.us';
    default:
      return 'https://admin.microsoft.com';
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // This route enumerates the WHOLE Entra tenant (fetchSubscribedSkus +
  // listUsersWithLicenses via the Console UAMI's Graph app roles) — estate-wide
  // directory data, not per-user. Restrict to tenant admins before any Graph call.
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const permC = await workspacePermissionsContainer();

    // Tenant workspaces + tenant license-SKU roll-up run concurrently (Cosmos
    // and Graph are independent backends).
    const [{ resources: workspaces }, subscribedSkus] = await Promise.all([
      wsC.items.query({
        query: 'SELECT c.id, c.createdBy, c.updatedAt FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      }, { partitionKey: tenantId }).fetchAll(),
      fetchSubscribedSkus(),
    ]);
    const wsIds = workspaces.map((w: any) => w.id);

    // skuId → skuPartNumber for the per-user assignedLicenses join.
    const skuMap = new Map<string, string>();
    for (const sku of subscribedSkus) {
      if (sku.skuId) skuMap.set(sku.skuId, sku.skuPartNumber || sku.skuId);
    }

    let items: any[] = [];
    if (wsIds.length) {
      const { resources } = await itC.items.query({
        query: 'SELECT c.workspaceId, c.createdBy, c.updatedAt FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      items = resources;
    }

    // workspace-permissions container is partition-keyed by /workspaceId
    let permissions: any[] = [];
    try {
      const { resources: perms } = await permC.items.query({
        query: 'SELECT c.workspaceId, c.upn, c.role FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      permissions = perms;
    } catch { /* container may be empty */ }

    const users = new Map<string, UserRow>();
    function touch(rawUpn: string): UserRow {
      const upn = (rawUpn || '').toLowerCase();
      let u = users.get(upn);
      if (!u) {
        u = {
          upn,
          workspacesOwned: 0,
          workspacesMember: 0,
          itemsCreated: 0,
          roles: new Set(),
          wsRoles: [],
          licenses: [],
          graphEnriched: false,
        };
        users.set(upn, u);
      }
      return u;
    }

    for (const w of workspaces) {
      if (w.createdBy) {
        const u = touch(w.createdBy);
        u.workspacesOwned++;
        u.roles.add('Owner');
        if (w.updatedAt && (!u.lastActivity || w.updatedAt > u.lastActivity)) u.lastActivity = w.updatedAt;
      }
    }
    for (const it of items) {
      if (it.createdBy) {
        const u = touch(it.createdBy);
        u.itemsCreated++;
        if (it.updatedAt && (!u.lastActivity || it.updatedAt > u.lastActivity)) u.lastActivity = it.updatedAt;
      }
    }
    for (const p of permissions) {
      if (p.upn) {
        const u = touch(p.upn);
        if (p.role !== 'Owner') u.workspacesMember++;
        if (p.role) u.roles.add(p.role);
      }
    }

    // Graph enrichment (license + identity) and workspace-role expansion run
    // concurrently — neither depends on the other.
    const upns = Array.from(users.keys());
    const [graphMap, allWsRoles] = await Promise.all([
      listUsersWithLicenses(upns),
      listAllWorkspaceRolesForWorkspaces(wsIds),
    ]);

    // Merge Graph identity + licenses; build objectId → upn for the role join.
    const objectIdToUpn = new Map<string, string>();
    for (const [upn, info] of graphMap.entries()) {
      const u = users.get(upn);
      if (!u) continue;
      u.displayName = info.displayName;
      u.department = info.department;
      u.accountEnabled = info.accountEnabled;
      u.objectId = info.id;
      u.graphEnriched = true;
      const seen = new Set<string>();
      for (const lic of info.assignedLicenses) {
        const part = skuMap.get(lic.skuId) || lic.skuId;
        if (part && !seen.has(part)) { seen.add(part); u.licenses.push(part); }
      }
      if (info.id) objectIdToUpn.set(info.id, upn);
    }

    // Join workspace-roles (principalId-keyed) back to users by objectId.
    for (const wr of allWsRoles) {
      const upn = wr.principalId ? objectIdToUpn.get(wr.principalId) : undefined;
      if (!upn) continue; // group assignments / unmatched principals are not user rows
      const u = users.get(upn);
      if (u) u.wsRoles.push({ workspaceId: wr.workspaceId, role: wr.role });
    }

    const rows = Array.from(users.values())
      .map((u) => ({
        upn: u.upn,
        objectId: u.objectId,
        displayName: u.displayName,
        department: u.department,
        accountEnabled: u.accountEnabled,
        workspacesOwned: u.workspacesOwned,
        workspacesMember: u.workspacesMember,
        itemsCreated: u.itemsCreated,
        lastActivity: u.lastActivity,
        roles: Array.from(u.roles),
        wsRoles: u.wsRoles,
        licenses: u.licenses,
        graphEnriched: u.graphEnriched,
      }))
      .sort((a, b) => (b.itemsCreated + b.workspacesOwned * 5) - (a.itemsCreated + a.workspacesOwned * 5));

    return NextResponse.json({
      ok: true,
      total: rows.length,
      users: rows,
      subscribedSkus,
      graphEnabled: process.env.LOOM_GRAPH_USERS_ENABLED === 'true',
      enrichedCount: rows.filter((r) => r.graphEnriched).length,
      m365AdminBase: m365AdminBaseFor(),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
