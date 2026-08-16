/**
 * POST /api/items/semantic-model/[id]/take-over?workspaceId=...
 *
 * Transfers dataset ownership to the Console UAMI via the REAL Power BI REST:
 *   POST /groups/{ws}/datasets/{id}/Default.TakeOver   (groupId-scoped)
 *
 * Required before the UAMI can edit the refresh schedule / bind credentials
 * when another user or SP currently owns the dataset (PBI returns a 401/403
 * "not the dataset owner" on PATCH refreshSchedule otherwise). No mocks; PBI
 * errors surface verbatim.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/take-over-in-group
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler TRANSFERRED DATASET
 * OWNERSHIP to the Console UAMI for a caller-named dataset with no item-level
 * check: any signed-in caller could take over any dataset the UAMI can reach,
 * and taking over is precisely what unblocks editing the refresh schedule and
 * rebinding credentials afterwards. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope";
 * eight sibling routes under `semantic-model/[id]/**` resolve the SAME `[id]` as
 * an owned Loom item.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in path and `loadOwnedItem` renders
 * "no item" as 404. The `?workspaceId=` is a Power BI group id, not a Loom
 * Cosmos workspace, so the scope is resolved from the item.
 *
 * NO `allowReadRoles`: this is a control-plane MUTATION on the dataset, so a
 * read-only Viewer must not pass.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { takeOverDataset, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const modelId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: modelId,
    itemType: 'semantic-model',
    notFound: 'semantic model not found',
  });
  if (denied) return denied;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await takeOverDataset(workspaceId, modelId);
    return NextResponse.json({ ok: true, tookOverAt: new Date().toISOString() });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
