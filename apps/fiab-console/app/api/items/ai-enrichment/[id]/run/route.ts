/**
 * POST /api/items/ai-enrichment/[id]/run
 *   body {
 *     warehouseId, catalog, schema, table, sourceColumn, outputColumn,
 *     destTable, op, options?, batchSize?, concurrency?,
 *     tier?, deployment?, reasoningEffort?, limit?
 *   }
 *
 * Materialise the enriched table (AIF-7 full run) and persist the run to
 * `item.state.runs[]`. Two REAL destination-write paths, exactly mirroring the
 * ai-function route's engine split:
 *
 *   • Builtin op + Databricks warehouse → ONE in-database CREATE TABLE AS SELECT
 *     computing `ai_*(col) AS <outputColumn>` over the source (every source
 *     column preserved). Real new Delta table, real populated column.
 *
 *   • custom_prompt (no ai_* builtin) → read up to N rows, enrich each via live
 *     Azure OpenAI (bounded concurrency + retry), write a two-column
 *     (source_value, <outputColumn>) Delta table via a VALUES CTAS.
 *
 *   • No Databricks warehouse (e.g. Gov-High without a workspace) → honest gate
 *     (the destination write needs a writable Azure SQL backend). Preview still
 *     runs real AOAI over pasted samples.
 *
 * Owner-scoped via loadOwnedItem / updateOwnedItem.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { NoAoaiDeploymentError, type AiFnOptions } from '@/lib/azure/ai-functions-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  isEnrichmentOp, opHasDbxBuiltin, buildEnrichmentCtas, buildValuesCtas, buildSampleSelect,
  runAoaiEnrichment, normalizeExecTuning, appendRun, runStatusFor, MAX_AOAI_ROWS,
  type EnrichmentOp, type EnrichmentRun, type ModelTier,
} from '@/lib/azure/ai-enrichment-client';
import { makeEnrichOne, parseEnrichmentOptions } from '../../_lib/enrich';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ai-enrichment';
const AOAI_GATE_HINT =
  'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the Console UAMI "Cognitive Services OpenAI User".';
const DBX_GATE_HINT =
  'Provision a Databricks SQL Warehouse (set LOOM_DATABRICKS_HOSTNAME + the workspace) — the enriched-table write needs a writable Azure backend. Preview still runs against Azure OpenAI.';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;
  const item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid);
  if (!item) return jerr('not found', 404);

  const body = await req.json().catch(() => ({}));
  const op = typeof body?.op === 'string' ? body.op : '';
  if (!isEnrichmentOp(op)) return NextResponse.json({ ok: false, error: `Invalid op "${op}".` }, { status: 400 });

  const sourceColumn = typeof body?.sourceColumn === 'string' ? body.sourceColumn.trim() : '';
  const outputColumn = typeof body?.outputColumn === 'string' ? body.outputColumn.trim() : '';
  const warehouseId = typeof body?.warehouseId === 'string' ? body.warehouseId.trim() : '';
  const catalog = typeof body?.catalog === 'string' ? body.catalog.trim() : '';
  const schema = typeof body?.schema === 'string' ? body.schema.trim() : '';
  const table = typeof body?.table === 'string' ? body.table.trim() : '';
  const destTable = typeof body?.destTable === 'string' ? body.destTable.trim() : '';
  const eopts = parseEnrichmentOptions(body?.options);
  const tier: ModelTier = body?.tier === 'advanced' ? 'advanced' : 'fast';
  const { batchSize, concurrency } = normalizeExecTuning({ batchSize: body?.batchSize, concurrency: body?.concurrency });
  const limit = Number.isFinite(body?.limit) && body.limit > 0 ? Math.floor(body.limit) : undefined;

  if (!sourceColumn) return NextResponse.json({ ok: false, error: 'sourceColumn required.' }, { status: 400 });
  if (!outputColumn) return NextResponse.json({ ok: false, error: 'outputColumn required.' }, { status: 400 });
  if (!catalog || !schema || !destTable) {
    return NextResponse.json({ ok: false, error: 'catalog, schema and destTable are required for the destination write.' }, { status: 400 });
  }
  if (op === 'custom_prompt' && !eopts.customPrompt) {
    return NextResponse.json({ ok: false, error: 'custom_prompt requires a prompt.' }, { status: 400 });
  }

  const dbxReady = databricksConfigGate() === null && !!warehouseId;
  if (!dbxReady) {
    return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: 'A Databricks SQL Warehouse is required to write the enriched destination table.', hint: DBX_GATE_HINT }, { status: 503 });
  }

  const fqSource = catalog && schema ? `\`${catalog}\`.\`${schema}\`.\`${table}\`` : table;
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json({ ok: false, state: w?.state || 'UNKNOWN', error: 'Warehouse not RUNNING — start it before running the enrichment.' }, { status: 409 });
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let run: EnrichmentRun;

  try {
    if (opHasDbxBuiltin(op as EnrichmentOp)) {
      // ── In-database CTAS (whole table, every column preserved) ──────────────
      const sql = buildEnrichmentCtas({
        catalog, schema, destTable, sourceTable: fqSource, sourceColumn, outputColumn,
        op: op as EnrichmentOp, options: eopts, limit,
      });
      const res = await executeStatement(warehouseId, sql, catalog, schema);
      // Row count of the destination (best-effort; DDL returns 0 rows itself).
      let rows = 0;
      try {
        const cnt = await executeStatement(warehouseId, `SELECT COUNT(*) FROM \`${catalog}\`.\`${schema}\`.\`${destTable}\``);
        rows = Number(cnt.rows?.[0]?.[0] ?? 0) || 0;
      } catch { /* best-effort */ }
      run = {
        id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
        engine: 'databricks', op: op as EnrichmentOp, sourceTable: `${catalog}.${schema}.${table}`,
        sourceColumn, outputColumn, destTable: `${catalog}.${schema}.${destTable}`, tier,
        model: 'databricks-ai_functions', rowsProcessed: rows, rowsSucceeded: rows, rowsFailed: 0,
        totalTokens: 0, durationMs: res.executionMs || (Date.now() - t0), status: rows > 0 ? 'succeeded' : 'partial',
        startedBy: session.claims.upn || session.claims.email || session.claims.oid,
      };
    } else {
      // ── custom_prompt: read rows → AOAI enrich → VALUES CTAS ────────────────
      const capped = Math.min(limit ?? MAX_AOAI_ROWS, MAX_AOAI_ROWS);
      const readRes = await executeStatement(warehouseId, buildSampleSelect(fqSource, sourceColumn, capped), catalog, schema);
      const inputs = readRes.rows.map((r) => String(r[0] ?? ''));
      const nonEmpty = inputs.filter((s) => s.trim());
      if (!nonEmpty.length) return NextResponse.json({ ok: false, error: 'No non-empty source rows to enrich.' }, { status: 400 });

      const aiOpts: AiFnOptions = { tenantConfig: await loadTenantCopilotConfig(session.claims.oid).catch(() => null) };
      if (tier === 'advanced' && typeof body?.deployment === 'string' && body.deployment.trim()) aiOpts.deployment = body.deployment.trim();
      if (tier === 'advanced' && typeof body?.reasoningEffort === 'string' && ['minimal', 'low', 'medium', 'high'].includes(body.reasoningEffort)) {
        aiOpts.reasoningEffort = body.reasoningEffort;
      }
      const enrichOne = makeEnrichOne(op as EnrichmentOp, eopts, aiOpts);
      const batch = await runAoaiEnrichment(nonEmpty, enrichOne, { concurrency, maxAttempts: 3, backoffBaseMs: 300 });

      const pairs = batch.results.filter((r) => r.output != null).map((r) => ({ source: r.input, output: r.output as string }));
      if (!pairs.length) {
        const first = batch.results.find((r) => r.error)?.error || 'all rows failed';
        if (/not configured|No AOAI deployment|LOOM_AOAI/i.test(first)) {
          return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: first, hint: AOAI_GATE_HINT }, { status: 501 });
        }
        return NextResponse.json({ ok: false, error: first }, { status: 502 });
      }
      const writeSql = buildValuesCtas({ catalog, schema, destTable, outputColumn, pairs });
      const wr = await executeStatement(warehouseId, writeSql, catalog, schema);
      run = {
        id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
        engine: 'aoai', op: op as EnrichmentOp, sourceTable: `${catalog}.${schema}.${table}`,
        sourceColumn, outputColumn, destTable: `${catalog}.${schema}.${destTable}`, tier,
        model: batch.results.find((r) => r.model)?.model, rowsProcessed: batch.total,
        rowsSucceeded: batch.succeeded, rowsFailed: batch.failed, totalTokens: batch.usage.totalTokens,
        durationMs: Date.now() - t0, status: runStatusFor(batch.succeeded, batch.failed),
        startedBy: session.claims.upn || session.claims.email || session.claims.oid,
      };
      void wr;
    }
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: e.message, hint: AOAI_GATE_HINT }, { status: 501 });
    }
    // Persist a failed run for the history, then surface the error.
    const failed: EnrichmentRun = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      engine: opHasDbxBuiltin(op as EnrichmentOp) ? 'databricks' : 'aoai', op: op as EnrichmentOp,
      sourceTable: `${catalog}.${schema}.${table}`, sourceColumn, outputColumn,
      destTable: `${catalog}.${schema}.${destTable}`, tier, rowsProcessed: 0, rowsSucceeded: 0, rowsFailed: 0,
      totalTokens: 0, durationMs: Date.now() - t0, status: 'failed', error: e?.message || String(e),
      startedBy: session.claims.upn || session.claims.email || session.claims.oid,
    };
    await persistRun(itemId, session.claims.oid, item.state, body, failed).catch(() => {});
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  await persistRun(itemId, session.claims.oid, item.state, body, run).catch(() => {});
  return NextResponse.json({ ok: true, run });
}

/** Persist the run into item.state.runs[] and mirror the latest config. */
async function persistRun(
  itemId: string,
  tenantId: string,
  prevState: Record<string, any> | undefined,
  body: any,
  run: EnrichmentRun,
): Promise<void> {
  const state = { ...(prevState || {}) };
  state.runs = appendRun(Array.isArray(state.runs) ? state.runs : undefined, run);
  // Mirror the last-used config so the editor rehydrates.
  state.config = {
    warehouseId: body?.warehouseId, catalog: body?.catalog, schema: body?.schema, table: body?.table,
    sourceColumn: body?.sourceColumn, outputColumn: body?.outputColumn, destTable: body?.destTable,
    op: body?.op, options: body?.options, batchSize: body?.batchSize, concurrency: body?.concurrency,
    tier: body?.tier, deployment: body?.deployment, reasoningEffort: body?.reasoningEffort,
  };
  await updateOwnedItem(itemId, ITEM_TYPE, tenantId, { state });
}
