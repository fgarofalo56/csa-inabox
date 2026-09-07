/**
 * POST /api/items/[type]/[id]/export-check
 *
 * F19 pre-flight: given a Loom workspace item and a target export `format`,
 * decide whether the export is permitted under the item's sensitivity label.
 *
 * Protected labels (Graph beta `hasProtection`) block CSV / TXT exports — those
 * formats cannot carry AIP/RMS metadata, so the protection context would be
 * stripped on download. When the caller's per-user usage rights are available
 * (Commercial / GCC) and they lack the EXPORT right, the export is hard-blocked
 * for any format. Unprotected labels never block.
 *
 * Body:    { format: string }   e.g. 'csv' | 'txt' | 'xlsx' | 'pdf'
 * Returns: { ok: true, blocked: boolean, reason?: string, warning?: string }
 *
 * Honest gates (per no-vaporware.md):
 *   - no sensitivity label on the item        → { blocked: false }
 *   - LOOM_MIP_ENABLED !== 'true'             → { blocked: false, warning } (can't verify)
 *   - rights filter unavailable (GCC-High/IL5) → CSV/TXT still blocked by FORMAT
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { getSensitivityLabel, getSensitivityLabelWithRights } from '@/lib/azure/mip-graph-client';
import { checkExportProtection } from '@/lib/azure/label-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #3941 review - A ROUTE CEILING ABOVE THE GROUP WALK.
 *
 * This route's authorization moved from an owner-only point read to
 * `authorizeItemWorkspace`. The owner fast path short-circuits, so a caller who
 * created the workspace pays nothing new - but the population this migration
 * newly ADMITS (non-owner ACL members and tenant admins) is exactly the one
 * that falls through to `resolveEffectiveRole`, which walks group assignments
 * SEQUENTIALLY with no walk-wide ceiling (#3834). 71 other console routes
 * declare a bound; not one of these ten did, so the widening landed on the
 * routes with no ceiling at all.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (deploy-integrity.md R7): it bounds the
 * REQUEST. It does NOT bound the walk - #3834 is still open, and a slow walk
 * still consumes the whole budget before the request is cut off. This turns an
 * unbounded hang into a bounded failure; it is not a fix for #3834.
 */
export const maxDuration = 60;



/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so the admitted set strictly
 * GROWS: tenant admins and shared-ACL members with the right role now pass.
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  // #3941 review - NAMED, not a bare positional boolean. This argument
  // selects the AUTHORIZATION scope: `true` admits read-only workspace
  // roles, `false` restricts to the write-capable ones. As a positional
  // `boolean` a transposed argument would silently widen a mutation with no
  // compiler complaint, and every call site read `..., session, { allowReadRoles: false })` with
  // nothing on screen saying which way `false` pointed.
  { allowReadRoles }: { allowReadRoles: boolean },
): Promise<{ item: WorkspaceItem | null; denied: NextResponse | null }> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: type }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return { item: null, denied: null };
  // #3941 - the canonical ladder, replacing the owner-only partition point read
  // this helper used to do. `workspaces` is partitioned on `/tenantId`, which
  // holds the workspace CREATOR's oid, so `ws.item(workspaceId, callerOid)`
  // could only answer "did YOU create this workspace?" - it refused tenant
  // admins and shared-ACL members on every item type with no dedicated route
  // (the #2941/#2942 defect). `authorizeItemWorkspace` answers "may you ACCESS
  // it?", scoped: read roles for GET, write-capable only for the mutations.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId,
    itemType: type,
    allowReadRoles,
    notFound: 'Item not found',
  });
  // An ORDINARY refusal (404) collapses to `null` so the route keeps its own
  // not-found wording, which is what its clients already render. The 409
  // `tenant_unconfirmed` refusal does NOT: flattening it into "item not found"
  // would state that the item does not exist, which the code did not establish
  // - the workspace document WAS read and the admin rights ARE real
  // (deploy-integrity.md R7). It is handed back for the route to return.
  if (denied) return { item: null, denied: denied.status === 404 ? null : denied };
  return { item, denied: null };
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return apiError('Unauthorized', 401);

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400); }
  const format = typeof body?.format === 'string' ? body.format : '';
  if (!format) return apiError('format is required', 400);

  try {
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: false });
    if (denied) return denied;
    if (!item) return apiError('Item not found', 404);

    const state = (item.state || {}) as Record<string, unknown>;
    const labelId = typeof state.sensitivityLabelId === 'string' ? state.sensitivityLabelId : '';
    if (!labelId) return NextResponse.json({ ok: true, blocked: false });

    if (process.env.LOOM_MIP_ENABLED !== 'true') {
      return NextResponse.json({
        ok: true,
        blocked: false,
        warning:
          'LOOM_MIP_ENABLED is not set on this deployment; export protection for sensitivity labels cannot be verified. ' +
          'Set LOOM_MIP_ENABLED=true on the loom-console Container App to enforce protected-label export rules.',
      });
    }

    const label = await getSensitivityLabel(labelId);
    if (!label) return NextResponse.json({ ok: true, blocked: false });

    // Best-effort per-user rights — null is fine (graceful Gov-cloud degrade).
    const callerUpn = session.claims.upn || session.claims.email || '';
    const rights = callerUpn ? await getSensitivityLabelWithRights(labelId, callerUpn) : null;

    const result = checkExportProtection(label, format, rights);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    // MIP upstream/config errors must not silently allow export — surface them.
    return apiServerError(e, 'Failed to evaluate export protection');
  }
}
