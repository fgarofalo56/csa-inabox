/**
 * lib/semantic-model/xmla-writes.ts
 *
 * The two XMLA WRITE surfaces of the semantic-model route — the Monaco DAX
 * editor's "Save to model (XMLA)" PUT (single-measure createOrReplace) and the
 * Tables-tab column-metadata PATCH (alter-column / add-calculated-column /
 * add-calculated-table) — extracted verbatim from
 * app/api/items/semantic-model/[id]/model/route.ts (rel-T64) — behaviour-
 * preserving. Both run the REAL XMLA Alter/Create against the configured backend
 * (Azure Analysis Services by default; a Power BI Premium / Fabric XMLA endpoint
 * opt-in by URL only) and honest-gate when unconfigured (no fake success per
 * no-vaporware.md; no Fabric/Power BI *workspace* requirement per
 * no-fabric-dependency.md — AAS is a standalone Azure resource).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AasError, aasDefaultDatabase,
  upsertMeasure, evaluateMeasure, isAasConfigured,
  // PR #984 — column metadata editor (XMLA Alter/Create) surface
  aasColumnEditorGate, aasXmlaConfig, command as executeXmlaCommand,
  buildAlterColumnTmsl, buildCreateCalcColumnTmsl, buildCreateCalcTableTmsl,
  type TmslColumnDef, type TmslCalcColumnDef,
} from '@/lib/azure/aas-client';

interface MeasurePutBody {
  tableName?: string;
  measureName?: string;
  expression?: string;
  formatString?: string;
  displayFolder?: string;
  database?: string;
}

/**
 * Handle the PR #980 single-measure save dispatch (Monaco DAX editor's "Save to
 * model (XMLA)" button). Honest 501 infra-gates when the AAS XMLA backend isn't
 * configured (no fake "Saved!" toast per no-vaporware.md); on success, evaluate
 * the just-saved measure so the response confirms it (and its dynamic format)
 * computes against the live model.
 */
export async function handleMeasurePut(body: MeasurePutBody): Promise<NextResponse> {
  const tableName = body.tableName?.trim();
  const measureName = body.measureName?.trim();
  const expression = body.expression?.trim();
  const formatString = body.formatString?.trim() || undefined;
  const displayFolder = body.displayFolder?.trim() || undefined;
  const database = body.database?.trim() || undefined;
  if (!tableName || !measureName || !expression) {
    return NextResponse.json(
      { ok: false, error: 'tableName, measureName, and expression are required' },
      { status: 400 },
    );
  }

  const backend = (process.env.LOOM_SEMANTIC_BACKEND || 'loom-native').trim().toLowerCase();
  if (backend !== 'analysis-services' && backend !== 'aas') {
    return NextResponse.json({
      ok: false,
      error: `TMSL measure persistence requires LOOM_SEMANTIC_BACKEND=analysis-services (current: ${backend}).`,
      gate: 'XMLA',
      remediation: backend === 'powerbi'
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

  try {
    await upsertMeasure({ database, tableName, measureName, expression, formatString, displayFolder });
    // Best-effort evaluate so the response confirms the measure (and its
    // dynamic format string) computes — failure does NOT fail the save.
    let evaluate: { value: unknown } | undefined;
    try {
      const r = await evaluateMeasure({ database, tableName, measureName });
      evaluate = { value: r.value };
    } catch {
      evaluate = undefined;
    }
    return NextResponse.json({
      ok: true,
      persisted: true,
      backend: 'analysis-services',
      measure: { tableName, measureName, expression, formatString, displayFolder },
      evaluate,
      database: database || aasDefaultDatabase() || null,
    });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

// ── Column metadata editor (PR #984) — Tables tab XMLA Alter/Create path ────
//
// PATCH ops:
//   { op: 'alter-column',          tableName, columnName, column: TmslColumnDef }
//   { op: 'add-calculated-column', tableName, column: TmslCalcColumnDef }
//   { op: 'add-calculated-table',  tableName, expression }
// Runs the real XMLA Alter/Create against the configured backend
// (LOOM_AAS_SERVER_URL — Azure Analysis Services by default; or the
// LOOM_POWERBI_XMLA_ENDPOINT opt-in) and returns the exact TMSL JSON sent.

interface AlterColumnBody {
  op: 'alter-column';
  tableName?: string;
  columnName?: string;
  column?: TmslColumnDef;
}
interface AddCalcColumnBody {
  op: 'add-calculated-column';
  tableName?: string;
  column?: TmslCalcColumnDef;
}
interface AddCalcTableBody {
  op: 'add-calculated-table';
  tableName?: string;
  expression?: string;
}
type ModelPatch = AlterColumnBody | AddCalcColumnBody | AddCalcTableBody;

/**
 * Handle the column-metadata PATCH (post-auth): honest-gate when the AAS column
 * editor isn't configured (200 { gate }), else run the real XMLA Alter/Create for
 * the requested op and return the exact TMSL JSON sent. The route performs the
 * session check before delegating here.
 */
export async function handleColumnPatch(req: NextRequest): Promise<NextResponse> {
  const gate = aasColumnEditorGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 200 });

  const cfg = aasXmlaConfig()!;
  const body = (await req.json().catch(() => ({}))) as ModelPatch;

  try {
    if (body.op === 'alter-column') {
      if (!body.tableName || !body.column?.name || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'alter-column requires tableName and a complete column object (name + dataType)' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildAlterColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-column') {
      if (!body.tableName || !body.column?.name || !body.column?.expression || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-column requires tableName and column { name, dataType, expression }' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildCreateCalcColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-table') {
      if (!body.tableName || !body.expression) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-table requires tableName and a DAX expression' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildCreateCalcTableTmsl(cfg.database, body.tableName, body.expression), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    return NextResponse.json({ ok: false, error: `unknown op "${(body as any).op}"` }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof AasError ? (e.status === 401 ? 401 : 502) : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
