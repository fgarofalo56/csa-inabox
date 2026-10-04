/**
 * AI functions in T-SQL / Spark SQL — item-scoped BFF route.
 *
 * Brings Fabric's "AI functions" (sentiment · classify · translate · summarize ·
 * extract) to a SQL surface, Azure-native and with NO Microsoft Fabric / Power
 * BI dependency (per .claude/rules/no-fabric-dependency.md).
 *
 * Two real backends, picked by cloud boundary + available compute:
 *
 *   • Commercial / GCC + a Databricks SQL Warehouse  →  the result is computed
 *     IN-DATABASE by Databricks' built-in AI SQL functions
 *     (ai_analyze_sentiment / ai_classify / ai_summarize / ai_translate /
 *     ai_extract — the ai_query() family) executed over the live warehouse with
 *     executeStatement(). Real enriched rows come back.
 *
 *   • GCC-High / IL5 / IL6 (isGovCloud), or any boundary without a Databricks
 *     warehouse  →  the AOAI-direct substitute: callAiFn() runs the same five
 *     enrichments against the live Azure OpenAI gpt-4o-class deployment the
 *     Copilot / data-agent resolve (sovereign-aware audience + endpoint suffix
 *     via cogScope() / getOpenAiSuffix()).
 *
 *   • Gov boundary with NO AOAI deployed  →  honest gate
 *     { ok:false, code:'not_configured', gated:true } so the helper shows the
 *     MessageBar (env var to set), never a crash.
 *
 *   GET  ?probe=1
 *        → { ok, engine, govPath, dbxAvailable, gated, code?, hint? }
 *
 *   POST { fn, column, table?, warehouseId?, catalog?, schema?, input?,
 *          limit?, options?:{ labels?, fields?, targetLang?, maxTokens? } }
 *        Databricks path  → { ok, engine:'databricks', sql, columns, rows, rowCount, executionMs }
 *        AOAI path        → { ok, engine:'aoai', fn, column, input, result, model, usage }
 *
 * WAREHOUSE ACCESS (#3669). On the Databricks path the caller names
 * `warehouseId`. The route runs on it only when its live `loom_item_id` tag links
 * it to a SQL warehouse item in a workspace the caller can read (any workspace
 * role); a warehouse with no link is open to tenant admins only. Every other case
 * is a 404 with `code: 'warehouse_not_available'` and a remediation, and a
 * Databricks/Cosmos read failure is a 502 with `code: 'warehouse_unverifiable'` —
 * nothing runs on either. The Gov boundaries never reach this path: they use the
 * AOAI substitute, which takes no warehouse.
 *
 * THE DEPLOYMENT-SHARED WAREHOUSE STAYS ADMIN-ONLY. `loom-default` (and
 * `loom-gov-default`, and whatever `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` names) is
 * created by the bootstrap, carries no item link, and is never linked to one —
 * neither the editor's self-heal nor the admin "Link to this item" action will
 * tag it (`isDeploymentSharedWarehouse`). So it is runnable here by tenant admins
 * only. A non-admin sent here with it gets the 404 + remediation above, and the
 * SQL warehouse editor's AI functions panel offers "Use Azure OpenAI instead",
 * which re-sends the call WITHOUT `warehouseId` and takes the AOAI path below.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  databricksConfigGate,
  executeStatement,
} from '@/lib/azure/databricks-client';
import {
  callAiFn,
  callAiFnBatch,
  emitAiFnUsage,
  NoAoaiDeploymentError,
  isAiFn,
  AI_FN_NAMES,
  type AiFn,
  type AiFnOptions,
} from '@/lib/azure/ai-functions-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { buildAiSqlExpr, isEnrichmentOp, opHasDbxBuiltin } from '@/lib/azure/ai-enrichment-client';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '@/app/api/items/_lib/synapse-item-scope';
import { authorizeWarehouseTarget } from '../../../_lib/warehouse-item-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST is ITEM-SCOPED: the caller must hold a role on the `[type]/[id]` item's
 * workspace (read roles admitted: the statement is a fixed `SELECT ai_*(col)`
 * over identifier-validated input, and the AOAI paths send text to the model;
 * neither writes). `guardSynapseItemRequest` is the guard the sibling
 * `databricks-sql-warehouse/[id]/query` runs; it fails CLOSED on an id that
 * names no item of `[type]` and on a Cosmos error, and refuses with 404 (not
 * 403) so a foreign item's existence is not disclosed.
 *
 * On the Databricks path, `warehouseId`, `table`, `catalog` and `schema` are
 * read from the request body, as on the sibling `query` route; the warehouse
 * named there is a SEPARATE authorization from the route's own `[type]/[id]`
 * item above — see WAREHOUSE ACCESS in the file header. Both checks must pass:
 * the caller needs a role on the route's own item AND the named warehouse must
 * be linked to a SQL warehouse item the caller can read (or be a tenant admin).
 *
 * GET stays session-only: it returns the static function list and env-derived
 * capability flags, reads no item data, and is allowlisted on that basis in
 * `scripts/ci/check-route-guards.mjs`.
 */
