/**
 * POST /api/items/dataflow/[id]/refresh?workspaceId=...
 *   Refresh (run) a Dataflow Gen2.
 *
 * Azure-native, no Fabric: compiles the saved Power Query (M) into an ADF
 * WranglingDataFlow and runs it on ADF Spark via an ExecuteWranglingDataflow
 * activity, writing the output query to the configured ADLS / Azure SQL
 * destination. Returns the ADF runId. Per no-fabric-dependency.md this is the
 * only backend — no Fabric capacity or workspace is required.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler RAN A DATAFLOW for a
 * caller-supplied `(id, workspaceId)` pair with no item-level check: any
 * signed-in caller could execute another tenant's dataflow, which reads that
 * tenant's sources and WRITES to that tenant's configured sink. It was excused
 * by check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope", which its own sibling `dataflow/[id]` disproves — that
 * route authorizes the SAME `(id, workspaceId)` through `authorizeItemWorkspace`
 * on both GET and PUT.
 *
 * The guard MATCHES THAT SIBLING exactly, including passing the caller's
 * `workspaceId` through: unlike the Power BI family in this same advisory, a
 * `dataflow` `workspaceId` IS a Loom Cosmos partition key (`dataflow/[id]`
 * point-reads `items.item(id, workspaceId)` with it), so it is the right scope
 * to authorize, and `authorizeItemWorkspace` falls back to resolving the
 * workspace FROM THE ITEM if it is ever absent.
 *
 * NO `allowReadRoles`: running a dataflow is a mutation, so a read-only Viewer
 * must not pass (item-crud.ts:289 — read roles are an explicit opt-in reserved
 * for read-only surfaces).
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { runDataflowAdf } from '@/lib/azure/dataflow-run';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = params;

  const denied = await authorizeItemWorkspace(session, {
    workspaceId,
    itemId: id,
    itemType: 'dataflow',
    notFound: 'dataflow not found',
  });
  if (denied) return denied;

  try {
    const result = await runDataflowAdf(id, workspaceId);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) },
        { status: result.status },
      );
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
