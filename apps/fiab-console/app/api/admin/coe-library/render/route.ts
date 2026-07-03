/**
 * CoE template-render BFF — returns a render-ready report model for the viewer.
 *
 * GET  /api/admin/coe-library/render?templateId=<slug>            → catalog template
 * GET  /api/admin/coe-library/render?cloneId=<cloneId>            → one of my clones
 * GET  ...&mode=live[&subscriptionId=&billingScope=&tenantId=&managementApiBase=]
 *                                                                  → LIVE render
 * POST ...?templateId=|cloneId=  body { params: {subscriptionId, billingScope, …} }
 *                                                                  → LIVE render (overrides)
 *
 * Parses the bundled PBIP files (real PBIR visuals + TMDL SAMPLE data) into
 * { model, sample } the <ReportCanvas> renders. In live mode it ALSO resolves
 * each entity against the deployment's OWN Azure estate (Cost Management, Log
 * Analytics, Azure Resource Graph, Defender) via report-render/live-bindings,
 * returning a per-entity `live` table-set + `dataSources` provenance so the
 * viewer can label every visual truthfully (live / sample / error).
 *
 * Azure-native: no Microsoft Fabric / Power BI service is contacted. Session-gated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { getTemplate, getTemplateFiles, getClone } from '@/lib/coe-library/coe-library-client';
import { parseReportModel } from '@/lib/coe-library/report-render/pbir-parse';
import { parseSampleData } from '@/lib/coe-library/report-render/tmdl-sample';
import {
  resolveLiveReport,
  resolveReportParams,
  type ReportParamOverrides,
} from '@/lib/coe-library/report-render/live-bindings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



interface ResolvedTemplate {
  resolvedTemplateId: string;
  published?: boolean;
  displayName?: string;
}

/** Resolve templateId (directly or via a clone) + scope it to the tenant. */
async function resolveTemplate(req: NextRequest, tenantId: string): Promise<ResolvedTemplate | NextResponse> {
  const url = new URL(req.url);
  const templateId = url.searchParams.get('templateId')?.trim();
  const cloneId = url.searchParams.get('cloneId')?.trim();

  if (cloneId) {
    try {
      const clone = await getClone(tenantId, cloneId);
      if (!clone) return apiError(`unknown clone: ${cloneId}`, 404);
      return { resolvedTemplateId: clone.templateId, published: !!clone.published, displayName: clone.displayName };
    } catch (e: any) {
      return apiError(e?.message || String(e), 500);
    }
  }
  if (!templateId) return apiError('templateId or cloneId is required', 400);
  return { resolvedTemplateId: templateId };
}

/** Build the (optionally live) render payload. */
async function buildPayload(
  req: NextRequest,
  tenantId: string,
  live: boolean,
  overrides: ReportParamOverrides,
): Promise<NextResponse> {
  const resolved = await resolveTemplate(req, tenantId);
  if (resolved instanceof NextResponse) return resolved;
  const { resolvedTemplateId, published, displayName } = resolved;

  const tpl = getTemplate(resolvedTemplateId);
  if (!tpl) return apiError(`unknown template: ${resolvedTemplateId}`, 404);

  const files = getTemplateFiles(resolvedTemplateId);
  const model = parseReportModel(files);
  const sample = parseSampleData(files);

  const base = {
    ok: true as const,
    model,
    sample,
    template: {
      id: tpl.id,
      title: displayName || tpl.title,
      description: tpl.description,
      category: tpl.category,
    },
    ...(published !== undefined ? { published } : {}),
  };

  if (!live) {
    return NextResponse.json({ ...base, params: resolveReportParams(overrides) });
  }

  // Live render: resolve each entity against the customer's Azure estate. A
  // single entity erroring never fails the whole render (it falls back to its
  // sample, tagged in dataSources) — so the report always renders.
  try {
    const { live: liveData, dataSources, params } = await resolveLiveReport(resolvedTemplateId, sample, overrides);
    return NextResponse.json({ ...base, live: liveData, dataSources, params, mode: 'live' });
  } catch (e: any) {
    // Defensive: never 500 the viewer — fall back to sample with an error note.
    return NextResponse.json({
      ...base,
      params: resolveReportParams(overrides),
      mode: 'live',
      liveError: e?.message || String(e),
    });
  }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const url = new URL(req.url);
  const live = url.searchParams.get('mode') === 'live';
  const overrides: ReportParamOverrides = {
    subscriptionId: url.searchParams.get('subscriptionId')?.trim() || undefined,
    billingScope: url.searchParams.get('billingScope')?.trim() || undefined,
    tenantId: url.searchParams.get('tenantId')?.trim() || undefined,
    managementApiBase: url.searchParams.get('managementApiBase')?.trim() || undefined,
  };
  return buildPayload(req, s.claims.oid, live, overrides);
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body → env defaults */ }
  const p = body?.params || {};
  const overrides: ReportParamOverrides = {
    subscriptionId: typeof p.subscriptionId === 'string' ? p.subscriptionId.trim() : undefined,
    billingScope: typeof p.billingScope === 'string' ? p.billingScope.trim() : undefined,
    tenantId: typeof p.tenantId === 'string' ? p.tenantId.trim() : undefined,
    managementApiBase: typeof p.managementApiBase === 'string' ? p.managementApiBase.trim() : undefined,
  };
  // POST always means a live render (it carries overrides).
  return buildPayload(req, s.claims.oid, true, overrides);
}
