/**
 * Loom-native dashboard render BFF.
 *
 * GET  /api/admin/org-visuals/dashboards/render?id=<dashboardId>[&mode=live]
 *                                                  → saved dashboard render model
 * POST /api/admin/org-visuals/dashboards/render  { spec, mode?, params? }
 *                                                  → inline render (builder LIVE preview)
 *
 * Synthesizes the SAME { model, sample } shape the CoE <ReportCanvas> renders
 * from a {@link DashboardSpec} (see builder/dashboard-model), then — in live
 * mode — resolves each tile's Azure-native data source against the deployment's
 * OWN estate (Cost Management / Azure Resource Graph / Defender / Log Analytics
 * via report-render/live-bindings) and returns per-tile `live` data + provenance
 * so the viewer labels every tile truthfully (live / sample / honest gate).
 *
 * Azure-native: no Microsoft Fabric / Power BI service is contacted. Session-gated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { getDashboard } from '@/lib/coe-library/builder/dashboard-store';
import {
  synthReportModel, synthSampleData, type DashboardSpec, type TileVisual,
} from '@/lib/coe-library/builder/dashboard-model';
import {
  resolveBuilderSources, getBuilderSource, resolveReportParams,
  type EntityBindingResult, type ReportParamOverrides,
} from '@/lib/coe-library/report-render/live-bindings';
import type { SampleData, SampleTable } from '@/lib/coe-library/report-render/tmdl-sample';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



const VALID_VISUALS = new Set<TileVisual>(['kpi', 'bar', 'line', 'donut', 'table']);

/** Normalize an untrusted inline spec into a DashboardSpec (lenient — preview path). */
function coerceSpec(raw: any): DashboardSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const tilesIn = Array.isArray(raw.tiles) ? raw.tiles : [];
  const tiles = tilesIn
    .map((t: any) => ({
      id: String(t?.id || `tile-${Math.random().toString(36).slice(2, 9)}`),
      title: String(t?.title || 'Tile'),
      visual: (VALID_VISUALS.has(t?.visual) ? t.visual : 'kpi') as TileVisual,
      sourceId: String(t?.sourceId || ''),
      category: t?.category ? String(t.category) : undefined,
      value: String(t?.value || ''),
    }))
    .filter((t: any) => getBuilderSource(t.sourceId)); // drop tiles with no real source
  return {
    schemaVersion: 1,
    name: String(raw.name || 'Dashboard'),
    description: raw.description ? String(raw.description) : undefined,
    category: String(raw.category || 'FinOps'),
    accent: raw.accent || 'brand',
    tiles,
  };
}

/**
 * Build the (optionally live) render payload for a spec. A "sample" fallback for
 * a tile is a tiny illustrative table so the chart shape is visible before the
 * source is connected — never fabricated as real, always tagged sample/error.
 */
async function buildPayload(spec: DashboardSpec, live: boolean, overrides: ReportParamOverrides): Promise<NextResponse> {
  const model = synthReportModel(spec);

  // The entity set = one entity per tile (keyed by tile id). Sample data is a
  // small placeholder per source so the un-connected dashboard still renders.
  const sampleBySource: Record<string, SampleTable> = {};
  for (const tile of spec.tiles) {
    const src = getBuilderSource(tile.sourceId);
    if (src) sampleBySource[tile.sourceId] = placeholderTable(src.columns, tile);
  }
  const sample = synthSampleData(spec, sampleBySource);

  if (!live) {
    return NextResponse.json({ ok: true, model, sample, params: resolveReportParams(overrides) });
  }

  // Live: resolve each distinct source once, then map per-tile (by entity id).
  try {
    const sourceIds = spec.tiles.map((t) => t.sourceId);
    const resolved = await resolveBuilderSources(sourceIds, overrides);
    const liveData: SampleData = {};
    const dataSources: Record<string, EntityBindingResult> = {};
    for (const tile of spec.tiles) {
      const r = resolved[tile.sourceId] || { source: 'error' as const, note: 'Data source did not resolve.' };
      dataSources[tile.id] = r;
      liveData[tile.id] = r.source === 'live' && r.table ? r.table : sample[tile.id];
    }
    return NextResponse.json({ ok: true, model, sample, live: liveData, dataSources, params: resolveReportParams(overrides), mode: 'live' });
  } catch (e: any) {
    return NextResponse.json({ ok: true, model, sample, params: resolveReportParams(overrides), mode: 'live', liveError: e?.message || String(e) });
  }
}

/** A 3-row illustrative placeholder so an un-connected tile still draws a shape. */
function placeholderTable(columns: string[], tile: { category?: string; value: string }): SampleTable {
  const cat = tile.category && columns.includes(tile.category) ? tile.category : columns[0];
  const val = columns.includes(tile.value) ? tile.value : (columns.find((c) => /count|cost|score|users|budget|percentage|amount/i.test(c)) || columns[columns.length - 1]);
  const rows = [1, 2, 3].map((n) => {
    const r: Record<string, unknown> = {};
    for (const c of columns) r[c] = c === val ? n * 100 : `Sample ${n}`;
    if (cat) r[cat] = `Sample ${n}`;
    return r;
  });
  return { columns, rows };
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get('id')?.trim();
  if (!id) return apiError('id is required', 400);
  const live = url.searchParams.get('mode') === 'live';
  const overrides: ReportParamOverrides = {
    subscriptionId: url.searchParams.get('subscriptionId')?.trim() || undefined,
    billingScope: url.searchParams.get('billingScope')?.trim() || undefined,
    tenantId: url.searchParams.get('tenantId')?.trim() || undefined,
    managementApiBase: url.searchParams.get('managementApiBase')?.trim() || undefined,
  };
  try {
    const dash = await getDashboard(s.claims.oid, id);
    if (!dash) return apiError(`unknown dashboard: ${id}`, 404);
    return buildPayload(dash.spec, live, overrides);
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const spec = coerceSpec(body?.spec);
  if (!spec) return apiError('spec is required', 400);
  const live = body?.mode === 'live';
  const p = body?.params || {};
  const overrides: ReportParamOverrides = {
    subscriptionId: typeof p.subscriptionId === 'string' ? p.subscriptionId.trim() : undefined,
    billingScope: typeof p.billingScope === 'string' ? p.billingScope.trim() : undefined,
    tenantId: typeof p.tenantId === 'string' ? p.tenantId.trim() : undefined,
    managementApiBase: typeof p.managementApiBase === 'string' ? p.managementApiBase.trim() : undefined,
  };
  return buildPayload(spec, live, overrides);
}
