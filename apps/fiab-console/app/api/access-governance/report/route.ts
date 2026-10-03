/**
 * GET /api/access-governance/report — the unified "who has access" report
 * (access-governance Wave-1). Tenant-admin only.
 *
 * Modes (query params):
 *   ?principalId=<oid>            → everything that principal can reach (per-user)
 *   ?resourceRef=<ref>[&resourceType=<t>] → every principal with access (per-resource)
 *   (neither)                     → tenant-wide list of all effective grants
 *   &format=csv                   → CSV download of the result set
 *
 * Sources merged: the entitlement ledger (`access-assignments`) + the live
 * workspace ACL container (`workspace-roles`, the authoritative source today) +
 * — in the per-resource view — Entra GROUP expansion via Graph transitive
 * members, "where available" (honest no-op when Graph isn't configured). The
 * merge de-dups the same effective grant that appears in both the ledger and the
 * live ACL container. Real backends only (no mock rows) — an empty report is an
 * honest "nothing granted yet / run backfill", not a stub.
 *
 * `grantRecords` lists the access-request grants that are not settled — the
 * grant-ledger rows (lib/access/grant-intents.ts) still `pending` (a grant in
 * progress, or interrupted before its outcome was written), `failed`, or
 * `absent` (not in place when checked) — with their state and when they were
 * written, for the admin's own tenant and the same principal / resource filter.
 * A pending row may be a live grant; the scheduled access sweep resolves it.
 * When those rows cannot be read the report still answers, with
 * `grantRecordsError` saying so.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { accessAssignmentsContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers } from '@/lib/azure/graph-identity-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';
import {
  assignmentToEntry, workspaceRoleToEntry, mergeEntries,
  buildPrincipalReport, buildResourceReport, entriesToCsv, type AccessEntry,
} from '@/lib/access/access-report';
import { listUnsettledGrantIntents } from '@/lib/access/grant-intents';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tenant-wide cap so an admin scan is bounded. */
const MAX_ROWS = 1000;

/**
 * Expand any Group-type entry into its transitive members (per-resource view).
 * Honest "where available": if Graph is not configured, getGroupTransitiveMembers
 * throws and we keep the group entry as-is (unexpanded). Returns the possibly-
 * expanded list plus whether expansion actually ran.
 */
type GroupExpansion = 'applied' | 'unavailable' | 'n/a';
async function expandGroups(entries: AccessEntry[]): Promise<{ entries: AccessEntry[]; status: GroupExpansion }> {
  const groups = entries.filter((e) => e.principalType === 'Group');
  if (groups.length === 0) return { entries, status: 'n/a' };
  const out: AccessEntry[] = [...entries];
  let anyExpanded = false;
  for (const g of groups) {
    try {
      const members = await getGroupTransitiveMembers(g.principalId, 200);
      anyExpanded = true;
      for (const m of members) {
        out.push({
          ...g,
          principalId: m.id,
          principalUpn: m.upn || m.mail || m.displayName,
          principalType: m.type === 'group' ? 'Group' : m.type === 'spn' ? 'ServicePrincipal' : 'User',
          viaGroupId: g.principalId,
          viaGroupName: g.principalUpn || g.resourceName || g.principalId,
        });
      }
    } catch {
      // Graph unavailable — leave the group entry unexpanded (honest no-op).
    }
  }
  return { entries: out, status: anyExpanded ? 'applied' : 'unavailable' };
}

