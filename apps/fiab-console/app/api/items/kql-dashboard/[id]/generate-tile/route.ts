/**
 * POST /api/items/kql-dashboard/[id]/generate-tile
 *
 * AI tile generator for the Real-Time Dashboard (NL → KQL). Describe a
 * visualization in natural language; an Azure OpenAI chat model (resolved via
 * the same tenant-config → env → Foundry-discovery precedence the Copilot uses)
 * generates `{ title, kql, viz }` grounded in the LIVE ADX database schema, and
 * the route VALIDATES the KQL by executing it against the real cluster before
 * returning the ready-to-insert tile (with its first-page result inlined).
 *
 * Parity: Fabric Real-Time Dashboard "Copilot — add a tile" / "Auto generate a
 * tile from a question" (https://learn.microsoft.com/fabric/fundamentals/copilot-real-time-intelligence).
 * Azure-native — ZERO Fabric/Power BI REST on this path. The model only sees
 * the ADX schema and writes ADX KQL; execution is the same `executeQuery` the
 * /run route uses.
 *
 * Body:
 *   { prompt: string,            // the natural-language ask (required)
 *     dataSourceId?: string,     // bind the new tile to a saved data source
 *     database?: string,         // explicit DB override (else resolved)
 *     timeRange?: string }       // global time key for validation run (default last-24h)
 *
 * Response (200):
 *   { ok: true,
 *     tile: { title, kql, viz, dataSourceId?, database?, w, h, result? },
 *     resolvedDatabase, validated: boolean, validationError?: string,
 *     schemaGrounded: boolean }
 *
 * Honest gates:
 *   503  AOAI deployment not configured (NoAoaiDeploymentError) — message names
 *        exactly which admin setting / env var to set.
 *   503  ADX cluster not configured (kustoConfigGate) — names LOOM_KUSTO_CLUSTER_URI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, resolveDashboardDatabase,
  executeQuery, getDatabaseSchemaJson, kustoConfigGate, listTables, KustoError,
} from '@/lib/azure/kusto-client';
import {
  aoaiCompleteJson, resolveAoaiTarget, NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { VALID_VIZ, type TileViz } from '@/lib/azure/kql-dashboard-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GeneratedTile {
  title?: string;
  kql?: string;
  viz?: string;
}

/** Sensible default grid geometry per viz, matching the manual addTile default. */
function defaultGeometry(viz: TileViz): { w: number; h: number } {
  switch (viz) {
    case 'stat': return { w: 3, h: 2 };
    case 'table': return { w: 6, h: 3 };
    case 'timechart':
    case 'line':
    case 'column':
    case 'bar': return { w: 6, h: 3 };
    case 'pie': return { w: 4, h: 3 };
    case 'map': return { w: 6, h: 4 };
    default: return { w: 4, h: 2 };
  }
}

/**
 * Compact the ADX `.show database schema as json` payload into a token-cheap
 * string the model can ground on: one line per table, `Table(col:type, …)`.
 * Caps columns/tables so a huge database doesn't blow the context budget.
 */
