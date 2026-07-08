/**
 * Workspaces admin client (F6 — Workspaces list & govern).
 *
 * Server-side ONLY (imports the Cosmos SDK singleton). Powers the tenant-wide
 * `/admin/workspaces` inventory: every workspace in the tenant, regardless of
 * owner, with LIVE item counts, last-activity, capacity, state, and the
 * resolved owner set.
 *
 * Why a CROSS-PARTITION scan: each workspace doc is partitioned by `/tenantId`,
 * and in this codebase `workspace.tenantId === the creating user's oid` (see
 * POST /api/workspaces — every workspace lives in its own logical partition
 * keyed by its creator). A single-partition query (the previous route) would
 * therefore only ever return the admin's OWN workspaces. To enumerate the whole
 * tenant we issue `SELECT * FROM c` with NO `{ partitionKey }` option so the
 * @azure/cosmos SDK fans out across every physical partition. The Console UAMI's
 * "Cosmos DB Built-in Data Contributor" role at account scope already authorises
 * the fan-out — no extra RBAC grant required. This is an admin-only surface
 * (gated by isTenantAdmin in the route), so the cost is acceptable.
 *
 * Per .claude/rules/no-vaporware.md: real Cosmos reads only — never `return []`
 * placeholders. Per .claude/rules/no-fabric-dependency.md: zero Fabric/Power BI
 * calls — Azure Cosmos DB NoSQL is the one and only backend.
 */

import {
  workspacesContainer,
  itemsContainer,
  workspaceRolesContainer,
} from '@/lib/azure/cosmos-client';
import type { Workspace } from '@/lib/types/workspace';

/** Explicit lifecycle enum (no free-form string — per loom-no-freeform-config). */
export type WorkspaceState = 'Active' | 'Provisioning' | 'Suspended' | 'Deleted';

const VALID_STATES: readonly WorkspaceState[] = ['Active', 'Provisioning', 'Suspended', 'Deleted'];

/** Coerce a stored `state` value to a known enum member; default 'Active'. */
function normalizeState(s: unknown): WorkspaceState {
  return (VALID_STATES as readonly string[]).includes(s as string) ? (s as WorkspaceState) : 'Active';
}

export interface WorkspaceAdminRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Implicit owner — the creator. Always present in `owners`. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  capacity?: string;
  domain?: string;
  /** ARM resource id of a bound storage account (for the OneLake settings tab). */
  storageAccountId?: string;
  state: WorkspaceState;
  /** Live item count from the items container. */
  itemCount: number;
  /** MAX(items.updatedAt) when the workspace has items, else workspace.updatedAt. */
  lastActivity: string;
  /** Resolved owner set: creator + every Admin-role principal on the workspace. */
  owners: string[];
}

interface RawWorkspaceDoc {
  id: string;
  tenantId?: string;
  name?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  capacity?: string;
  domain?: string;
  storageAccountId?: string;
  state?: string;
}

/**
 * Result of {@link listAllWorkspacesAdmin}. `degraded` is TRUE when a
 * best-effort enrichment sub-query (item counts / last-activity or the
 * owner-role resolve) failed and its fields fell back to defaults (0 counts /
 * `[createdBy]` owners). It lets the UI distinguish "this workspace really has
 * 0 items" from "the count store was unreachable", instead of both looking
 * identical (rel-T108). `degradedReasons` names which enrichment(s) fell back.
 */
