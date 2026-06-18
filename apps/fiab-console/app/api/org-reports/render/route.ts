/**
 * Organization reports render BFF.
 *
 * GET  /api/org-reports/render?id=<cloneId>            → render model (+ SAMPLE)
 * GET  ...&mode=live[&subscriptionId=&billingScope=&…] → LIVE render of a
 *                                                         published report
 * POST ...?id=<cloneId>  body { params: {…} }          → LIVE render (overrides)
 *
 * 404 if the report is not published (so unpublishing immediately removes
 * consumer access). In live mode each entity resolves against the deployment's
 * OWN Azure estate (Cost Management, Log Analytics, Resource Graph, Defender)
 * via report-render/live-bindings, with per-entity `dataSources` provenance.
 *
 * Azure-native: no Microsoft Fabric / Power BI service is contacted.
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

/** Render a published Loom-native dashboard for the consumer gallery. */
async function buildDashboardPayload(id: string, live: boolean, overrides: ReportParamOverrides): Promise<NextResponse> {
  const dash = await getPublishedDashboard(id);
  if (!dash) return err('dashboard not found or not published', 404);
  const spec = dash.spec;
  const model = synthReportModel(spec);

  const sampleBySource: Record<string, SampleTable> = {};
  for (const tile of spec.tiles) {
    const src = getBuilderSource(tile.sourceId);
    if (src) {
      const cols = src.columns;
      const val = cols.includes(tile.value) ? tile.value : cols[cols.length - 1];
      sampleBySource[tile.sourceId] = {
        columns: cols,
        rows: [1, 2, 3].map((n) => Object.fromEntries(cols.map((c) => [c, c === val ? n * 100 : `Sample ${n}`]))),
      };
    }
  }
  const sample = synthSampleData(spec, sampleBySource);
  const base = {
    ok: true as const, model, sample, published: true,
    template: { id: dash.id, title: dash.name, description: dash.description, category: dash.category },
  };
  if (!live) return NextResponse.json({ ...base, params: resolveReportParams(overrides) });
  try {
    const resolved = await resolveBuilderSources(spec.tiles.map((t) => t.sourceId), overrides);
    const liveData: SampleData = {};
    const dataSources: Record<string, EntityBindingResult> = {};
    for (const tile of spec.tiles) {
      const r = resolved[tile.sourceId] || { source: 'error' as const, note: 'Data source did not resolve.' };
      dataSources[tile.id] = r;
      liveData[tile.id] = r.source === 'live' && r.table ? r.table : sample[tile.id];
    }
    return NextResponse.json({ ...base, live: liveData, dataSources, params: resolveReportParams(overrides), mode: 'live' });
  } catch (e: any) {
    return NextResponse.json({ ...base, params: resolveReportParams(overrides), mode: 'live', liveError: e?.message || String(e) });
  }
}

async function buildPayload(req: NextRequest, live: boolean, overrides: ReportParamOverrides): Promise<NextResponse> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id')?.trim();
  if (!id) return err('id is required', 400);
  // A published Loom-native dashboard is rendered via the dashboard synthesizer.
  if (url.searchParams.get('kind') === 'dashboard') {
    try { return await buildDashboardPayload(id, live, overrides); }
    catch (e: any) { return err(e?.message || String(e), 500); }
  }

  try {
    const clone = await getPublishedReport(id);
    if (!clone) return err('report not found or not published', 404);

    const tpl = getTemplate(clone.templateId);
    if (!tpl) return err(`unknown template: ${clone.templateId}`, 404);

    const files = getTemplateFiles(clone.templateId);
    const model = parseReportModel(files);
    const sample = parseSampleData(files);

    const base = {
      ok: true as const,
      model,
      sample,
      published: true,
      template: {
        id: tpl.id,
        title: clone.displayName || tpl.title,
        description: tpl.description,
        category: clone.category || tpl.category,
      },
    };

    if (!live) {
      return NextResponse.json({ ...base, params: resolveReportParams(overrides) });
    }

    try {
      const { live: liveData, dataSources, params } = await resolveLiveReport(clone.templateId, sample, overrides);
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
  const live = url.searchParams.get('mode') === 'live';
  const overrides: ReportParamOverrides = {
    subscriptionId: url.searchParams.get('subscriptionId')?.trim() || undefined,
    billingScope: url.searchParams.get('billingScope')?.trim() || undefined,
    tenantId: url.searchParams.get('tenantId')?.trim() || undefined,
    managementApiBase: url.searchParams.get('managementApiBase')?.trim() || undefined,
  };
  return buildPayload(req, live, overrides);
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
  return buildPayload(req, true, overrides);
}