const ITEM_UNREACHABLE =
  'This item is not available to you. Either it does not exist, or you have no role in its ' +
  'workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item gate: the helper can mount on `/items/<type>/new`, and the
 * guard rightly refuses an id naming no item. 200 with `code:'unsaved_item'`,
 * which the helper (`ai-functions-helper.tsx`) renders as a warning titled
 * "Save this item first" rather than as a failed run. Matched EXACTLY: real
 * ids are UUIDs, so a prefix test would let a real id skip the guard.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error: 'AI functions run in the name of a saved item.',
  }, { status: 200 });
}

/**
 * SQL identifier safety. Columns / tables flow into a Databricks SQL statement,
 * so we allow ONLY identifier-shaped tokens (letters, digits, underscore, dot
 * for catalog.schema.table, and backticks the caller may already have applied).
 * Anything else is rejected — there is no raw-SQL passthrough on this route.
 */
const IDENT_RE = /^[A-Za-z0-9_.`]+$/;

/** Backtick-quote a bare identifier (leave already-backticked input alone). */
function quoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.includes('`')) return t; // caller pre-quoted (e.g. `cat`.`sch`.`tbl`)
  return `\`${t}\``;
}

/**
 * Map a Loom AiFn → the Databricks built-in AI SQL expression over a column.
 * PARTIAL: only the functions with a direct `ai_*` SQL builtin are in-database.
 * `embed` / `similarity` have no simple column builtin, so they always take the
 * AOAI-direct path (below) — this returns null for them and the caller falls
 * through.
 *
 * The expression comes from `buildAiSqlExpr` (lib/azure/ai-enrichment-client),
 * the one implementation shared with the AI enrichment item, so labels, fields
 * and the target language are escaped by the same pinned Spark SQL rule.
 */
function dbxExpr(fn: AiFn, col: string, o: AiFnOptions): string | null {
  if (!isEnrichmentOp(fn) || !opHasDbxBuiltin(fn)) return null;
  return buildAiSqlExpr(fn, col, { labels: o.labels, fields: o.fields, targetLang: o.targetLang });
}

function parseOptions(o: unknown): AiFnOptions {
  const opts: AiFnOptions = {};
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    if (Array.isArray(obj.labels)) opts.labels = obj.labels.map((x) => String(x)).filter(Boolean);
    if (Array.isArray(obj.fields)) opts.fields = obj.fields.map((x) => String(x)).filter(Boolean);
    if (typeof obj.targetLang === 'string' && obj.targetLang.trim()) opts.targetLang = obj.targetLang.trim();
    if (typeof obj.maxTokens === 'number' && obj.maxTokens > 0) opts.maxTokens = obj.maxTokens;
    if (typeof obj.compareTo === 'string' && obj.compareTo.trim()) opts.compareTo = obj.compareTo.trim();
    if (typeof obj.embeddingDeployment === 'string' && obj.embeddingDeployment.trim())
      opts.embeddingDeployment = obj.embeddingDeployment.trim();
    // FGC-19 model-tier: explicit chat deployment (Advanced tier) + reasoning-effort.
    if (typeof obj.deployment === 'string' && obj.deployment.trim()) opts.deployment = obj.deployment.trim();
    if (
      typeof obj.reasoningEffort === 'string' &&
      ['minimal', 'low', 'medium', 'high'].includes(obj.reasoningEffort)
    ) {
      opts.reasoningEffort = obj.reasoningEffort as 'minimal' | 'low' | 'medium' | 'high';
    }
  }
  return opts;
}

