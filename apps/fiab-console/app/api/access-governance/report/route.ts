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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers } from '@/lib/azure/graph-identity-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';
import {
  assignmentToEntry, workspaceRoleToEntry, mergeEntries,
  buildPrincipalReport, buildResourceReport, entriesToCsv, type AccessEntry,
} from '@/lib/access/access-report';
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

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

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

    return NextResponse.json({
      ok: true,
      mode: principalId ? 'principal' : resourceRef ? 'resource' : 'tenant',
      count: entries.length,
      groupExpansion,
      entries,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
