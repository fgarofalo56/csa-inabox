/**
 * Semantic-model TMSL model route — measure persistence via XMLA.
 *
 *   PUT /api/items/semantic-model/[id]/model?workspaceId=&database=
 *     Upserts a single measure (DAX expression + optional format string +
 *     display folder) into an Azure Analysis Services (AAS) tabular model via
 *     TMSL createOrReplace over the XMLA SOAP endpoint, then evaluates it so
 *     the response confirms the measure (and its dynamic format) computes.
 *
 *   GET /api/items/semantic-model/[id]/model
 *     Returns the active backend + whether AAS XMLA persistence is wired, so
 *     the editor can show the right affordance (Save button vs honest gate)
 *     without a network round-trip.
 *
 * Requires LOOM_SEMANTIC_BACKEND=analysis-services AND LOOM_AAS_SERVER. AAS is
 * Azure-native (NOT Fabric / Power BI), so this is the sanctioned optional
 * persistence backend for the semantic-model item per no-fabric-dependency.md.
 * The default backend (loom-native) and the Power BI Premium XMLA path are
 * surfaced as honest 501 gates (no mock "Saved!" — see no-vaporware.md).
 *
 * PUT body: {
 *   tableName:    string;   // existing table in the model
 *   measureName:  string;   // measure to create or replace
 *   expression:   string;   // DAX expression
 *   formatString?: string;  // e.g. "$#,0.00;($#,0.00);$#,0.00"
 *   displayFolder?: string; // e.g. "Finance\\KPIs"
 *   database?:    string;   // overrides LOOM_AAS_DATABASE
 * }
 *
 * 200 → { ok: true, persisted: true, backend, measure, evaluate? }
 * 400 → { ok: false, error } — missing fields
 * 501 → { ok: false, error, gate: 'XMLA', remediation, link } — not wired
 * 422 → { ok: false, error } — XMLA fault (invalid DAX / unknown table)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { upsertMeasure, evaluateMeasure, isAasConfigured, aasDefaultDatabase, AasError } from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND = process.env.LOOM_SEMANTIC_BACKEND || 'loom-native';

interface ModelBody {
  tableName?: string;
  measureName?: string;
  expression?: string;
  formatString?: string;
  displayFolder?: string;
  database?: string;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({
    ok: true,
    backend: BACKEND,
    xmlaPersistence: BACKEND === 'analysis-services' && isAasConfigured(),
    aasConfigured: isAasConfigured(),
    aasDatabase: aasDefaultDatabase() || null,
  });
}

export async function PUT(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Gate: only the analysis-services backend supports TMSL write via this route.
  if (BACKEND !== 'analysis-services') {
    return NextResponse.json({
      ok: false,
      error: `TMSL measure persistence requires LOOM_SEMANTIC_BACKEND=analysis-services (current: ${BACKEND}).`,
      gate: 'XMLA',
      remediation: BACKEND === 'powerbi'
        ? 'The Power BI Premium XMLA endpoint speaks the analysis-services TDS protocol over powerbi://, not plain HTTP — persist measures from Power BI Desktop or Tabular Editor, or switch LOOM_SEMANTIC_BACKEND to analysis-services with an AAS server.'
        : 'Set LOOM_SEMANTIC_BACKEND=analysis-services and provide LOOM_AAS_SERVER + LOOM_AAS_DATABASE to enable XMLA measure persistence. DAX validation still works on every backend via the measures route.',
      link: 'https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-overview',
    }, { status: 501 });
  }

  if (!isAasConfigured()) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_AAS_SERVER is not configured.',
      gate: 'XMLA',
      remediation: 'Set LOOM_AAS_SERVER to the AAS connection string (e.g. asazure://westus.asazure.windows.net/myserver) and LOOM_AAS_DATABASE to the model database name. The Console UAMI must hold the AAS server-administrator role.',
      link: 'https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh',
    }, { status: 501 });
  }

  const body = (await req.json().catch(() => ({}))) as ModelBody;
  const tableName = body.tableName?.trim();
  const measureName = body.measureName?.trim();
  const expression = body.expression?.trim();
  const formatString = body.formatString?.trim() || undefined;
  const displayFolder = body.displayFolder?.trim() || undefined;
  const database = body.database?.trim() || undefined;
  if (!tableName || !measureName || !expression) {
    return NextResponse.json({ ok: false, error: 'tableName, measureName, and expression are required' }, { status: 400 });
  }

  try {
    await upsertMeasure({ database, tableName, measureName, expression, formatString, displayFolder });
    // Evaluate the just-saved measure so the response confirms it (and its
    // dynamic format string) computes against the live model — not a fake toast.
    let evaluate: { value: unknown } | undefined;
    try {
      const r = await evaluateMeasure({ database, tableName, measureName });
      evaluate = { value: r.value };
    } catch {
      // Persist succeeded; eval is best-effort (e.g. measure needs filter context).
      evaluate = undefined;
    }
    return NextResponse.json({
      ok: true,
      persisted: true,
      backend: 'analysis-services',
      measure: { tableName, measureName, expression, formatString, displayFolder },
      evaluate,
    });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
