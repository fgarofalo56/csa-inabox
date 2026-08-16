/**
 * POST /api/items/semantic-model/[id]/refresh
 *   - Power BI backend (?workspaceId=...): queues a PBI dataset refresh.
 *   - AAS backend (?dbName=... , defaults to [id]): POSTs the AAS async-refresh
 *     REST API and returns the REAL refresh id from the Location header.
 * GET  /api/items/semantic-model/[id]/refresh — refresh history (both backends).
 *
 * Backend selection: see _lib/bi-backend.ts. powerbi-client is used only when
 * LOOM_BI_BACKEND=powerbi (or the no-AAS legacy fallback); otherwise the
 * Azure-native AAS path is used (per no-fabric-dependency.md). When AAS is
 * selected but LOOM_AAS_SERVER_NAME is unset the route 503s with an honest gate.
 *
 * Receipt: the first 300 chars of each route body are logged server-side.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — neither handler authorized the caller
 * against the model. POST queued a refresh of a caller-named dataset (Power BI)
 * or AAS database (`dbName` defaults to `[id]`); GET returned that model's
 * refresh history. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope";
 * eight sibling routes under `semantic-model/[id]/**` resolve the SAME `[id]` as
 * an owned Loom item, so the premise was provably false for this item type.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in path, and `loadOwnedItem` renders
 * "no item" as 404 — which would have broken refresh for every caller there.
 * `semantic-model/[id]/datasource` + `/ingest` + `/model` already made this call.
 * The `?workspaceId=` is a Power BI group id, not a Loom Cosmos workspace, so
 * the scope is resolved FROM THE ITEM rather than from the caller's parameter.
 *
 * GET admits read roles (history is a read); POST does NOT — queueing a refresh
 * is a mutation, so a read-only Viewer must not pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { refreshDataset, listRefreshHistory, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  refresh as aasRefresh,
  getRefreshes as aasGetRefreshes,
  aasServerConfigGate,
  AasError,
  type AasRefreshRequest,
} from '@/lib/azure/aas-server-client';
import { usingAasAsync } from '../../_lib/bi-backend';
import { logSafe } from '@/lib/util/log-safe';

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

function receipt(label: string, body: unknown): void {
  try { console.info(`[${logSafe(label)}] receipt: ${JSON.stringify(body).slice(0, 300)}`); } catch { /* noop */ }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  // WRITE surface → no `allowReadRoles`.
  const denied = await denyUnlessAuthorized(session, id);
  if (denied) return denied;

  if (!(await usingAasAsync())) {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
    try {
      await refreshDataset(workspaceId, id);
      return NextResponse.json({ ok: true, queuedAt: new Date().toISOString() });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── AAS path ──────────────────────────────────────────────────────────
  const gate = aasServerConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`, gate },
      { status: 503 },
    );
  }
  const dbName = req.nextUrl.searchParams.get('dbName') || id;
  let body: AasRefreshRequest = {};
  try { body = (await req.json()) as AasRefreshRequest; } catch { /* empty body → automatic refresh */ }
  try {
    const result = await aasRefresh(dbName, body);
    const out = { ok: true as const, refreshId: result.refreshId, location: result.location, queuedAt: new Date().toISOString() };
    receipt('aas/refresh.POST', out);
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
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
    const out = { ok: true as const, refreshes };
    receipt('aas/refresh.GET', out);
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
