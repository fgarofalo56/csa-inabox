/**
 * Organization reports render BFF (consumer gallery).
 *
 * GET  /api/org-reports/render?id=<cloneId>            → LIVE render model
 * GET  ...&subscriptionId=&billingScope=&…             → LIVE render, scoped
 * POST ...?id=<cloneId>  body { params: {…} }          → LIVE render (overrides)
 *
 * The consumer gallery ALWAYS renders REAL, live data from the deployment's OWN
 * Azure estate (Cost Management, Log Analytics, Azure Resource Graph, Azure
 * Policy, Defender) via report-render/live-bindings — there is NO sample-data
 * path. Every entity resolves to real rows or a REAL EMPTY table (schema, zero
 * rows) with a per-entity `dataSources` note; bundled SAMPLE rows are never
 * emitted (no-vaporware.md). `mode` is accepted for back-compat but ignored —
 * the answer is always live.
 *
 * 404 if the report is not published (so unpublishing immediately removes
 * consumer access). Azure-native: no Microsoft Fabric / Power BI is contacted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPublishedReport, getTemplate, getTemplateFiles } from '@/lib/coe-library/coe-library-client';
import { parseReportModel } from '@/lib/coe-library/report-render/pbir-parse';
import { parseSampleData } from '@/lib/coe-library/report-render/tmdl-sample';
import {
  resolveLiveReport,
  resolveReportParams,
  resolveBuilderSources,
  getBuilderSource,
  emptyLike,
  type EntityBindingResult,
  type ReportParamOverrides,
} from '@/lib/coe-library/report-render/live-bindings';
import { getPublishedDashboard } from '@/lib/coe-library/builder/dashboard-store';
import { synthReportModel, synthSampleData } from '@/lib/coe-library/builder/dashboard-model';
import type { SampleData, SampleTable } from '@/lib/coe-library/report-render/tmdl-sample';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Reduce a parsed table-set to its column SCHEMA only (zero rows) — never sample rows leave the server. */
function schemaOnly(sample: SampleData): SampleData {
  const out: SampleData = {};
  for (const [k, v] of Object.entries(sample)) out[k] = emptyLike(v);
  return out;
}

/** Render a published Loom-native dashboard for the consumer gallery — LIVE only. */
async function buildDashboardPayload(id: string, overrides: ReportParamOverrides): Promise<NextResponse> {
  const dash = await getPublishedDashboard(id);
  if (!dash) return err('dashboard not found or not published', 404);
  const spec = dash.spec;
  const model = synthReportModel(spec);

  // Column SCHEMA per tile (from the bound source) — zero rows. Keeps each
  // tile's field mapping intact without ever fabricating sample rows.
  const schemaBySource: Record<string, SampleTable> = {};
  for (const tile of spec.tiles) {
    const src = getBuilderSource(tile.sourceId);
    if (src) schemaBySource[tile.sourceId] = { columns: src.columns, rows: [] };
  }
  const schema = synthSampleData(spec, schemaBySource);
  const base = {
    ok: true as const, model, sample: schema, published: true,
    template: { id: dash.id, title: dash.name, description: dash.description, category: dash.category },
  };
  try {
    const resolved = await resolveBuilderSources(spec.tiles.map((t) => t.sourceId), overrides);
    const liveData: SampleData = {};
    const dataSources: Record<string, EntityBindingResult> = {};
    for (const tile of spec.tiles) {
      const r = resolved[tile.sourceId] || { source: 'error' as const, note: 'Data source did not resolve.' };
      dataSources[tile.id] = r;
      // Live rows when resolved; otherwise a REAL EMPTY table (schema, zero rows).
      liveData[tile.id] = r.source === 'live' && r.table ? r.table : emptyLike(schema[tile.id]);
    }
    return NextResponse.json({ ...base, live: liveData, dataSources, params: resolveReportParams(overrides), mode: 'live' });
  } catch (e: any) {
    return NextResponse.json({ ...base, params: resolveReportParams(overrides), mode: 'live', liveError: e?.message || String(e) });
  }
}

async function buildPayload(req: NextRequest, overrides: ReportParamOverrides): Promise<NextResponse> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id')?.trim();
  if (!id) return err('id is required', 400);
  // A published Loom-native dashboard is rendered via the dashboard synthesizer.
  if (url.searchParams.get('kind') === 'dashboard') {
    try { return await buildDashboardPayload(id, overrides); }
    catch (e: any) { return err(e?.message || String(e), 500); }
  }

  try {
    const clone = await getPublishedReport(id);
    if (!clone) return err('report not found or not published', 404);

    const tpl = getTemplate(clone.templateId);
    if (!tpl) return err(`unknown template: ${clone.templateId}`, 404);

    const files = getTemplateFiles(clone.templateId);
    const model = parseReportModel(files);
    // The bundled table-set — used ONLY for its column schema (never its rows).
    const parsed = parseSampleData(files);

    const base = {
      ok: true as const,
      model,
      // Schema-only (zero rows) — the consumer render is always live/empty, never sample.
      sample: schemaOnly(parsed),
      published: true,
      template: {
        id: tpl.id,
        title: clone.displayName || tpl.title,
        description: tpl.description,
        category: clone.category || tpl.category,
      },
    };

    try {
      const { live: liveData, dataSources, params } = await resolveLiveReport(clone.templateId, parsed, overrides);
      return NextResponse.json({ ...base, live: liveData, dataSources, params, mode: 'live' });
    } catch (e: any) {
      return NextResponse.json({
        ...base,
        params: resolveReportParams(overrides),
        mode: 'live',
        liveError: e?.message || String(e),
      });
    }
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const url = new URL(req.url);
  const overrides: ReportParamOverrides = {
    subscriptionId: url.searchParams.get('subscriptionId')?.trim() || undefined,
    billingScope: url.searchParams.get('billingScope')?.trim() || undefined,
    tenantId: url.searchParams.get('tenantId')?.trim() || undefined,
    managementApiBase: url.searchParams.get('managementApiBase')?.trim() || undefined,
  };
  return buildPayload(req, overrides);
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty → env defaults */ }
  const p = body?.params || {};
  const overrides: ReportParamOverrides = {
    subscriptionId: typeof p.subscriptionId === 'string' ? p.subscriptionId.trim() : undefined,
    billingScope: typeof p.billingScope === 'string' ? p.billingScope.trim() : undefined,
    tenantId: typeof p.tenantId === 'string' ? p.tenantId.trim() : undefined,
    managementApiBase: typeof p.managementApiBase === 'string' ? p.managementApiBase.trim() : undefined,
  };
  return buildPayload(req, overrides);
}
