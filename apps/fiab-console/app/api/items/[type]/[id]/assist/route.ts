/**
 * Warehouse Copilot edge — inline NL→SQL + explain + fix for the SQL warehouse
 * family editors (Warehouse / Synapse Dedicated / Synapse Serverless /
 * Databricks SQL warehouse), powered by the SAME Loom build-assist AOAI
 * deployment the cross-item Copilot and the KQL Queryset assist edge use
 * (resolveAoaiTarget). NO Fabric Copilot dependency: the chat model is the AI
 * Foundry project (`aifndry-loom-<location>`, `chat` deployment) provisioned by
 * platform/fiab/bicep/modules/ai/foundry-project.bicep and wired into
 * admin-plane/main.bicep as LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.
 *
 * Routed under the existing dynamic `[type]` segment so it sits alongside the
 * other shared item routes (access-mode, audit, sql-security, …). `[type]` is
 * the engine and is validated against the SQL-warehouse allow-list below — any
 * other item type 400s.
 *
 * Five modes, all grounded in the LIVE warehouse schema so generated SQL
 * references real tables/columns:
 *   - generate : NL description           → a single runnable SQL statement
 *   - explain  : a SQL query              → a plain-language summary
 *   - fix      : a SQL query + error text → a corrected SQL query
 *   - comments : a SQL query              → the same SQL with inline comments
 *   - optimize : a SQL query              → a rewritten, faster SQL query, with a
 *                                           REAL EXPLAIN plan folded into the
 *                                           prompt where the engine exposes one
 *                                           (SET SHOWPLAN_TEXT for Synapse T-SQL,
 *                                           EXPLAIN for Databricks Spark SQL).
 *
 * These five modes are the SQL-warehouse surface of the Loom slash commands
 * (/explain /fix /comments /optimize) — see lib/copilot/slash-commands.ts and
 * lib/azure/copilot-personas.ts (persona 'sql-warehouse').
 *
 * Real backend (per no-vaporware.md): every call hits AOAI chat-completions
 * with an AAD bearer (cognitiveservices scope) — no mocks, no canned strings.
 * Schema grounding hits the real Synapse `sys.columns` DMV (or Databricks
 * SHOW TABLES) — soft-fail so the route still works on a cold/empty database.
 * The generated SQL runs against the real backend via the existing /query
 * route (executeQuery). When AOAI is not configured the route returns an honest
 * 503 `code:'no_aoai'` gate naming the exact env vars to set; the editor
 * surfaces it in a Fluent MessageBar and stays fully functional for manual
 * authoring + Run.
 *
 * Azure-native by default (per no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. No Fabric / Power BI host is contacted.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
} from '@/lib/azure/synapse-sql-client';
import { executeStatement } from '@/lib/azure/databricks-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

type AssistMode = 'generate' | 'explain' | 'fix' | 'comments' | 'optimize';
type Engine =
  | 'warehouse'
  | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool'
  | 'databricks-sql-warehouse';

const ENGINES: Engine[] = [
  'warehouse',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
  'databricks-sql-warehouse',
];

const MAX_INPUT = 64 * 1024; // 64KB per string field

function dialectFor(engine: Engine): string {
  switch (engine) {
    case 'databricks-sql-warehouse':
      return 'Spark SQL (Databricks)';
    case 'synapse-serverless-sql-pool':
      return 'T-SQL (Synapse Serverless)';
    case 'warehouse':
    case 'synapse-dedicated-sql-pool':
    default:
      return 'T-SQL';
  }
}

// ---------- Schema grounding (soft-fail, never blocks) ----------
// Synapse (Dedicated / Serverless): one DMV round-trip returns the columns of
// every user table. Trim the rendered schema so the system prompt stays budgeted.
const SYNAPSE_SCHEMA_SQL = `SELECT TOP 400
  s.name + '.' + t.name AS table_name,
  c.name                AS column_name,
  tp.name               AS type_name,
  c.max_length          AS max_length,
  c.is_nullable         AS is_nullable
FROM sys.columns c
JOIN sys.tables  t  ON t.object_id = c.object_id
JOIN sys.schemas s  ON s.schema_id = t.schema_id
JOIN sys.types   tp ON tp.user_type_id = c.user_type_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id`;

async function synapseSchemaContext(serverless: boolean, db: string): Promise<string> {
  try {
    const target = serverless ? serverlessTarget(db || 'master') : dedicatedTarget();
    const res = await executeQuery(target, SYNAPSE_SCHEMA_SQL, 30_000);
    if (!res.rows.length) return '';
    // Group columns per table into compact `schema.table(col type, …)` lines.
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      const [table, col, type] = row as [string, string, string];
      const cols = byTable.get(table) || [];
      cols.push(`${col} ${type}`);
      byTable.set(table, cols);
    }
    const lines = [...byTable.entries()].map(([t, cols]) => `${t}(${cols.join(', ')})`);
    const str = lines.join('\n');
    return str.length > 8000 ? `${str.slice(0, 8000)}\n…(schema truncated)` : str;
  } catch {
    // Pool paused / DB not granted / no tables — grounding is optional.
    return '';
  }
}

async function databricksSchemaContext(
  warehouseId: string,
  catalog: string,
  schema: string,
): Promise<string> {
  if (!warehouseId || !catalog || !schema) return '';
  try {
    // INFORMATION_SCHEMA gives column-level grounding when the warehouse is
    // running; soft-fail to '' otherwise.
    const res = await executeStatement(
      warehouseId,
      `SELECT table_name, column_name, data_type
         FROM \`${catalog}\`.information_schema.columns
        WHERE table_schema = '${escapeSqlLiteral(schema)}'
        ORDER BY table_name, ordinal_position
        LIMIT 400`,
    );
    if (!res.rows.length) return '';
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      const [table, col, type] = row as [string, string, string];
      const cols = byTable.get(String(table)) || [];
      cols.push(`${col} ${type}`);
      byTable.set(String(table), cols);
    }
    const lines = [...byTable.entries()].map(
      ([t, cols]) => `${catalog}.${schema}.${t}(${cols.join(', ')})`,
    );
    const str = lines.join('\n');
    return str.length > 8000 ? `${str.slice(0, 8000)}\n…(schema truncated)` : str;
  } catch {
    return '';
  }
}

// ---------- EXPLAIN plan grounding for /optimize (soft-fail, never blocks) ----------
// A real query plan lets the model target the ACTUAL operators (scans, joins,
// shuffles) instead of guessing. Synapse SQL exposes the estimated plan via
// SET SHOWPLAN_TEXT ON (the same mechanism SQL Server documents); Databricks
// Spark SQL exposes it via EXPLAIN. Both are best-effort with a short timeout —
// a paused pool / cold warehouse / parse error just yields '' and /optimize
// still rewrites the SQL from the schema alone.
async function synapseExplainPlan(serverless: boolean, db: string, sqlText: string): Promise<string> {
  const stmt = sqlText.trim().replace(/;+\s*$/, '');
  if (!stmt) return '';
  try {
    const target = serverless ? serverlessTarget(db || 'master') : dedicatedTarget();
    // SHOWPLAN_TEXT returns the estimated plan as rows of StmtText; the batch
    // must contain only the wrapped statement (no extra batches).
    const res = await executeQuery(
      target,
      `SET SHOWPLAN_TEXT ON;\nGO\n${stmt};\nGO\nSET SHOWPLAN_TEXT OFF;`,
      10_000,
    );
    const lines = res.rows
      .map((r) => (Array.isArray(r) ? String(r[0] ?? '') : ''))
      .filter((t) => t.trim());
    const plan = lines.join('\n').trim();
    return plan.length > 4000 ? `${plan.slice(0, 4000)}\n…(plan truncated)` : plan;
  } catch {
    return '';
  }
}

async function databricksExplainPlan(
  warehouseId: string,
  catalog: string,
  schema: string,
  sqlText: string,
): Promise<string> {
  const stmt = sqlText.trim().replace(/;+\s*$/, '');
  if (!warehouseId || !stmt) return '';
  try {
    const res = await executeStatement(warehouseId, `EXPLAIN ${stmt}`, catalog || undefined, schema || undefined);
    const plan = res.rows
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')).join(' ') : String(r ?? '')))
      .join('\n')
      .trim();
    return plan.length > 4000 ? `${plan.slice(0, 4000)}\n…(plan truncated)` : plan;
  } catch {
    return '';
  }
}

// ---------- Per-mode system + user messages ----------
function buildMessages(
  mode: AssistMode,
  dialect: string,
  sqlText: string,
  prompt: string,
  errorText: string,
  schema: string,
  explainPlan = '',
): { role: 'system' | 'user'; content: string }[] {
  const schemaSection = schema.trim()
    ? `\n\nWarehouse schema (ground your SQL in these tables/columns, do not invent names):\n${schema}`
    : '';

  if (mode === 'generate') {
    return [
      {
        role: 'system',
        content:
          `You are a ${dialect} query generator for the CSA Loom platform. Given a ` +
          `natural-language description and the warehouse schema, write idiomatic, ` +
          `runnable ${dialect} for a SINGLE statement. Return ONLY the SQL — no markdown ` +
          `fences, no commentary, no leading language tag.` +
          schemaSection,
      },
      {
        role: 'user',
        content: prompt || 'Show the first 100 rows from any available table.',
      },
    ];
  }
  if (mode === 'explain') {
    return [
      {
        role: 'system',
        content:
          `You are a SQL assistant for the CSA Loom platform. Explain what the following ` +
          `${dialect} query does in 3-5 concise sentences. Reference the actual tables and ` +
          `columns, the filters / joins / aggregations applied, and the business intent. ` +
          `Plain prose, no code fences.` +
          schemaSection,
      },
      { role: 'user', content: `${dialect} query:\n\`\`\`\n${sqlText}\n\`\`\`` },
    ];
  }
  if (mode === 'comments') {
    return [
      {
        role: 'system',
        content:
          `You are a ${dialect} documentation assistant for the CSA Loom platform. ` +
          `Return the SAME query, UNCHANGED in logic, with a concise inline comment ` +
          `above every non-trivial clause (CTEs, joins, filters, aggregations, window ` +
          `functions) explaining its intent. Preserve the EXACT table and column names. ` +
          `Use ${dialect} comment syntax (-- for line comments). Return ONLY the commented ` +
          `SQL — no markdown fences, no prose outside the SQL, no leading language tag.` +
          schemaSection,
      },
      { role: 'user', content: `${dialect} query:\n\`\`\`\n${sqlText}\n\`\`\`` },
    ];
  }
  if (mode === 'optimize') {
    const planSection = explainPlan.trim()
      ? `\n\nActual query plan (target these operators — scans, joins, shuffles, ` +
        `partitioning):\n${explainPlan}`
      : '';
    return [
      {
        role: 'system',
        content:
          `You are a ${dialect} performance engineer for the CSA Loom platform. Rewrite ` +
          `the query to run faster using ${dialect}-specific optimizer techniques, keeping ` +
          `the result set IDENTICAL and preserving the exact table/column names. ` +
          `For T-SQL / Synapse: prefer set-based logic, sargable predicates, the right ` +
          `JOIN order, OPTION (LABEL/HASH JOIN/MAXDOP) hints, columnstore-friendly ` +
          `projections, and avoid SELECT *, scalar UDFs and row-by-row cursors. ` +
          `For Spark SQL / Databricks: rely on Adaptive Query Execution, predicate and ` +
          `projection pushdown, Delta Z-ordering / partition pruning, broadcast-join ` +
          `hints for small dimensions, and avoid collect(), cross joins and Python UDFs. ` +
          `If a real query plan is provided, target its costly operators specifically. ` +
          `Return ONLY the rewritten SQL — no markdown fences, no commentary, no leading ` +
          `language tag.` +
          schemaSection +
          planSection,
      },
      { role: 'user', content: `${dialect} query to optimize:\n\`\`\`\n${sqlText}\n\`\`\`` },
    ];
  }
  // mode === 'fix'
  return [
    {
      role: 'system',
      content:
        `You are a SQL debugger for the CSA Loom platform. Fix the following ${dialect} ` +
        `query that produced an error. Return ONLY the corrected, runnable ${dialect} — no ` +
        `markdown fences, no explanation, no leading language tag.` +
        schemaSection,
    },
    { role: 'user', content: `${dialect} query:\n\`\`\`\n${sqlText}\n\`\`\`\n\nError:\n${errorText}` },
  ];
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> },
) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // Per-principal AOAI rate limit — opt-in (LOOM_RATE_LIMIT=on). Default = no-op
  // (returns null → identical behavior).
  const limited = await enforceRateLimit(session, 'aoai');
  if (limited) return limited;

  const { type } = await ctx.params;
  const engine = type as Engine;
  if (!ENGINES.includes(engine)) {
    return NextResponse.json(
      { ok: false, error: `assist is not available for item type '${type}'` },
      { status: 400 },
    );
  }

  const body = await _req.json().catch(() => ({}));
  const mode = body?.mode as AssistMode | undefined;
  if (!mode || !['generate', 'explain', 'fix', 'comments', 'optimize'].includes(mode)) {
    return NextResponse.json(
      { ok: false, error: 'mode must be generate | explain | fix | comments | optimize' },
      { status: 400 },
    );
  }
  const sqlText = String(body?.sql || '');
  const prompt = String(body?.prompt || '');
  const errorText = String(body?.errorText || '');
  if (
    sqlText.length > MAX_INPUT ||
    prompt.length > MAX_INPUT ||
    errorText.length > MAX_INPUT
  ) {
    return NextResponse.json({ ok: false, error: 'input too large (>64KB)' }, { status: 413 });
  }

  if (mode === 'generate' && !prompt.trim()) {
    return NextResponse.json(
      { ok: false, error: 'prompt is required for generate mode' },
      { status: 400 },
    );
  }
  if ((mode === 'explain' || mode === 'fix' || mode === 'comments' || mode === 'optimize') && !sqlText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'sql is required for explain/fix/comments/optimize modes' },
      { status: 400 },
    );
  }
  if (mode === 'fix' && !errorText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'errorText is required for fix mode' },
      { status: 400 },
    );
  }

  // Pre-resolve the AOAI target up-front to surface the honest 503 no_aoai gate
  // — same resolution order as the cross-item Copilot. The resolved target is
  // passed to aoaiChat() below so it does NOT re-resolve (one Foundry lookup
  // per call, not two).
  let aoaiTarget;
  try {
    aoaiTarget = await resolveAoaiTarget();
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT ' +
          '(deploy the AI Foundry project — platform/fiab/bicep/modules/ai/foundry-project.bicep, ' +
          'agentFoundryEnabled=true — which wires them into admin-plane/main.bicep).';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  // Schema grounding (soft-fail). Reuse a client-supplied schemaContext if the
  // editor already holds it; otherwise hit the live backend DMV.
  let schema = String(body?.schemaContext || '').slice(0, 8000);
  if (!schema) {
    if (engine === 'databricks-sql-warehouse') {
      schema = await databricksSchemaContext(
        String(body?.warehouseId || ''),
        String(body?.catalog || ''),
        String(body?.schema || ''),
      );
    } else {
      const serverless = engine === 'synapse-serverless-sql-pool';
      schema = await synapseSchemaContext(serverless, String(body?.db || body?.database || ''));
    }
  }

  // For /optimize, fetch a real EXPLAIN plan to ground the rewrite (soft-fail).
  let explainPlan = '';
  if (mode === 'optimize') {
    if (engine === 'databricks-sql-warehouse') {
      explainPlan = await databricksExplainPlan(
        String(body?.warehouseId || ''),
        String(body?.catalog || ''),
        String(body?.schema || ''),
        sqlText,
      );
    } else {
      const serverless = engine === 'synapse-serverless-sql-pool';
      explainPlan = await synapseExplainPlan(serverless, String(body?.db || body?.database || ''), sqlText);
    }
  }

  const dialect = dialectFor(engine);
  const messages = buildMessages(mode, dialect, sqlText, prompt, errorText, schema, explainPlan);

  try {
    // Unified AOAI client: same target resolution (cfg=null → env/discovery),
    // same cogScope token, same max_completion_tokens cap (2048), same
    // temperature (0.2) + reasoning-model temperature-only retry.
    const raw = await aoaiChat({ messages, maxCompletionTokens: 2048, temperature: 0.2, target: aoaiTarget });
    // Strip any stray ```sql / ```tsql fences the model may add despite instructions.
    const result =
      mode === 'explain'
        ? raw.trim()
        : raw
            .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
            .replace(/\n?```\s*$/, '')
            .trim();
    return NextResponse.json({ ok: true, result, mode, engine });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
