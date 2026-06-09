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
 * Three modes, all grounded in the LIVE warehouse schema so generated SQL
 * references real tables/columns:
 *   - generate : NL description           → a single runnable SQL statement
 *   - explain  : a SQL query              → a plain-language summary
 *   - fix      : a SQL query + error text → a corrected SQL query
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
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { cogScope } from '@/lib/azure/cloud-endpoints';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
} from '@/lib/azure/synapse-sql-client';
import { executeStatement } from '@/lib/azure/databricks-client';

type AssistMode = 'generate' | 'explain' | 'fix';
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

// ---------- Credential (identical pattern to copilot-orchestrator) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// cogScope() is the cloud-aware AOAI `.default` scope (cognitiveservices.azure.com
// in Commercial/GCC, cognitiveservices.azure.us in Gov) — single source of truth.
async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
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
        WHERE table_schema = '${schema.replace(/'/g, "''")}'
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

// ---------- Per-mode system + user messages ----------
function buildMessages(
  mode: AssistMode,
  dialect: string,
  sqlText: string,
  prompt: string,
  errorText: string,
  schema: string,
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
  if (!mode || !['generate', 'explain', 'fix'].includes(mode)) {
    return NextResponse.json(
      { ok: false, error: 'mode must be generate | explain | fix' },
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
  if ((mode === 'explain' || mode === 'fix') && !sqlText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'sql is required for explain/fix modes' },
      { status: 400 },
    );
  }
  if (mode === 'fix' && !errorText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'errorText is required for fix mode' },
      { status: 400 },
    );
  }

  // Resolve AOAI target — same resolution order as the cross-item Copilot.
  let target;
  try {
    target = await resolveAoaiTarget();
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

  const dialect = dialectFor(engine);
  const messages = buildMessages(mode, dialect, sqlText, prompt, errorText, schema);

  try {
    const token = await aoaiToken();
    const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
    const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(
      target.deployment,
    )}/chat/completions?api-version=${apiVersion}`;

    const callWithTemperature = (temp?: number) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          ...(temp !== undefined ? { temperature: temp } : {}),
          max_tokens: 2048,
        }),
      });

    let res = await callWithTemperature(0.2);
    if (res.status === 400) {
      const txt = await res.text();
      // Reasoning models (o1/o3/gpt-5/MAI-*) reject non-default temperature — retry once.
      if (
        /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(txt) &&
        /temperature|top_p/i.test(txt)
      ) {
        res = await callWithTemperature(undefined);
      } else {
        return NextResponse.json(
          { ok: false, error: `AOAI 400: ${txt.slice(0, 300)}` },
          { status: 502 },
        );
      }
    }
    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json(
        { ok: false, error: `AOAI ${res.status}: ${txt.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const j = await res.json();
    const raw: string = j?.choices?.[0]?.message?.content ?? '';
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