const GATE_HINT =
  'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (admin-plane/main.bicep — enable aiFoundryEnabled or agentFoundryEnabled, or pass explicit overrides) and grant the Console UAMI "Cognitive Services OpenAI User".';

export const GET = withSession<{ type: string; id: string }>(async (_req: NextRequest, { params }) => {
  const { type } = params;

  const govPath = isGovCloud();
  const dbxAvailable = !govPath && databricksConfigGate() === null;
  // On a Gov boundary the only enrichment path is AOAI; if it's not wired we
  // gate. On Commercial/GCC the Databricks warehouse is the default path, so a
  // missing AOAI is fine (not gated).
  const gated = govPath && !process.env.LOOM_AOAI_ENDPOINT;

  return NextResponse.json({
    ok: !gated,
    engine: type,
    fns: AI_FN_NAMES,
    govPath,
    dbxAvailable,
    gated,
    code: gated ? 'not_configured' : undefined,
    missing: gated ? 'LOOM_AOAI_ENDPOINT' : undefined,
    hint: gated ? GATE_HINT : undefined,
  });
});

export const POST = withSession<{ type: string; id: string }>(async (req: NextRequest, { params }) => {
  // Authentication is the wrapper's (above this line), so the unsaved-item gate
  // below cannot answer a request that carries no session.
  if (params.id === UNSAVED_ITEM_ID) return unsavedItemGate();
  const guard = await guardSynapseItemRequest({
    itemId: params.id,
    itemType: params.type,
    allowReadRoles: true,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;
  // Consumed, so deleting the `if (guard.res)` line is a type error rather than
  // a silent pass (the same reasoning as the sibling `query` route).
  const { session } = guard.ctx;
  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const fn = typeof body?.fn === 'string' ? body.fn.trim() : '';
  if (!isAiFn(fn)) {
    return NextResponse.json(
      { ok: false, error: `Invalid fn "${fn}". Must be one of: ${AI_FN_NAMES.join(', ')}.` },
      { status: 400 },
    );
  }

  const column = typeof body?.column === 'string' ? body.column.trim() : '';
  if (!column) {
    return NextResponse.json({ ok: false, error: 'column required' }, { status: 400 });
  }

  const opts = parseOptions(body?.options);
  const govPath = isGovCloud();
  const warehouseId = typeof body?.warehouseId === 'string' ? body.warehouseId.trim() : '';
  const table = typeof body?.table === 'string' ? body.table.trim() : '';
  const catalog = typeof body?.catalog === 'string' && body.catalog.trim() ? body.catalog.trim() : undefined;
  const schema = typeof body?.schema === 'string' && body.schema.trim() ? body.schema.trim() : undefined;
  const limit = Number.isFinite(body?.limit) && body.limit > 0 ? Math.min(Math.floor(body.limit), 1000) : 50;

  // ---------- Commercial / GCC + Databricks SQL warehouse: in-database ----------
  // Only functions with a direct `ai_*` SQL builtin run in-database; embed /
  // similarity have no column builtin and fall through to the AOAI path below.
  const hasDbxBuiltin = isEnrichmentOp(fn) && opHasDbxBuiltin(fn);
  if (!govPath && warehouseId && hasDbxBuiltin && databricksConfigGate() === null) {
    if (!IDENT_RE.test(column) || (table && !IDENT_RE.test(table))) {
      return NextResponse.json(
        { ok: false, error: 'column / table must be plain SQL identifiers (no spaces or punctuation other than "." and backticks).' },
        { status: 400 },
      );
    }
    if (!table) {
      return NextResponse.json({ ok: false, error: 'table required for the Databricks SQL path' }, { status: 400 });
    }
    // #3669 — the warehouse must be linked (its live `loom_item_id` tag) to a SQL
    // warehouse item in a workspace the caller can read; an unlinked warehouse is
    // for tenant admins only. See `_lib/warehouse-item-binding.ts`.
    const target = await authorizeWarehouseTarget(session, warehouseId);
    if (!target.ok) return target.res;
    // Verify the warehouse is RUNNING (honest 409 if not — never a silent fail).
    const wh = target.warehouse;
    if (wh.state && wh.state !== 'RUNNING') {
      return NextResponse.json(
        { ok: false, error: `Warehouse is ${wh.state}. Start it before running an AI function.`, state: wh.state },
        { status: 409 },
      );
    }
    const colExpr = quoteIdent(column);
    const tableExpr = table.includes('`') || table.includes('.') ? table : quoteIdent(table);
    // Labels / fields / target language become Databricks string literals
    // (Spark SQL grammar), escaped inside buildAiSqlExpr.
    const sql = `SELECT ${colExpr}, ${dbxExpr(fn, colExpr, opts)} AS ai_result FROM ${tableExpr} LIMIT ${limit}`;
    try {
      const result = await executeStatement(warehouseId, sql, catalog, schema);
      return NextResponse.json({ ok: true, engine: 'databricks', fn, column, sql, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, engine: 'databricks', sql, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ---------- AOAI-direct substitute (Gov boundary, or no warehouse) ----------
  if (govPath && !process.env.LOOM_AOAI_ENDPOINT) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        gated: true,
        engine: 'aoai',
        error: 'Azure OpenAI is not configured for this boundary (LOOM_AOAI_ENDPOINT unset).',
        missing: 'LOOM_AOAI_ENDPOINT',
        hint: GATE_HINT,
      },
      { status: 501 },
    );
  }

  // Honor the admin-picked tenant Copilot deployment for BOTH the single and
  // batch AOAI paths (loaded once).
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);

  // ---------- AOAI batch (per-column apply over N sampled rows) ----------
  // The Data Wrangler "AI assist" tab and any table/DataFrame surface pass an
  // `inputs` array to enrich a whole column in one call. Each row is a real
  // callAiFn round-trip (bounded concurrency); a per-row failure is captured on
  // that row and never aborts the batch. One aggregate usage receipt is emitted.
  if (Array.isArray(body?.inputs)) {
    const rawInputs: string[] = body.inputs
      .slice(0, 200)
      .map((v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)));
    if (!rawInputs.length) {
      return NextResponse.json({ ok: false, error: 'inputs array is empty.' }, { status: 400 });
    }
    try {
      opts.tenantConfig = tenantConfig;
      const batch = await callAiFnBatch(fn, rawInputs, opts);
      await emitAiFnUsage(fn, batch.usage, batch.model, session.claims.oid);
      return NextResponse.json({
        ok: true,
        engine: 'aoai',
        mode: 'batch',
        fn,
        column,
        rows: batch.rows,
        rowCount: batch.rows.length,
        failed: batch.failed,
        model: batch.model,
        usage: batch.usage,
      });
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) {
        return NextResponse.json(
          { ok: false, code: 'not_configured', gated: true, engine: 'aoai', error: e.message, missing: 'LOOM_AOAI_DEPLOYMENT', hint: GATE_HINT },
          { status: 501 },
        );
      }
      return NextResponse.json({ ok: false, engine: 'aoai', error: e?.message || String(e) }, { status: 502 });
    }
  }

  // The AOAI path enriches one real text value (the column's sample cell). The
  // helper supplies it; this mirrors the plain-text /api/ai-functions route.
  const input = typeof body?.input === 'string' ? body.input.trim() : '';
  if (!input) {
    return NextResponse.json(
      { ok: false, error: 'input required for the AOAI path (a sample value from the chosen column).' },
      { status: 400 },
    );
  }

  try {
    // Honor the admin-picked tenant Copilot deployment (Admin → Tenant
    // settings → Copilot & Agents) so a configured Foundry chat model is used
    // even when the LOOM_AOAI_* env vars are unset. Forwarded to
    // resolveAoaiTarget by callAiFn via opts.tenantConfig (loaded once above).
    opts.tenantConfig = tenantConfig;
    const { result, model, usage, vector, similarity } = await callAiFn(fn, input, opts);
    // Per-call token/cost receipt → App Insights (persona `ai-function`) so the
    // usage-chargeback + copilot-usage admin panels meter it. Awaited so the
    // event flushes before the serverless invocation can freeze; never throws.
    await emitAiFnUsage(fn, usage, model, session.claims.oid);
    return NextResponse.json({ ok: true, engine: 'aoai', fn, column, input, result, model, usage, vector, similarity });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          gated: true,
          engine: 'aoai',
          error: e.message,
          missing: 'LOOM_AOAI_DEPLOYMENT',
          hint: GATE_HINT,
        },
        { status: 501 },
      );
    }
    return NextResponse.json({ ok: false, engine: 'aoai', error: e?.message || String(e) }, { status: 502 });
  }
});
