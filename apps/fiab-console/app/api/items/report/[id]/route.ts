/**
 * GET /api/items/report/[id]?workspaceId=...
 *
 * Loom-native default (LOOM_BI_BACKEND unset / not "powerbi"):
 *   Returns the report's AAS binding (aasServer, aasDatabase) + pages from
 *   state.content so the Loom-native renderer can query AAS directly without
 *   Power BI. No embed token, no Power BI workspace required.
 *   (no-fabric-dependency.md — Azure-native is the DEFAULT path.)
 *
 * Power BI opt-in (LOOM_BI_BACKEND=powerbi):
 *   Falls through to the real Power BI REST getReport() and returns the PBI
 *   report shape (embedUrl, datasetId, etc.) for the embed renderer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getReport, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
  reportDetailFromContent,
  reportPagesFromContent,
} from '../../_lib/pbi-content-fallback';
import { loadModelItem } from '@/lib/azure/model-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BI_BACKEND = (process.env.LOOM_BI_BACKEND || '').trim().toLowerCase();
const isPbiBackend = BI_BACKEND === 'powerbi';

/** Read the AAS binding from item state, falling back to platform env defaults. */
function aasBindingOf(item: WorkspaceItem): { aasServer: string | null; aasDatabase: string | null } {
  const state = (item.state || {}) as Record<string, unknown>;
  return {
    aasServer: typeof state.aasServer === 'string' && state.aasServer.trim()
      ? state.aasServer
      : (process.env.LOOM_AAS_SERVER || null),
    aasDatabase: typeof state.aasDatabase === 'string' && state.aasDatabase.trim()
      ? state.aasDatabase
      : (process.env.LOOM_AAS_DATABASE || null),
  };
}

/** Build the Loom-native report detail from a content-backed (loom:) item. */
async function loomNativeDetail(cosmosItemId: string, tenantId: string, workspaceId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'report', tenantId);
  if (!item) return null;
  const detail = reportDetailFromContent(item);
  if (!detail) return null;
  const pages = reportPagesFromContent(item) ?? [];
  return NextResponse.json({
    ok: true,
    workspaceId,
    ...detail,
    ...aasBindingOf(item),
    pages,
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '_loom';
  const id = (await ctx.params).id;

  // Bundle-installed / loom: synthetic ID → always serve Loom-native.
  if (isLoomContentId(id)) {
    const resp = await loomNativeDetail(cosmosIdFromLoomId(id), session.claims.oid, workspaceId);
    if (resp) return resp;
    return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  }

  // Power BI opt-in path.
  if (isPbiBackend) {
    if (!workspaceId || workspaceId === '_loom') {
      return NextResponse.json({ ok: false, error: 'workspaceId required for powerbi backend' }, { status: 400 });
    }
    try {
      const report = await getReport(workspaceId, id);
      return NextResponse.json({ ok: true, workspaceId, report });
    } catch (e: any) {
      if (e instanceof PowerBiError && e.status === 404) {
        const resp = await loomNativeDetail(id, session.claims.oid, workspaceId);
        if (resp) return resp;
      }
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // Loom-native default: load the report item from Cosmos by its plain id.
  const item = await loadModelItem(id, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found in this tenant' }, { status: 404 });
  }
  const pages = reportPagesFromContent(item) ?? [];
  // Surface the same wave-2/3 REPORT-LEVEL state the loom: path emits so the
  // designer's loadDetail round-trips report-scope filters, captured bookmarks,
  // the Filters-pane format, and the wave-3 `theme` on plain-Cosmos ids too
  // (without these `j.theme` / `j.reportFilters` / `j.bookmarks` /
  // `j.filterPaneFormat` read undefined and RESET on reload). Spread the detail
  // FIRST, then re-assert `report` with the PLAIN `item.id` (the loom: path uses
  // a `loom:`-prefixed id) so this stays additive — no behavior change for the
  // existing report identity or the PBI-backend path.
  const detail = reportDetailFromContent(item);
  return NextResponse.json({
    ok: true,
    workspaceId: item.workspaceId,
    ...(detail ?? {}),
    report: {
      id: item.id,
      name: item.displayName,
      reportType: 'PowerBIReport' as const,
    },
    ...aasBindingOf(item),
    pages,
  });
}