/** Route-toolkit: withTenantAdmin (session 401, tenant-admin 403). */
export const GET = withTenantAdmin(async (req: NextRequest, { session: s }) => {
  const principalId = (req.nextUrl.searchParams.get('principalId') || '').trim();
  const resourceRef = (req.nextUrl.searchParams.get('resourceRef') || '').trim();
  const resourceType = (req.nextUrl.searchParams.get('resourceType') || '').trim();
  const format = (req.nextUrl.searchParams.get('format') || '').trim().toLowerCase();

  try {
    const ledger = await accessAssignmentsContainer();
    const wsRoles = await workspaceRolesContainer();
    let entries: AccessEntry[] = [];
    let groupExpansion: 'applied' | 'unavailable' | 'n/a' = 'n/a';

    if (principalId) {
      // Per-principal — single-partition ledger read + workspace roles by principal.
      const [{ resources: la }, { resources: wr }] = await Promise.all([
        ledger.items.query<AccessAssignment>({
          query: 'SELECT * FROM c WHERE c.principalId = @p',
          parameters: [{ name: '@p', value: principalId }],
        }).fetchAll(),
        wsRoles.items.query<WorkspaceRoleAssignment>({
          query: 'SELECT * FROM c WHERE c.principalId = @p',
          parameters: [{ name: '@p', value: principalId }],
        }).fetchAll(),
      ]);
      entries = [...(la || []).map(assignmentToEntry), ...(wr || []).map(workspaceRoleToEntry)];
      entries = buildPrincipalReport(entries, principalId);
    } else if (resourceRef) {
      // Per-resource — ledger by resourceRef (cross-partition) + workspace roles
      // by workspaceId, then Entra group expansion where available.
      const [{ resources: la }, { resources: wr }] = await Promise.all([
        ledger.items.query<AccessAssignment>({
          query: 'SELECT * FROM c WHERE c.resourceRef = @r',
          parameters: [{ name: '@r', value: resourceRef }],
        }).fetchAll(),
        (!resourceType || resourceType === 'workspace')
          ? wsRoles.items.query<WorkspaceRoleAssignment>({
              query: 'SELECT * FROM c WHERE c.workspaceId = @r',
              parameters: [{ name: '@r', value: resourceRef }],
            }).fetchAll()
          : Promise.resolve({ resources: [] as WorkspaceRoleAssignment[] }),
      ]);
      const raw = [...(la || []).map(assignmentToEntry), ...(wr || []).map(workspaceRoleToEntry)];
      const exp = await expandGroups(raw);
      groupExpansion = exp.status;
      entries = buildResourceReport(exp.entries, resourceRef, resourceType || undefined);
    } else {
      // Tenant-wide — all effective grants (bounded).
      const [{ resources: la }, { resources: wr }] = await Promise.all([
        ledger.items.query<AccessAssignment>({ query: `SELECT TOP ${MAX_ROWS} * FROM c` }).fetchAll(),
        wsRoles.items.query<WorkspaceRoleAssignment>({ query: `SELECT TOP ${MAX_ROWS} * FROM c` }).fetchAll(),
      ]);
      entries = mergeEntries([...(la || []).map(assignmentToEntry), ...(wr || []).map(workspaceRoleToEntry)]);
    }

    if (format === 'csv') {
      return new NextResponse(entriesToCsv(entries), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="access-report.csv"',
        },
      });
    }

    let grantRecords: Array<Record<string, unknown>> = [];
    let grantRecordsError: string | undefined;
    try {
      const rows = await listUnsettledGrantIntents(tenantScopeId(s), {
        ...(principalId ? { principalId } : {}),
        ...(resourceRef ? { scopeRef: resourceRef } : {}),
      });
      grantRecords = rows.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        principalId: r.principalId,
        principalName: r.principalName,
        scopeType: r.scopeType,
        scopeRef: r.scopeRef,
        assetName: r.assetName,
        permission: r.permission,
        state: r.state,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ...(r.detail ? { detail: r.detail } : {}),
      }));
    } catch {
      grantRecordsError = 'The access-request grant records could not be read, so grants not yet settled are not listed.';
    }

    return NextResponse.json({
      ok: true,
      mode: principalId ? 'principal' : resourceRef ? 'resource' : 'tenant',
      count: entries.length,
      groupExpansion,
      entries,
      grantRecords,
      ...(grantRecordsError ? { grantRecordsError } : {}),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
});
