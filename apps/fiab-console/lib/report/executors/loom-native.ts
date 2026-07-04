/**
 * lib/report/executors/loom-native.ts — report /query dispatch Path 3.
 *
 * Loom-native SQL over Synapse (Azure-native DEFAULT — report-designer v2).
 * Extracted verbatim from app/api/items/report/[id]/query/route.ts (rel-T64) —
 * behaviour-preserving. Compiles the field wells into a parameterized
 * `SELECT … GROUP BY` and the structured filters into a `WHERE`/`HAVING`, folds
 * any Power Query transform, then runs through the query-acceleration orchestrator
 * (accel → cache → serverless Synapse). REAL aggregated rows, NO AAS / Power BI /
 * Fabric, no mock (no-vaporware.md).
 */

import { NextResponse } from 'next/server';
import { type DaxVisual } from '@/lib/azure/aas-client';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import { type ResolvedReportModel } from '@/lib/azure/report-model-resolver';
import {
  buildSqlFromVisual,
  type ReportFilterInput,
  type VisualCompileOptions,
} from '@/lib/azure/wells-to-sql';
import { fromLegacyState, reportTransformMode } from '@/lib/editors/report/report-data-source';
import { deriveFreshnessToken } from '@/lib/azure/query-result-cache';
import { runAcceleratedQuery, extractDeltaUrl } from '@/lib/azure/report-accel-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { toSqlSource } from '../query-projection';
import { foldTransformOntoSource } from '../transform-fold';

