/**
 * POST /api/items/ai-enrichment/[id]/preview
 *   body {
 *     warehouseId?, catalog?, schema?, table?, sourceColumn,
 *     op, options?, sampleValues?:string[], sampleSize?,
 *     tier?, deployment?, reasoningEffort?, totalRows?
 *   }
 *
 * Enrich the first N REAL rows of the source column with REAL Azure OpenAI
 * output (the pre-run preview AIF-7 requires). Two input modes:
 *   • warehouse + table  → read N rows via a live SELECT (executeStatement).
 *   • sampleValues[]     → caller-pasted sample cells (Gov / no-warehouse path).
 *
 * Returns per-row before/after, measured avg tokens/row, and a full-run cost
 * estimate grounded in that measured average (rel-T85 token metering). Owner-
 * scoped via loadOwnedItem.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { NoAoaiDeploymentError, type AiFnOptions } from '@/lib/azure/ai-functions-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  isEnrichmentOp, buildSampleSelect, runAoaiEnrichment, avgTokensPerRow,
  estimateEnrichmentCost, normalizeExecTuning, MAX_AOAI_ROWS,
} from '@/lib/azure/ai-enrichment-client';
import { makeEnrichOne, parseEnrichmentOptions } from '../../_lib/enrich';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ai-enrichment';
const GATE_HINT =
  'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (admin-plane/main.bicep — aiFoundryEnabled / agentFoundryEnabled) and grant the Console UAMI "Cognitive Services OpenAI User".';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return jerr('not found', 404);

  const body = await req.json().catch(() => ({}));
  const op = typeof body?.op === 'string' ? body.op : '';
  if (!isEnrichmentOp(op)) {
    return NextResponse.json({ ok: false, error: `Invalid op "${op}".` }, { status: 400 });
  }
  const sourceColumn = typeof body?.sourceColumn === 'string' ? body.sourceColumn.trim() : '';
  const eopts = parseEnrichmentOptions(body?.options);
  if (op === 'custom_prompt' && !eopts.customPrompt) {
    return NextResponse.json({ ok: false, error: 'custom_prompt requires a prompt.' }, { status: 400 });
  }

  const { concurrency } = normalizeExecTuning({ concurrency: body?.concurrency, batchSize: body?.batchSize });
  const sampleSize = Math.max(1, Math.min(50, Math.floor(Number(body?.sampleSize) || 10)));

  // ── Resolve the sample inputs ──────────────────────────────────────────────
  let inputs: string[] = [];
  const pasted: string[] = Array.isArray(body?.sampleValues)
    ? body.sampleValues.map((x: unknown) => String(x ?? '')).filter((s: string) => s.trim())
    : [];
  const warehouseId = typeof body?.warehouseId === 'string' ? body.warehouseId.trim() : '';
  const catalog = typeof body?.catalog === 'string' ? body.catalog.trim() : '';
  const schema = typeof body?.schema === 'string' ? body.schema.trim() : '';
  const table = typeof body?.table === 'string' ? body.table.trim() : '';

  if (pasted.length) {
    inputs = pasted.slice(0, sampleSize);
  } else {
    if (!sourceColumn) return NextResponse.json({ ok: false, error: 'sourceColumn required.' }, { status: 400 });
    if (databricksConfigGate() || !warehouseId || !table) {
      return NextResponse.json(
        { ok: false, error: 'Provide sampleValues[] (paste sample cells) or a Databricks warehouse + table to read rows from.', hint: GATE_HINT },
        { status: 400 },
      );
    }
    const fq = catalog && schema ? `\`${catalog}\`.\`${schema}\`.\`${table}\`` : table;
    const w = await getWarehouse(warehouseId).catch(() => null);
    if (!w || w.state !== 'RUNNING') {
      return NextResponse.json({ ok: false, state: w?.state || 'UNKNOWN', error: 'Warehouse not RUNNING — start it to read sample rows.' }, { status: 409 });
    }
    try {
      const res = await executeStatement(warehouseId, buildSampleSelect(fq, sourceColumn, sampleSize), catalog || undefined, schema || undefined);
      inputs = res.rows.map((r) => String(r[0] ?? '')).filter((s) => s.trim());
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  if (!inputs.length) {
    return NextResponse.json({ ok: false, error: 'No non-empty source rows to preview.' }, { status: 400 });
  }

  // ── Enrich the sample (real AOAI) ──────────────────────────────────────────
  const aiOpts: AiFnOptions = {};
  if (body?.deployment && typeof body.deployment === 'string') aiOpts.deployment = body.deployment.trim();
  if (typeof body?.reasoningEffort === 'string' && ['minimal', 'low', 'medium', 'high'].includes(body.reasoningEffort)) {
    aiOpts.reasoningEffort = body.reasoningEffort;
  }
  aiOpts.tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);

  const enrichOne = makeEnrichOne(op, eopts, aiOpts);
  try {
    const batch = await runAoaiEnrichment(inputs, enrichOne, { concurrency, maxAttempts: 2 });
    if (batch.succeeded === 0 && batch.failed > 0) {
      const first = batch.results.find((r) => r.error)?.error || 'all preview rows failed';
      // Surface an honest gate when AOAI simply isn't configured.
      if (/not configured|No AOAI deployment|LOOM_AOAI/i.test(first)) {
        return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: first, hint: GATE_HINT }, { status: 501 });
      }
      return NextResponse.json({ ok: false, error: first }, { status: 502 });
    }

    const avg = avgTokensPerRow(batch.results.map((r) => r.usage));
    const totalRows = Math.max(0, Math.min(MAX_AOAI_ROWS * 100, Math.floor(Number(body?.totalRows) || 0)));
    const estimate = totalRows > 0 && avg > 0 ? estimateEnrichmentCost({ rowCount: totalRows, avgTokensPerRow: avg }) : null;

    return NextResponse.json({
      ok: true,
      engine: 'aoai',
      model: batch.results.find((r) => r.model)?.model,
      rows: batch.results.map((r) => ({ input: r.input, output: r.output, error: r.error })),
      sampled: batch.total,
      succeeded: batch.succeeded,
      failed: batch.failed,
      avgTokensPerRow: Math.round(avg),
      sampleTokens: batch.usage.totalTokens,
      estimate,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: e.message, hint: GATE_HINT }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