export interface AdminWorkspacesResult {
  workspaces: WorkspaceAdminRecord[];
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * Enumerate EVERY workspace in the tenant with live item counts, last-activity,
 * and resolved owners. Cross-partition Cosmos reads only.
 *
 * The primary workspace scan is authoritative — it THROWS on failure (the route
 * genericizes it via apiServerError). The two enrichment sub-queries are
 * best-effort: a failure degrades their fields to defaults AND is surfaced via
 * the returned `degraded` flag so a store blip can't silently read as "empty".
 */
export async function listAllWorkspacesAdmin(): Promise<AdminWorkspacesResult> {
  const wsC = await workspacesContainer();

  // 1) Every workspace, all partitions (no partitionKey option = cross-partition fan-out).
  const { resources: docs } = await wsC.items
    .query<RawWorkspaceDoc>({ query: 'SELECT * FROM c' })
    .fetchAll();

  if (docs.length === 0) return { workspaces: [], degraded: false, degradedReasons: [] };

  const ids = docs.map((w) => w.id);
  const inParams = ids.map((id, i) => ({ name: `@w${i}`, value: id }));
  const inExpr = inParams.map((p) => p.name).join(',');

  const degradedReasons: string[] = [];

  // 2) Batch item-count + last-activity for ALL workspaces in one cross-partition
  //    GROUP BY (same proven pattern as GET /api/workspaces?count=true). Degrades
  //    gracefully to zero counts if the aggregate fails (e.g. RU pressure) — and
  //    records the degradation so the caller can flag it.
  const counts = new Map<string, number>();
  const lastActivity = new Map<string, string>();
  try {
    const itC = await itemsContainer();
    const { resources: rows } = await itC.items
      .query<{ workspaceId: string; n: number; lastActivity?: string }>({
        query: `SELECT c.workspaceId, COUNT(1) AS n, MAX(c.updatedAt) AS lastActivity
                FROM c WHERE c.workspaceId IN (${inExpr}) GROUP BY c.workspaceId`,
        parameters: inParams,
      })
      .fetchAll();
    for (const r of rows) {
      if (!r?.workspaceId) continue;
      counts.set(r.workspaceId, r.n ?? 0);
      if (r.lastActivity) lastActivity.set(r.workspaceId, r.lastActivity);
    }
  } catch {
    // leave counts/lastActivity empty — records fall back to 0 / workspace.updatedAt
    degradedReasons.push('item-counts');
  }

  // 3) Resolve owners: creator + every Admin-role principal (F5 workspace-roles).
  //    Cross-partition read; failure degrades to owners = [createdBy].
  const adminsByWs = new Map<string, Set<string>>();
  try {
    const rolesC = await workspaceRolesContainer();
    const { resources: roleRows } = await rolesC.items
      .query<{ workspaceId: string; displayName?: string; role?: string }>({
        query: `SELECT c.workspaceId, c.displayName, c.role
                FROM c WHERE c.workspaceId IN (${inExpr}) AND c.role = @admin`,
        parameters: [...inParams, { name: '@admin', value: 'Admin' }],
      })
      .fetchAll();
    for (const r of roleRows) {
      if (!r?.workspaceId || !r.displayName) continue;
      let set = adminsByWs.get(r.workspaceId);
      if (!set) { set = new Set<string>(); adminsByWs.set(r.workspaceId, set); }
      set.add(r.displayName);
    }
  } catch {
    // leave adminsByWs empty — owners fall back to [createdBy]
    degradedReasons.push('owner-roles');
  }

  const workspaces = docs.map((w) => {
    const createdBy = w.createdBy || w.tenantId || 'unknown';
    const owners = new Set<string>();
    if (createdBy) owners.add(createdBy);
    for (const a of adminsByWs.get(w.id) ?? []) owners.add(a);
    return {
      id: w.id,
      tenantId: w.tenantId || createdBy,
      name: w.name || w.id,
      description: w.description,
      createdBy,
      createdAt: w.createdAt || w.updatedAt || '',
      updatedAt: w.updatedAt || w.createdAt || '',
      capacity: w.capacity,
      domain: w.domain,
      storageAccountId: w.storageAccountId,
      state: normalizeState(w.state),
      itemCount: counts.get(w.id) ?? 0,
      lastActivity: lastActivity.get(w.id) ?? w.updatedAt ?? w.createdAt ?? '',
      owners: Array.from(owners),
    };
  });

  return { workspaces, degraded: degradedReasons.length > 0, degradedReasons };
}

/**
 * Load ONE workspace by id across EVERY partition — the admin-scoped counterpart
 * to the owner point-read `container.item(id, ownerOid).read()`.
 *
 * Each workspace doc is partitioned by `/tenantId` where `tenantId === the
 * creating user's oid`, so an admin acting on a workspace they did not create
 * does not know its partition key. A single `SELECT * FROM c WHERE c.id = @id`
 * with NO `{ partitionKey }` option fans the read out across all partitions and
 * returns the one matching doc (ids are unique account-wide in this container).
 *
 * SECURITY: this bypasses partition isolation, so it must ONLY be called AFTER a
 * tenant-admin check — see `resolveAdminWorkspace` in lib/auth/workspace-guard.ts,
 * which is the single caller that gates it. The Console UAMI's account-scoped
 * "Cosmos DB Built-in Data Contributor" role already authorises the fan-out.
 *
 * Mirrors {@link listAllWorkspacesAdmin}'s query style + error handling. Returns
 * `null` when no workspace has that id.
 */
export async function loadWorkspaceAdmin(id: string): Promise<Workspace | null> {
  const wsC = await workspacesContainer();
  const { resources } = await wsC.items
    .query<Workspace>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}