/** Run the Loom-native (Synapse) report path for one visual. */
export async function executeLoomNativeQueryPath(
  item: WorkspaceItem,
  resolved: Extract<ResolvedReportModel, { backend: 'loom-native' }>,
  visual: (DaxVisual & Record<string, unknown>) | undefined,
  filters: ReportFilterInput[] | undefined,
  compileOpts: VisualCompileOptions | undefined,
): Promise<NextResponse> {
  if (!visual) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'This report uses a Loom-native (Synapse) data source — pass a visual with field ' +
          'wells so the query can be compiled. Raw DAX (query) only applies to an Azure ' +
          'Analysis Services source.',
      },
      { status: 400 },
    );
  }
  const projected = toSqlSource(resolved.tables, resolved.sqlSource, visual, filters);
  // Honest parity gate: the visual binds across >1 model table and the
  // single-FROM compiler can't join them. Name the spanned tables + the exact
  // remediation instead of returning a silently partial result.
  if (projected.kind === 'multi-table') {
    return NextResponse.json(
      {
        ok: false,
        code: 'multi-table',
        error:
          `This visual binds fields from more than one table of the semantic model ` +
          `(${projected.tables.join(', ')}). The Loom-native (Synapse) report renderer runs ` +
          `each visual over a single model table, so cross-table visuals aren’t supported on ` +
          `this Azure-native path yet. Use a semantic model — or a direct-query SELECT — whose ` +
          `single table already joins these fields, or bind the report to an Azure Analysis ` +
          `Services model where the table relationships are defined.`,
      },
      { status: 400 },
    );
  }
  // Wave-2 cross-storage-group "limited relationship": the visual joins tables
  // that live in different storage-mode groups. Power BI serves these only via
  // the materialized smaller side, so the renderer requires that side's Import
  // cache. Return an honest 412 naming the exact table to materialize — never a
  // silent partial / cross join (no-vaporware.md). Azure-native throughout.
  if (projected.kind === 'limited') {
    return NextResponse.json(
      {
        ok: false,
        code: 'limited-relationship',
        error: projected.cacheReady
          ? `This visual combines tables that live in different storage-mode groups ` +
            `(${projected.groups.join(', ')}). Cross-group ("limited relationship") joins need ` +
            `relationship keys defined in the model; the Loom-native (Synapse) renderer runs each ` +
            `visual over a single relation and won't cross-join "${projected.smaller}" with the ` +
            `other group's source. Model these fields in one semantic-model table (or a direct-query ` +
            `SELECT that already joins them), or use an Azure Analysis Services model where the ` +
            `relationships are defined. No Power BI / Fabric workspace required either way.`
          : `This visual combines tables across storage-mode groups via the smaller side ` +
            `"${projected.smaller}", but that table has no materialized Import cache yet. Set ` +
            `"${projected.smaller}" to Import (or Dual) in Storage mode and run Refresh to ` +
            `materialize its Delta cache, then re-run — the cross-group ("limited relationship") ` +
            `visual reads the materialized smaller side. This is Azure-native (serverless ` +
            `OPENROWSET over Delta); no Power BI / Fabric workspace is required.`,
        missing: projected.smaller,
      },
      { status: 412 },
    );
  }
  if (projected.kind === 'no-columns') {
    return NextResponse.json(
      { ok: false, error: 'The report’s data source has no bindable columns for this visual.' },
      { status: 400 },
    );
  }
  // ── WAVE-4: fold any Power Query transform onto the resolved relation ───────
  // DirectQuery folds the applied steps to a derived SELECT here; Import's
  // resolved relation (the W2 source-groups arm already picked live-vs-cache as
  // `projected.source.from`) is folded the SAME way, so the visual always runs
  // over the TRANSFORMED data. A non-foldable step is an honest 409 (Import
  // materializes it via the report /refresh run), never a silently-wrong read.
  // No transform ⇒ byte-identical to before (back-compat).
  const reportSource = fromLegacyState((item.state || {}) as Record<string, unknown>);
  const fold = foldTransformOntoSource(projected.source, reportSource);
  if (fold.kind === 'unparseable') {
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
  if (fold.kind === 'not-foldable') {
    const importMode = reportTransformMode(reportSource) === 'import';
    return NextResponse.json(
      {
        ok: false,
        code: 'not-foldable',
        unfoldableStep: fold.step,
        error:
          `Step '${fold.step}' can't fold to a native query — switch this query to Import.` +
          (importMode
            ? ' This query is already set to Import — run Refresh to materialize it via the dataflow run, then it reads the materialized Delta.'
            : ' Set this query to Import in Transform data and run Refresh to materialize it (Synapse-Spark → Delta), or remove/replace the non-foldable step.'),
      },
      { status: 409 },
    );
  }
  const sqlSource = fold.kind === 'folded' ? fold.source : projected.source;
  const compiled = buildSqlFromVisual(visual, filters, sqlSource, compileOpts);
  if (!compiled) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The visual has no fields yet — add a category/value field to generate a runnable query.',
      },
      { status: 400 },
    );
  }
  try {
    // Wave-2 source-group visuals run on THEIR chosen relation's target —
    // serverless for an Import / Dual / Direct-Lake Delta cache, the pinned
    // pool for a live (DirectQuery / Dual-live) relation. Single-source reports
    // set no override and keep the resolver-pinned target, byte-for-byte.
    const runTarget = projected.target ?? resolved.sqlSource.target;

    // ── QUERY ACCELERATION (Direct Lake) — accel → cache → Serverless ────────
    // The result cache is ALWAYS on (in-process + optional Cosmos): a repeat of
    // this exact logical query (same compiled SQL + params, same freshness
    // token) collapses to a Map read. The Databricks-SQL (Photon) over-Delta
    // accel fast path is offered ONLY when a Databricks SQL warehouse is
    // configured (LOOM_DATABRICKS_HOSTNAME + LOOM_DATABRICKS_SQL_WAREHOUSE_ID)
    // AND the chosen relation is a serverless Delta OPENROWSET (lakehouse /
    // Import-Dual-Direct Lake cache) — i.e. the exact aggregating-visual shape
    // Direct Lake speeds up; the warehouse reads the SAME ADLS Delta in-place.
    // It is NOT offered when a Power Query transform folded the source
    // (fold.kind==='folded') or drill/what-if rewrote the query (compileOpts),
    // because the narrow accel compiler wouldn't reflect those — those still run
    // on Synapse. On ANY accel miss/failure the orchestrator runs the SAME real
    // Synapse query below (runDirect) — honest fallback, never a mock or a wrong
    // row (no-vaporware.md). 100% Azure-native (no Fabric / Power BI / OneLake).
    const deltaUrl =
      fold.kind === 'folded' || compileOpts ? null : extractDeltaUrl(projected.source.from);
    const accelInputs =
      deltaUrl && visual
        ? { deltaUrl, visual, filters, columns: projected.source.columns }
        : undefined;

    const run = await runAcceleratedQuery({
      modelId: item.id,
      freshness: deriveFreshnessToken(item),
      storageMode: runTarget.cacheKey, // precise execution-surface identity
      compiledSql: compiled.sql,
      parameters: compiled.parameters,
      accel: accelInputs,
      runDirect: () => executeQuery(runTarget, compiled.sql, 30_000, compiled.parameters),
    });

    return NextResponse.json({
      ok: true,
      rows: run.rows,
      sql: run.sql ?? compiled.sql,
      elapsedMs: run.elapsedMs,
      rowCount: run.rowCount,
      // Which tier answered — drives the "Accelerated ⚡ / Serverless" badge.
      accelerated: run.source,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), status: 502 },
      { status: 502 },
    );
  }
}
