/**
 * GET /api/items/semantic-model/[id]/refreshes
 *   - Power BI backend (?workspaceId=...&top=25): PBI refresh history.
 *   - AAS backend (?dbName=... , defaults to [id]): the AAS async-refresh
 *     history (last 30 days, newest first) from the data-plane REST API.
 *
 * POST /api/items/semantic-model/[id]/refreshes?workspaceId=...
 *   Power BI Enhanced (asynchronous) refresh — supports commitMode,
 *   applyRefreshPolicy, effectiveDate and partition-level objects. Returns
 *   202 + { ok, requestId }.
 *   Docs: https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 *
 * Backend selection: see _lib/bi-backend.ts. Per no-fabric-dependency.md the
 * Azure-native AAS path is the default; Power BI is opt-in.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — neither handler authorized the caller
 * against the model. GET returned a caller-named model's refresh history (Power
 * BI, or the AAS database `dbName`, which defaults to `[id]`); POST queued a
 * Power BI ENHANCED refresh, including partition-level `objects` and
 * `applyRefreshPolicy`. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope"; eight
 * sibling routes under `semantic-model/[id]/**` resolve the SAME `[id]` as an
 * owned Loom item.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in path and `loadOwnedItem` renders
 * "no item" as 404. The `?workspaceId=` is a Power BI group id, so the scope is
 * resolved FROM THE ITEM. GET admits read roles; POST does not.
 */

import { NextRequest, NextResponse } from 'next/server';
import { type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  listRefreshHistory,
  enhancedRefreshDataset,
  PowerBiError,
  type EnhancedRefreshBody,
} from '@/lib/azure/powerbi-client';
import { getRefreshes as aasGetRefreshes, aasServerConfigGate, AasError } from '@/lib/azure/aas-server-client';
import { usingAasAsync } from '../../_lib/bi-backend';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Canonical owner → tenant-admin → shared-ACL ladder for this model, with the
 *  workspace resolved FROM THE ITEM so authorization cannot be skipped (or
 *  misdirected) by the caller's Power BI `?workspaceId=`. */
async function denyUnlessAuthorized(session: SessionPayload, id: string, opts?: { allowReadRoles?: boolean }) {
  return authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: id,
    itemType: 'semantic-model',
    notFound: 'semantic model not found',
    ...(opts?.allowReadRoles ? { allowReadRoles: true } : {}),
  });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  // READ surface → any workspace role may view refresh history.
  const denied = await denyUnlessAuthorized(session, id, { allowReadRoles: true });
  if (denied) return denied;

  if (!(await usingAasAsync())) {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
    const top = Math.min(100, parseInt(req.nextUrl.searchParams.get('top') || '25', 10) || 25);
    try {
      const refreshes = await listRefreshHistory(workspaceId, id, top);
      return NextResponse.json({ ok: true, refreshes });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  const gate = aasServerConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, error: `Azure Analysis Services not configured: ${gate.missing}`, gate }, { status: 503 });
  }
  const dbName = req.nextUrl.searchParams.get('dbName') || id;
  try {
    const refreshes = await aasGetRefreshes(dbName);
    try { console.info(`[aas/refreshes.GET] receipt: ${JSON.stringify({ ok: true, refreshes }).slice(0, 300)}`); } catch { /* noop */ }
    return NextResponse.json({ ok: true, refreshes });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  // WRITE surface → no `allowReadRoles`.
  const denied = await denyUnlessAuthorized(session, id);
  if (denied) return denied;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as EnhancedRefreshBody;
  // Power BI documents partialBatch + applyRefreshPolicy as an invalid pairing.
  if (body.commitMode === 'partialBatch' && body.applyRefreshPolicy === true) {
    return NextResponse.json(
      { ok: false, error: 'commitMode=partialBatch is incompatible with applyRefreshPolicy=true' },
      { status: 400 },
    );
  }
  try {
    const { requestId } = await enhancedRefreshDataset(workspaceId, id, body);
    return NextResponse.json({ ok: true, requestId, queuedAt: new Date().toISOString() }, { status: 202 });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
