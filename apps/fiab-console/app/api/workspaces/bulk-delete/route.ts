/**
 * POST /api/workspaces/bulk-delete  — batch workspace delete.
 *
 * Cleaning up UAT/test estates routinely means deleting 100+ workspaces.
 * Doing that one-DELETE-at-a-time from the per-workspace route is tedious,
 * so this route accepts a batch of ids and deletes each one using the
 * EXACT same semantics as DELETE /api/workspaces/[id]:
 *   1. resolveWorkspaceAccessByOid(oid, id, …)  — the shared access ladder
 *   2. cascade-delete the workspace's items (+ remove their loom-search docs)
 *   3. delete the workspace doc            (+ remove its loom-search doc)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #3833 — THIS ROUTE USED TO DELETE ACROSS THE TENANT BOUNDARY.
 *
 * Until this change the loop read:
 *
 *     let ws = await loadWorkspace(id, tenantId);
 *     if (!ws && admin) ws = await loadWorkspaceAdmin(id);   // cross-partition
 *     if (!ws) { failed.push({ id, error: 'not_found' }); continue; }
 *     if (!admin && ws.createdBy && ws.createdBy !== session.claims.oid) { … }
 *     const receipts = await deleteOne(ws, cascade);
 *
 * Read it for `admin === true`. `loadWorkspaceAdmin` is a bare
 * `SELECT * FROM c WHERE c.id = @id` with NO tenant predicate, so it resolves a
 * workspace in ANY tenant; the ownership check underneath it is then skipped
 * WHOLESALE by the `!admin &&` short-circuit; and the doc goes straight into
 * `deleteOne(ws, cascade)`. A tenant admin holding a workspace GUID from another
 * tenant destroyed it — and, with `cascade`, tore down its Azure backends too.
 *
 * The sibling defects in this family (#3823, #3825, #3826) were reads or
 * authorize bypasses. This one DESTROYS, which is why it was taken first.
 *
 * The fix is NOT a tenant check bolted onto the private path — path
 * proliferation is how this family reached seven sites. The private path is
 * GONE. `resolveWorkspaceAccessByOid` is the single place tenancy is decided
 * (hardened in #3824), and this route now asks it exactly like
 * DELETE /api/workspaces/[id] does:
 *
 *   - the tenant-admin bypass fires only on a POSITIVE tenant match
 *     (`callerTid && wsDoc.tid && equal`) — #3824 step 6;
 *   - authorization is evaluated for admins TOO. There is no `!admin &&`
 *     short-circuit any more: every caller passes the same `via`/`role` test;
 *   - a foreign-tenant id and a nonexistent id are INDISTINGUISHABLE — both
 *     report the identical per-id `not_found`, so an id cannot be probed for
 *     existence across tenants (the 404-not-403 precedent, route-toolkit.ts);
 *   - a workspace doc that records no `tid` at all is REFUSED, and reported as
 *     its own per-id `tenant_unconfirmed` (never folded into `forbidden`), with
 *     the resolver's own reason + backfill remediation attached so the UI can
 *     say something TRUE about why. This is the per-id analogue of the 409
 *     `tenant_unconfirmed` #3824 gave the single-workspace route.
 *
 * Admin cleanup of UAT/test debris — the reason this endpoint exists — is
 * UNCHANGED for workspaces in the admin's own confirmed tenant: a tenant admin
 * still deletes workspaces they did not personally create (resolver step 6,
 * `via:'admin'`). A non-admin still deletes only what they own or hold an Admin
 * role on. What no longer works is deleting outside your tenant.
 *
 * BLAST RADIUS, STATED HONESTLY: workspaces created before rel-T11 carry no
 * `tid` and are now refused for the ADMIN path (owner + explicit-ACL deletes are
 * untouched — they never depended on the tenant bypass). The remedy is
 * `node scripts/csa-loom/backfill-workspace-tid.mjs` (dry-run by default,
 * `--apply` to write). The number of such docs on the live estate is UNMEASURED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Contract:
 *   Request : { ids: string[], cascade?: boolean }
 *   Response: { ok: boolean, deleted: string[],
 *               failed: { id, error, reason?, remediation? }[] }
 *   - ok   : true when at least one id deleted AND no failures, else false.
 *   - per-id `error`: 'not_found' | 'forbidden' | 'tenant_unconfirmed' | <message>
 *   - 401  : no session.  400 : bad body.
 *
 * GET /api/workspaces/bulk-delete  — admin probe for the UI.
 *   Response: { ok: true, isAdmin: boolean }   (401 when unauthenticated)
 *   The workspaces page uses this to decide whether to render the
 *   multi-select + bulk-delete affordances at all.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { deleteLoomDoc } from '@/lib/azure/loom-search';
import { cleanupWorkspaceMetadata, type CleanupItem } from '@/lib/azure/lineage-gc';
import { teardownWorkspaceBackends, type TeardownItem, type TeardownOutcome } from '@/lib/azure/resource-teardown';
import {
  resolveWorkspaceAccessByOid,
  type WorkspaceAccessDiagnostics,
} from '@/lib/auth/workspace-access';
import type { Workspace } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';
import { safeRecord } from '@/lib/security/safe-object';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BATCH = 500;

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * One per-id outcome. `error` is a stable code the UI branches on; `reason` and
 * `remediation` are populated ONLY for a refusal the operator can act on
 * (`tenant_unconfirmed`), carrying the resolver's own honest text so this route
 * never re-derives — and so never drifts from — the explanation.
 */
