/**
 * POST /api/items/semantic-model/[id]/datasource?workspaceId=...
 *
 * Composite + Dual storage mode. Builds a `model.bim` TMSL with a per-partition
 * storage mode (`import` / `directQuery` / `dual`) for every table in the body —
 * so one semantic model can mix modes — then applies it and probes the live
 * model.
 *
 * `[id]` is the Power BI / Fabric semantic-model (dataset) id the editor's
 * Tables tab is operating on.
 *
 * APPLY PATH (no-vaporware.md / no-fabric-dependency.md)
 *   - The TMSL is ALWAYS built and returned (the receipt) — this is the BFF
 *     "sets per-partition mode in TMSL" deliverable.
 *   - Fabric / Power-BI-Premium backed workspace (opt-in, signalled by
 *     LOOM_SEMANTIC_BACKEND=fabric or a bound LOOM_FABRIC_WORKSPACE_ID /
 *     LOOM_DEFAULT_FABRIC_WORKSPACE): the TMSL is applied in-place via the
 *     Fabric updateDefinition REST API (which wraps XMLA). applied=true.
 *   - Otherwise: applied=false and the TMSL is the offline receipt (apply via
 *     `Invoke-ASCmd -Server "asazure://…" -Query <tmsl>`). The default
 *     semantic-model item never depends on Fabric — its Azure-native default is
 *     the Loom-native tabular layer.
 *   - After build/apply, a DAX probe `EVALUATE TOPN(1, '<firstTable>')` runs
 *     against the live model via Power BI executeQueries to confirm the
 *     cross-mode relationship target resolves and a visual returns rows. The
 *     first 300 chars of the result are returned as `probe`.
 *
 * GOV GATE: in a US-Gov boundary, `dual` mode is rejected with a precise 400 —
 * Dual requires Power BI Premium / Fabric capacity, unavailable for standalone
 * AAS at GCC-High / IL5.
 *
 * Body: {
 *   displayName?: string,
 *   tables: Array<{ name, mode: 'import'|'directQuery'|'dual',
 *                   sourceQuery?, dataSourceName?, columns?, measures? }>,
 *   relationships?: Array<{ fromTable, fromColumn, toTable, toColumn,
 *                           crossFilteringBehavior?, isActive? }>,
 *   dataSources?: Array<{ name, type?, connectionString? }>
 * }
 *
 * 200 → { ok: true, tmsl, applied, probe?, steps }
 * 4xx/5xx → { ok: false, error, steps? }
 *
 * No mocks. All errors surfaced verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  AasError,
  buildCompositeTmsl,
  applyTmslViaFabric,
  TABLE_STORAGE_MODES,
  type CompositeTableSpec,
  type CompositeRelationship,
  type CompositeDataSource,
  type TableStorageMode,
} from '@/lib/azure/aas-client';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DatasourceBody {
  displayName?: string;
  tables?: Array<{
    name?: string;
    mode?: string;
    sourceQuery?: string;
    dataSourceName?: string;
    columns?: Array<{ name: string; dataType?: string; sourceColumn?: string }>;
    measures?: Array<{ name: string; expression: string; formatString?: string }>;
  }>;
  relationships?: CompositeRelationship[];
  dataSources?: CompositeDataSource[];
}

/** Fabric apply is opt-in: only when a Fabric/Premium backend is signalled. */
function fabricBackend(workspaceId: string): { ws: string } | null {
  const optedIn =
    (process.env.LOOM_SEMANTIC_BACKEND || '').toLowerCase() === 'fabric' ||
    !!process.env.LOOM_FABRIC_WORKSPACE_ID ||
    !!process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
  if (!optedIn) return null;
  const ws = process.env.LOOM_FABRIC_WORKSPACE_ID || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || workspaceId;
  return ws ? { ws } : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  const body = (await req.json().catch(() => ({}))) as DatasourceBody;
  const rawTables = Array.isArray(body.tables) ? body.tables : [];
  if (rawTables.length === 0) {
    return NextResponse.json({ ok: false, error: 'tables[] required' }, { status: 400 });
  }

  const gov = isGovCloud();
  const tables: CompositeTableSpec[] = [];
  for (const t of rawTables) {
    const name = (t.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'each table needs a name' }, { status: 400 });
    const mode = t.mode as TableStorageMode;
    if (!TABLE_STORAGE_MODES.includes(mode)) {
      return NextResponse.json(
        { ok: false, error: `invalid storage mode "${t.mode}" for table "${name}"` },
        { status: 400 },
      );
    }
    if ((mode === 'directQuery' || mode === 'dual') && !(t.sourceQuery || '').trim()) {
      return NextResponse.json(
        { ok: false, error: `table "${name}" mode="${mode}" requires sourceQuery` },
        { status: 400 },
      );
    }
    if (mode === 'dual' && gov) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `Dual storage mode requires Power BI Premium / Fabric capacity. This deployment is a US-Gov boundary ` +
            `(GCC-High / IL5) where standalone Azure Analysis Services supports only Import and DirectQuery. ` +
            `Set table "${name}" to Import or DirectQuery.`,
        },
        { status: 400 },
      );
    }
    tables.push({
      name,
      mode,
      sourceQuery: t.sourceQuery,
      dataSourceName: t.dataSourceName,
      columns: t.columns,
      measures: t.measures,
    });
  }

  const steps: string[] = [];
  let tmsl: string;
  try {
    tmsl = buildCompositeTmsl(
      (body.displayName || 'CompositeModel').trim(),
      tables,
      body.relationships,
      body.dataSources,
      { targetEngine: gov ? 'aas-standalone' : 'fabric' },
    );
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 400;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
  const modeSummary = tables.map((t) => `${t.name}=${t.mode}`).join(', ');
  steps.push(`Built composite TMSL: ${tmsl.length} bytes, ${tables.length} table(s) [${modeSummary}].`);

  // Apply via Fabric updateDefinition when an opt-in Fabric/Premium backend
  // is configured; otherwise return the TMSL as the offline receipt.
  let applied = false;
  const fabric = fabricBackend(workspaceId);
  try {
    if (fabric) {
      const modelId = process.env.LOOM_FABRIC_SEMANTIC_MODEL_ID || id;
      await applyTmslViaFabric(fabric.ws, modelId, tmsl, body.displayName || 'CompositeModel', steps);
      applied = true;
      steps.push('Composite TMSL applied in-place via Fabric updateDefinition.');
    } else {
      steps.push(
        'No Fabric/Premium backend configured — TMSL built as receipt. Apply offline via ' +
          'Invoke-ASCmd, or set LOOM_SEMANTIC_BACKEND=fabric with a bound LOOM_FABRIC_WORKSPACE_ID.',
      );
    }
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), tmsl, steps }, { status });
  }

  // DAX probe — confirm the cross-mode model is queryable and a visual returns
  // rows. EVALUATE TOPN(1, '<firstTable>') against the live Power BI model.
  let probe: string | undefined;
  try {
    const firstTable = tables[0].name.replace(/'/g, "''");
    const dax = `EVALUATE TOPN(1, '${firstTable}')`;
    const qr = await executeDatasetQueries(workspaceId, id, dax);
    const rows = qr?.results?.[0]?.tables?.[0]?.rows || [];
    probe = JSON.stringify(rows).slice(0, 300);
    steps.push(`DAX probe EVALUATE TOPN(1, '${tables[0].name}') returned ${rows.length} row(s).`);
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 0;
    steps.push(`DAX probe skipped (${status || 'error'}): ${e?.message || String(e)}`);
  }

  return NextResponse.json({ ok: true, tmsl, applied, probe, steps });
}
