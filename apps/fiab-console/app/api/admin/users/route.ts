/**
 * GET /api/admin/users — list users with access to this tenant's Loom
 * surfaces. Two-tier strategy:
 *
 *   1. Primary: enumerate from Cosmos workspace-permissions + workspace
 *      createdBy + item.createdBy across the tenant. Always works.
 *
 *   2. Optional: when LOOM_GRAPH_USERS_ENABLED is set + the Console UAMI
 *      has Microsoft Graph Directory.Read.All granted, ALSO call
 *      https://graph.microsoft.com/v1.0/users to fetch display names +
 *      department + license info, merged by UPN.
 *
 * The page works without Graph by default; merge happens transparently
 * when admin grant lands.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer, workspacePermissionsContainer } from '@/lib/azure/cosmos-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserRow {
  upn: string;
  displayName?: string;
  workspacesOwned: number;
  workspacesMember: number;
  itemsCreated: number;
  lastActivity?: string;
  roles: Set<string>;
  department?: string;
  graphEnriched: boolean;
}

const GRAPH_BASE = process.env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

let cachedCred: ChainedTokenCredential | null = null;
function credential() {
  if (cachedCred) return cachedCred;
  const cid = process.env.LOOM_UAMI_CLIENT_ID;
  const chain: any[] = [];
  if (cid) chain.push(new ManagedIdentityCredential({ clientId: cid }));
  chain.push(new DefaultAzureCredential());
  cachedCred = new ChainedTokenCredential(...chain);
  return cachedCred;
}

async function enrichFromGraph(upns: string[]): Promise<Map<string, { displayName: string; department?: string }>> {
  const out = new Map<string, { displayName: string; department?: string }>();
  if (!upns.length || process.env.LOOM_GRAPH_USERS_ENABLED !== 'true') return out;
  try {
    const token = (await credential().getToken(GRAPH_SCOPE))?.token;
    if (!token) return out;
    // Graph $batch caps at 20 per call; chunk the UPN list.
    for (let i = 0; i < upns.length; i += 15) {
      const slice = upns.slice(i, i + 15);
      const filter = slice.map((u) => `userPrincipalName eq '${u.replace(/'/g, "''")}'`).join(' or ');
      const url = `${GRAPH_BASE}/users?$select=userPrincipalName,displayName,department&$filter=${encodeURIComponent(filter)}`;
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const u of (j.value || [])) {
        if (u.userPrincipalName) {
          out.set(u.userPrincipalName.toLowerCase(), { displayName: u.displayName, department: u.department });
        }
      }
    }
  } catch { /* Graph optional */ }
  return out;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const permC = await workspacePermissionsContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.createdBy, c.updatedAt FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);

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
        u = { upn, workspacesOwned: 0, workspacesMember: 0, itemsCreated: 0, roles: new Set(), graphEnriched: false };
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

    const upns = Array.from(users.keys());
    const graphMap = await enrichFromGraph(upns);
    for (const [upn, info] of graphMap.entries()) {
      const u = users.get(upn);
      if (u) {
        u.displayName = info.displayName;
        u.department = info.department;
        u.graphEnriched = true;
      }
    }

    const rows = Array.from(users.values())
      .map((u) => ({
        upn: u.upn,
        displayName: u.displayName,
        department: u.department,
        workspacesOwned: u.workspacesOwned,
        workspacesMember: u.workspacesMember,
        itemsCreated: u.itemsCreated,
        lastActivity: u.lastActivity,
        roles: Array.from(u.roles),
        graphEnriched: u.graphEnriched,
      }))
      .sort((a, b) => (b.itemsCreated + b.workspacesOwned * 5) - (a.itemsCreated + a.workspacesOwned * 5));

    return NextResponse.json({
      ok: true,
      total: rows.length,
      users: rows,
      graphEnabled: process.env.LOOM_GRAPH_USERS_ENABLED === 'true',
      enrichedCount: rows.filter((r) => r.graphEnriched).length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