interface BulkDeleteFailure {
  id: string;
  error: string;
  reason?: string;
  remediation?: string;
}

/** Same cascade delete as DELETE /api/workspaces/[id]: items first, then the
 * workspace. When `cascade` is set, ALSO tear down each item's underlying Azure
 * backend (best-effort, serial) BEFORE the item docs are deleted, returning the
 * per-item teardown receipts so the caller can surface them. */
async function deleteOne(ws: Workspace, cascade: boolean): Promise<TeardownOutcome[] | undefined> {
  const items = await itemsContainer();
  const { resources: children } = await items.items
    .query<CleanupItem & { displayName?: string }>(
      {
        // Select the fields lineage GC + backend teardown need (itemType +
        // displayName + full state) alongside id/workspaceId.
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: ws.id }],
      },
      { partitionKey: ws.id },
    )
    .fetchAll();

  let teardown: TeardownOutcome[] | undefined;
  if (cascade) {
    teardown = await teardownWorkspaceBackends(children as TeardownItem[], ws.tenantId);
  }

  for (const child of children) {
    await items.item(child.id, ws.id).delete().catch(() => {});
    void deleteLoomDoc(`it:${child.id}`);
  }
  // GC the metadata plane for every item purged in this bulk delete (LIN-GC-1):
  // soft-delete each Purview Atlas entity + hard-remove its Weave/Thread lineage
  // edges. This is the exact path the 07-08 UAT purge took that left 160
  // workspaces' worth of lineage debris. Best-effort, never blocks the delete.
  void cleanupWorkspaceMetadata(children, ws.tenantId);
  const wsContainer = await workspacesContainer();
  await wsContainer.item(ws.id, ws.tenantId).delete();
  void deleteLoomDoc(`ws:${ws.id}`);
  return teardown;
}

export async function GET() {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  // Tenant admins can bulk-delete anything; every authenticated user can
  // bulk-delete the workspaces they OWN (their own Cosmos partition). The page
  // uses `canBulkDelete` to decide whether to show the multi-select affordances.
  return NextResponse.json({ ok: true, isAdmin: isTenantAdmin(session), canBulkDelete: true });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  // Authorization is PER-WORKSPACE (below), not a blanket tenant-admin gate.
  // This flag is only ever an INPUT to the shared resolver — it is never a
  // reason to skip a check here (#3833). The resolver decides whether it earns
  // anything, and it earns nothing unless the workspace's tenant is confirmed
  // to be the caller's.
  const admin = isTenantAdmin(session);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  const rawIds = body?.ids;
  if (!Array.isArray(rawIds)) return err('Body must be { ids: string[] }', 400, 'bad_request');
  // Opt-in cascade: also DELETE each item's underlying Azure backend. Default
  // (absent / false) is catalog-only — Azure resources are retained.
  const cascade = body?.cascade === true;

  // De-dupe + validate ids; drop empties.
  const ids = Array.from(
    new Set(rawIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())),
  );
  if (ids.length === 0) return err('No workspace ids provided', 400, 'bad_request');
  if (ids.length > MAX_BATCH) {
    return err(`Too many ids (${ids.length}); max ${MAX_BATCH} per request`, 400, 'too_many');
  }

  const claims = session.claims as { oid: string; tid?: string; groups?: string[] };
  const oid = claims.oid;
  const deleted: string[] = [];
  const failed: BulkDeleteFailure[] = [];
  // Per-workspace teardown receipts (only populated when cascade is set).
  // Workspace ids are request-derived (CodeQL #627).
  const teardown = safeRecord<TeardownOutcome[]>();

  for (const id of ids) {
    try {
      // ONE access decision, taken by the shared resolver — owner fast-path →
      // workspace-roles ACL → tid boundary → tenant-admin bypass. There is no
      // second path here on purpose: this route previously resolved admin ids
      // itself, and that private path is what went wrong (see the header).
      const diag: WorkspaceAccessDiagnostics = {};
      const access = await resolveWorkspaceAccessByOid(
        oid,
        id,
        { callerTid: claims.tid, groups: claims.groups, tenantAdmin: admin },
        diag,
      );
      if (!access) {
        // NEGATIVE SPACE. A workspace in someone else's tenant and a workspace
        // that does not exist BOTH land here with no denial recorded, and both
        // emit the identical `not_found` — an id must not be probeable for
        // existence across the tenant boundary (route-toolkit.ts, 404-not-403).
        // The one case that IS distinguishable is a refusal the operator can
        // fix, and it is only ever reachable by a tenant admin.
        const d = diag.denial;
        if (d) failed.push({ id, error: d.code, reason: d.reason, remediation: d.remediation });
        else failed.push({ id, error: 'not_found' });
        continue;
      }
      // Destroying a whole workspace stays OWNER/Admin-scoped — identical to
      // DELETE /api/workspaces/[id]. A write-capable Member may create items but
      // must not be able to demolish the workspace they were shared into.
      if (access.via !== 'owner' && access.role !== 'Admin') {
        failed.push({ id, error: 'forbidden' });
        continue;
      }
      const ws: Workspace = access.workspace;
      const receipts = await deleteOne(ws, cascade);
      if (receipts) teardown[id] = receipts;
      deleted.push(id);
    } catch (e: any) {
      failed.push({ id, error: e?.message || 'delete_failed' });
    }
  }

  return NextResponse.json({
    ok: failed.length === 0 && deleted.length > 0,
    deleted,
    failed,
    ...(cascade ? { teardown } : {}),
  });
}