function summarizeSchema(schema: unknown): string {
  try {
    const dbs = (schema as any)?.Databases;
    if (!dbs || typeof dbs !== 'object') return '';
    const lines: string[] = [];
    for (const dbName of Object.keys(dbs)) {
      const tables = dbs[dbName]?.Tables;
      if (!tables || typeof tables !== 'object') continue;
      for (const tName of Object.keys(tables).slice(0, 60)) {
        const cols = tables[tName]?.OrderedColumns;
        if (!Array.isArray(cols)) { lines.push(tName); continue; }
        const colStr = cols
          .slice(0, 40)
          .map((c: any) => `${c?.Name}:${c?.CslType || c?.Type || 'string'}`)
          .join(', ');
        lines.push(`${tName}(${colStr})`);
      }
    }
    const out = lines.join('\n');
    return out.length > 8_000 ? `${out.slice(0, 8_000)}\n…(schema truncated)` : out;
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT = `You are a KQL (Kusto Query Language) expert that authors a SINGLE tile for an Azure Data Explorer Real-Time Dashboard.

Rules:
- Use ONLY the tables and columns from the provided schema. Never invent column or table names.
- Write a single tabular KQL query (no leading dot, no management commands).
- For time filtering, prefer the synthetic tokens "_startTime" and "_endTime" (the dashboard substitutes the global time range), e.g.  | where Timestamp between (_startTime .. _endTime).
- Keep the result small (use summarize / top / take). For charts, project the dimension column first and the measure column(s) after.
- Choose the best visualization "viz" for the question from EXACTLY one of:
    "stat"      single KPI number (one row, one numeric column)
    "table"     rows of data
    "timechart" time-series line (x is a datetime column)
    "line"      generic line by category
    "column"    vertical bars
    "bar"       horizontal bars
    "pie"       proportion of a whole
    "map"       points with latitude/longitude columns
- Give the tile a short human title (max 6 words).

Respond with ONLY a JSON object: {"title": string, "kql": string, "viz": string}. No prose, no markdown fences.`;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: { prompt?: string; dataSourceId?: string; database?: string; timeRange?: string } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ ok: false, error: 'prompt too long (max 2000 chars)' }, { status: 400 });
  }

  // ADX gate FIRST — without a cluster the model has no schema to ground on and
  // the validation run can't execute. Honest 503 naming the env var.
  const adxGate = kustoConfigGate();
  if (adxGate) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer is not configured (set ${adxGate.missing}). ` +
        `The AI tile generator grounds on the live ADX schema and validates the generated KQL against the cluster, ` +
        `so a deployed Eventhouse/ADX cluster is required. See platform/fiab/bicep/modules/data/adx-cluster.bicep.`,
    }, { status: 503 });
  }

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-dashboard', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    // Resolve the DB the tile will query (explicit override → bound source DB is
    // handled client-side via dataSourceId; here we resolve the dashboard DB).
    const resolvedDatabase = (body.database && body.database.trim())
      ? body.database.trim()
      : await resolveDashboardDatabase(item);

    // Tenant admin-selected Copilot config (account + chat deployment).
    const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);

    // Pre-flight AOAI so a missing deployment is an honest 503 (not a 500).
    try {
      await resolveAoaiTarget(tenantConfig);
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
      }
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }

    // Ground on the live schema (soft-fail: if it's empty the model still tries,
    // but we tell it the database name so it can use kql against known tables).
    let schemaSummary = '';
    try {
      const schema = await getDatabaseSchemaJson(resolvedDatabase);
      schemaSummary = summarizeSchema(schema);
      if (!schemaSummary) {
        // Fall back to a bare table list so the model has SOMETHING to ground on.
        const tables = await listTables(resolvedDatabase).catch(() => []);
        if (tables.length) schemaSummary = tables.map((t) => t.name).join('\n');
      }
    } catch { /* schema grounding is best-effort */ }
    const schemaGrounded = schemaSummary.length > 0;

    const userMessage =
      `Database: ${resolvedDatabase}\n\n` +
      (schemaGrounded
        ? `Schema (Table(col:type, …)):\n${schemaSummary}\n\n`
        : `(No schema could be read from the database — use only table/column names that the user mentions explicitly.)\n\n`) +
      `Question: ${prompt}`;

    const gen = await aoaiCompleteJson<GeneratedTile>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      tenantConfig,
    );

    const kql = String(gen?.kql || '').trim();
    if (!kql) {
      return NextResponse.json({ ok: false, error: 'The model did not return any KQL for that request. Try rephrasing.' }, { status: 422 });
    }
    // Reject management commands — tiles run via /v1/rest/query only.
    if (kql.trimStart().startsWith('.')) {
      return NextResponse.json({ ok: false, error: 'The model returned a management command; tiles must be tabular queries. Try rephrasing.' }, { status: 422 });
    }

    const viz: TileViz = VALID_VIZ.has(gen?.viz as TileViz) ? (gen!.viz as TileViz) : 'table';
    const title = String(gen?.title || prompt).slice(0, 200);
    const geom = defaultGeometry(viz);

    // VALIDATE: run the generated KQL against the real cluster. The dashboard
    // substitutes _startTime/_endTime; here we bind them to a 24h window so the
    // validation query is executable. A failure is reported but the tile is
    // still returned (operator can fix the KQL in the tile editor).
    const timeFrom = timeFromKey(body.timeRange);
    const runnableKql = `let _startTime = ${timeFrom};\nlet _endTime = now();\n${kql}`;
    let result: unknown | undefined;
    let validated = false;
    let validationError: string | undefined;
    try {
      result = await executeQuery(resolvedDatabase, runnableKql);
      validated = true;
    } catch (e: any) {
      validationError = e?.message || String(e);
    }

    return NextResponse.json({
      ok: true,
      tile: {
        title,
        kql,
        viz,
        dataSourceId: body.dataSourceId || undefined,
        database: body.database && body.database.trim() ? body.database.trim() : undefined,
        w: geom.w,
        h: geom.h,
        ...(validated ? { result } : {}),
      },
      resolvedDatabase,
      validated,
      validationError,
      schemaGrounded,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/** Map a global time-range key to its KQL start bound (mirror of TIME_MAP). */
function timeFromKey(key: string | undefined): string {
  const map: Record<string, string> = {
    'last-5m': 'ago(5m)', 'last-15m': 'ago(15m)', 'last-1h': 'ago(1h)',
    'last-4h': 'ago(4h)', 'last-24h': 'ago(24h)', 'last-7d': 'ago(7d)',
    'last-30d': 'ago(30d)', 'all': 'datetime(1970-01-01)',
  };
  if (!key) return map['last-24h'];
  return map[key] || 'ago(24h)';
}
