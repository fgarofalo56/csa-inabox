/**
 * POST /api/items/semantic-model/[id]/embed-token
 *
 * Body: { workspaceId: string }
 * Returns: { ok, token, tokenId, expiration }
 *
 * Semantic models (datasets in Power BI REST) GenerateToken returns a
 * Q&A-capable embed token. The semantic-model editor uses this to wire
 * the Q&A pane + the relationship-view preview.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler MINTED A POWER BI EMBED
 * TOKEN over a caller-named dataset with no item-level check. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope"; eight sibling routes under `semantic-model/[id]/**`
 * (content, datasource, describe-bulk, ingest, model, roles, verified-queries,
 * and the type root) resolve the SAME `[id]` as an owned Loom item, so that
 * premise was provably false for this item type.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in Power BI path, and `loadOwnedItem`
 * renders "no item" as 404 — which would have broken Q&A embedding for every
 * caller on that path. `semantic-model/[id]/datasource` + `/ingest` + `/model`
 * already made this call for this exact item type.
 *
 * The body `workspaceId` is a POWER BI group id, not a Loom Cosmos workspace, so
 * it is not the authorization scope. `allowReadRoles` — the token is 'View'.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { generateDatasetEmbedToken, getDataset, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const modelId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: modelId,
    itemType: 'semantic-model',
    allowReadRoles: true,
    notFound: 'semantic model not found',
  });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [tokenResp, dataset] = await Promise.all([
      generateDatasetEmbedToken(workspaceId, modelId, 'View'),
      getDataset(workspaceId, modelId),
    ]);
    return NextResponse.json({
      ok: true,
      ...tokenResp,
      datasetId: dataset.id,
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
