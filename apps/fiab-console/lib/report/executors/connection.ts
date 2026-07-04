/**
 * lib/report/executors/connection.ts — report /query dispatch Path 4.
 *
 * Get Data (a connection / file-backed report source). Extracted verbatim from
 * app/api/items/report/[id]/query/route.ts (rel-T64) — behaviour-preserving. The
 * resolver already wired a REAL Azure data-plane `ConnectionExecutor`
 * (azure-sql / synapse / databricks / postgres / cosmos / serverless OPENROWSET);
 * this arm requires a `visual`, folds any Power Query transform over the
 * materialized Delta cache, else calls `executor.runVisual`. No mock data
 * (no-vaporware), no Fabric (no-fabric-dependency).
 */

import { NextResponse } from 'next/server';
import { type DaxVisual } from '@/lib/azure/aas-client';
import { type ReportFilterInput } from '@/lib/azure/wells-to-sql';
import { readReportDataSource, type ResolvedReportModel } from '@/lib/azure/report-model-resolver';
import { fromLegacyState, hasTransform } from '@/lib/editors/report/report-data-source';
import { foldAppliedStepsToSql, parseSharedQueries } from '@/lib/components/pipeline/dataflow/m-script';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { TRANSFORM_DIALECT, connectionBaseSelect, tryConnectionCacheRead } from '../transform-fold';

/** Run the Get-Data (connection) report path for one visual. */
export async function executeConnectionQueryPath(
  item: WorkspaceItem,
  resolved: Extract<ResolvedReportModel, { backend: 'connection' }>,
  visual: (DaxVisual & Record<string, unknown>) | undefined,
  filters: ReportFilterInput[] | undefined,
): Promise<NextResponse> {
  if (!visual) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'This report uses a Get Data (connection) source — pass a visual with field ' +
          'wells so the query can be compiled. Raw DAX (query) only applies to an Azure ' +
          'Analysis Services source.',
      },
      { status: 400 },
    );
  }
  // ── WAVE-4: a Power Query transform layered on a Get-Data connection source ──
  // The resolver-owned LIVE executor can't accept a folded FROM, so a connection
  // transform is served Azure-native by folding over the materialized Delta CACHE
  // (serverless OPENROWSET) — the SAME Delta the report /refresh Spark batch
  // writes (reportTableMlvSpec, shared SoT). We NEVER fall through to runVisual
  // when a transform is set (that would read the untransformed source — a silent
  // wrong result, no-vaporware). Foldability is validated up front so a
  // non-foldable step is an honest 409.
  const connSource = fromLegacyState((item.state || {}) as Record<string, unknown>);
  if (hasTransform(connSource) && connSource?.appliedSteps) {
    const queries = parseSharedQueries(connSource.appliedSteps);
    if (!queries.length) {
      return NextResponse.json(
        {
          ok: false,
          code: 'gate',
          error:
            'The report’s Power Query transform could not be parsed. Re-open Transform data and ' +
            're-apply the steps.',
        },
        { status: 412 },
      );
    }
    const base = connectionBaseSelect(readReportDataSource(item));
    if (base) {
      const probe = foldAppliedStepsToSql(base, queries[0].body, TRANSFORM_DIALECT);
      if (!probe.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not-foldable',
            unfoldableStep: probe.unfoldableStep,
            error:
              `Step '${probe.unfoldableStep}' can't fold to a native query — switch this query to ` +
              `Import. Set this query to Import in Transform data, set the table’s Storage mode to ` +
              `Import, and run Refresh to materialize it (Synapse-Spark → Delta); the transformed ` +
              `read then serves from the materialized cache.`,
          },
          { status: 409 },
        );
      }
    }
    // Import → fold over the materialized Delta cache (serverless OPENROWSET over
    // the report-table MLV Delta the refresh route wrote). Returns null when no
    // cache is built yet / the source's storage isn't Import-Dual — handled by
    // the honest gate below, never an untransformed read.
    try {
      const cached = await tryConnectionCacheRead(
        item,
        resolved.executor,
        visual,
        filters,
        queries[0].body,
      );
      if (cached) {
        return NextResponse.json({ ok: true, rows: cached.rows, sql: cached.sql });
      }
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: e?.message || String(e), status: 502 },
        { status: 502 },
      );
    }
    // No materialized transformed cache to read (the transform is DirectQuery over
    // a live connection — which the resolver-owned executor can't fold through
    // without a resolver change — or its Import cache isn't built yet). Honest 412
    // naming the exact remediation; never an untransformed read. Azure-native
    // (serverless OPENROWSET over Delta); no Fabric / Power BI.
    return NextResponse.json(
      {
        ok: false,
        code: 'transform-import-required',
        missing: resolved.connType,
        error:
          `A Power Query transform over a Get Data "${resolved.connType}" connection source is ` +
          `served Azure-native by materializing it to a Delta cache. Set this query to Import in ` +
          `Transform data, set the table’s Storage mode to Import, and run Refresh — the ` +
          `transformed visual then reads the materialized cache (serverless OPENROWSET over ` +
          `Delta). No Fabric / Power BI workspace is required.`,
      },
      { status: 412 },
    );
  }
  try {
    // WAVE-2 FIX — per-table storage now really changes execution for a Get-Data
    // CONNECTION source too. When the bound table is Import/Dual AND its Delta
    // cache has materialized, read the serverless OPENROWSET over the SAME Delta
    // the Azure-native refresh route wrote (reportTableMlvSpec — shared SoT), so
    // an Import connection table is served from cache instead of being silently
    // re-queried live (the half-functional gap this closes). Returns null for
    // DirectQuery / no-cache-yet / a non-aggregate Dual visual / any setup-or-read
    // miss, so we fall through to the live executor below and the visual always
    // returns real rows (no blank/mock). No Power BI / Fabric / OneLake host.
    const cached = await tryConnectionCacheRead(item, resolved.executor, visual, filters);
    if (cached) {
      return NextResponse.json({ ok: true, rows: cached.rows, sql: cached.sql });
    }
    const { rows, query, lang } = await resolved.executor.runVisual(visual, filters);
    // Rows are already object-shaped (Record<string, unknown>[]) — identical to
    // the AAS / Power BI / loom-native paths — so the client renders every
    // backend the same way. The emitted query text rides under `kql` for ADX,
    // `sql` for every SQL/NoSQL engine (per the /query response contract).
    return NextResponse.json({
      ok: true,
      rows,
      ...(lang === 'kql' ? { kql: query } : { sql: query }),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), status: 502 },
      { status: 502 },
    );
  }
}
