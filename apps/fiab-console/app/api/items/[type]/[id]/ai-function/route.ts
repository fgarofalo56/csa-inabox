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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  databricksConfigGate,
  executeStatement,
  getWarehouse,
} from '@/lib/azure/databricks-client';
import {
  callAiFn,
  NoAoaiDeploymentError,
  isAiFn,
  AI_FN_NAMES,
  type AiFn,
  type AiFnOptions,
} from '@/lib/azure/ai-functions-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

/** Map a Loom AiFn → the Databricks built-in AI SQL expression over a column. */
const DBX_FN: Record<AiFn, (col: string, o: AiFnOptions) => string> = {
  sentiment: (col) => `ai_analyze_sentiment(${col})`,
  summarize: (col) => `ai_summarize(${col})`,
  classify: (col, o) =>
    `ai_classify(${col}, ARRAY(${(o.labels && o.labels.length ? o.labels : ['positive', 'negative', 'neutral'])
      .map((l) => `'${String(l).replace(/'/g, "''")}'`)
      .join(', ')}))`,
  translate: (col, o) =>
    `ai_translate(${col}, '${String(o.targetLang || 'English').replace(/'/g, "''")}')`,
  extract: (col, o) =>
    `ai_extract(${col}, ARRAY(${(o.fields && o.fields.length ? o.fields : ['entity'])
      .map((f) => `'${String(f).replace(/'/g, "''")}'`)
      .join(', ')}))`,
};

function parseOptions(o: unknown): AiFnOptions {
  const opts: AiFnOptions = {};
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    if (Array.isArray(obj.labels)) opts.labels = obj.labels.map((x) => String(x)).filter(Boolean);
    if (Array.isArray(obj.fields)) opts.fields = obj.fields.map((x) => String(x)).filter(Boolean);
    if (typeof obj.targetLang === 'string' && obj.targetLang.trim()) opts.targetLang = obj.targetLang.trim();
    if (typeof obj.maxTokens === 'number' && obj.maxTokens > 0) opts.maxTokens = obj.maxTokens;
  }
  return opts;
}

const GATE_HINT =
  'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (admin-plane/main.bicep — enable aiFoundryEnabled or agentFoundryEnabled, or pass explicit overrides) and grant the Console UAMI "Cognitive Services OpenAI User".';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> },
) {
  const { type } = await ctx.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> },
) {
  await ctx.params; // [type]/[id] carried for item scoping; backend keys off body
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
  if (!govPath && warehouseId && databricksConfigGate() === null) {
    if (!IDENT_RE.test(column) || (table && !IDENT_RE.test(table))) {
      return NextResponse.json(
        { ok: false, error: 'column / table must be plain SQL identifiers (no spaces or punctuation other than "." and backticks).' },
        { status: 400 },
      );
    }
    if (!table) {
      return NextResponse.json({ ok: false, error: 'table required for the Databricks SQL path' }, { status: 400 });
    }
    // Verify the warehouse is RUNNING (honest 409 if not — never a silent fail).
    const wh = await getWarehouse(warehouseId).catch(() => null);
    if (wh && wh.state && wh.state !== 'RUNNING') {
      return NextResponse.json(
        { ok: false, error: `Warehouse is ${wh.state}. Start it before running an AI function.`, state: wh.state },
        { status: 409 },
      );
    }
    const colExpr = quoteIdent(column);
    const tableExpr = table.includes('`') || table.includes('.') ? table : quoteIdent(table);
    const sql = `SELECT ${colExpr}, ${DBX_FN[fn](colExpr, opts)} AS ai_result FROM ${tableExpr} LIMIT ${limit}`;
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
    const { result, model, usage } = await callAiFn(fn, input, opts);
    return NextResponse.json({ ok: true, engine: 'aoai', fn, column, input, result, model, usage });
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
}
