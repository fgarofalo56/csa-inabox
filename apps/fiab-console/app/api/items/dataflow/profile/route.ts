/**
 * POST /api/items/dataflow/profile  — REPORT-BUILDER PARITY · WAVE 4 (shared host)
 *
 * Column profiling for the Dataflow Gen2 `PowerQueryHost` — the SAME profiling
 * surface (`data-profiling.tsx`) the report Transform host renders, so the dialogs
 * + View-tab additions serve BOTH editors with no regression. Where the report
 * route (`/api/items/report/[id]/profile`) resolves the bound report MODEL, the
 * dataflow editor profiles the M mashup it is authoring directly: the host POSTs
 * the live `{ mScript, queryName, column? }` (no Cosmos round-trip needed — the M
 * is the single source of truth the editor already holds).
 *
 * ── How it works (the Azure-native fold the report route also runs) ───────────
 *   1. `parseSharedQueries(mScript)` → the named query's `let … in …` body (the
 *      same parser the run route and host use; default to the last query when no
 *      `queryName` is supplied).
 *   2. Resolve the query's SOURCE prefix to a REAL base relation on the bound
 *      Loom Synapse SQL endpoint:
 *        • `Sql.Database("<server>","<db>")` + a navigation step
 *          `…{[Schema="s",Item="t"]}[Data]` (or the inline one-step form, or
 *          `Sql.Databases("<server>"){[Name="db"]}…`)  → `SELECT * FROM [s].[t]`.
 *        • A native query (`Sql.Database(…,[Query="SELECT …"])` /
 *          `Value.NativeQuery(src,"SELECT …")`)         → the derived SELECT.
 *      The Synapse pool is chosen from the source server: the `-ondemand` host →
 *      serverless, the bare workspace host → the dedicated pool. A source server
 *      that is NOT the deployment's bound Synapse workspace, an inline `#table`
 *      literal, or a file / non-SQL connector (ADLS, CSV, Excel, Web, Lakehouse,
 *      Fabric/Power BI …) is NOT reachable as live SQL → an HONEST 412 gate naming
 *      the remediation ("run the dataflow to materialize the output, then profile
 *      the materialized table") — never fabricated stats.
 *   3. Fold the query's APPLIED STEPS (everything after the source prefix) onto
 *      that base via `m-script.foldAppliedStepsToSql` (DirectQuery query-folding,
 *      the identical fold the report `/query`/`/profile` routes use). A
 *      non-foldable step (parse JSON/XML, transpose, pivot, windowed fill, split,
 *      examples-heuristics …) returns the unfoldable step name → honest 412 gate
 *      ("switch this query to Import and run Refresh to materialize it via the
 *      dataflow run") instead of a silently wrong result.
 *   4. Probe the resolved/folded relation (`SELECT TOP 0 *`) for its REAL post-
 *      transform columns, then for each column (or `body.column`) run REAL
 *      aggregate SQL via `synapse-sql-client.executeQuery`:
 *        • COUNT(*)              → row count
 *        • COUNT(<col>)          → non-null count (⇒ nulls = count − non-null)
 *        • COUNT(DISTINCT <col>) → distinct values
 *        • MIN(<col>) / MAX(<col>) → range (skipped for non-orderable types)
 *        • TOP 12 … GROUP BY <col> ORDER BY COUNT(*) DESC → value distribution
 *      Identifiers come only from the structured M (column/table names, bracket-
 *      quoted) — never client free text.
 *
 * Response contract — IDENTICAL to the report profile route:
 *   200 → { ok:true, rowCount, sampled, columns:[{ name, dataType?, count,
 *           distinct, nulls, nullPct, min?, max?, distribution:[{value,count}] }] }
 *   400 → { ok:false, error }                       (bad mScript / unknown column)
 *   412 → { ok:false, code:'gate', error, missing?, unfoldableStep? }  (honest gate)
 *   502 → { ok:false, error, status }               (verbatim backend error)
 *
 * no-vaporware: every number is a real aggregate over a real Synapse relation —
 * no mock columns, no `return []`; a source we can't reach live is an honest gate.
 * no-freeform-config: the transform M was authored through `appendStep` (ribbon /
 * structured dialogs) and is FOLDED to SQL here, never hand-typed. no-fabric-
 * dependency: Synapse only — no api.fabric / api.powerbi / onelake host on any path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeQuery,
  dedicatedTarget,
  serverlessTarget,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import {
  parseSharedQueries,
  parseLetBody,
  buildLetBody,
  splitTopLevel,
  foldAppliedStepsToSql,
} from '@/lib/components/pipeline/dataflow/m-script';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Profiling runs every aggregate on the Synapse SQL family → bracket-quoted. */
const DIALECT = 'synapse' as const;

/** Per-column SQL timeout (serverless cold-start safe; verbatim 502 on overrun). */
const PROFILE_TIMEOUT_MS = 30_000;

/** TOP-N value distribution returned per column (Power Query parity). */
const DISTRIBUTION_TOP = 12;

/** Cap the all-columns sweep so a wide source doesn't fan out unboundedly. */
const MAX_PROFILE_COLUMNS = 50;

interface ProfileColumn {
  name: string;
  dataType?: string;
  /** Total rows (COUNT(*)). */
  count: number;
  /** Distinct non-null values (COUNT(DISTINCT col)). */
  distinct: number;
  /** Null values (count − COUNT(col)). */
  nulls: number;
  /** Null percentage 0–100. */
  nullPct: number;
  /** Real MIN(col) (omitted for non-orderable types). */
  min?: string | number;
  /** Real MAX(col) (omitted for non-orderable types). */
  max?: string | number;
  /** Real TOP-12 GROUP BY value distribution, busiest first. */
  distribution: Array<{ value: string; count: number }>;
}

interface ProfileBody {
  mScript?: string;
  queryName?: string;
  column?: string;
}

/** A typed JSON error response (matches the report profile route's `err`). */
function err(status: number, payload: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: false, ...payload }, { status });
}

// ── Response-value normalizers (identical contract to the report route) ─────────

/** Bracket-quote a Synapse/T-SQL identifier (structured M names only; `]` → `]]`). */
function q(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

/** Strip a trailing `;` so a base SELECT splices cleanly as a derived relation. */
function stripSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** Normalize a TDS scalar (MIN/MAX) to the response's string|number|undefined. */
function normScalar(v: unknown): string | number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Normalize a distribution bucket value to a display string ('' for null). */
function distValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Coerce a TDS count cell (number | bigint | numeric string) to a JS number. */
function asCount(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Zip a single-row QueryResult into a column-alias → value record. */
function firstRowRecord(columns: string[], rows: unknown[][]): Record<string, unknown> {
  const row = rows[0] || [];
  const rec: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    rec[c] = row[i];
  });
  return rec;
}

// ── M source-prefix parsing (pure; resolves the base relation + Synapse pool) ───

/** Parse an M string literal token `"…"` → its unescaped value, or undefined. */
function parseMStr(tok: string | undefined): string | undefined {
  if (tok == null) return undefined;
  const m = tok.trim().match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : undefined;
}

/** Inner content of the first balanced `(...)` starting at/after `from`, or ''. */
function balancedParens(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open < 0) return '';
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '"') {
        if (text[i + 1] === '"') { i += 1; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return '';
}

/** Extract a `Field = "value"` string from M record text (Schema/Item/Name/Query). */
function extractMField(text: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}\\s*=\\s*"((?:[^"]|"")*)"`);
  const m = re.exec(text);
  return m ? m[1].replace(/""/g, '"') : undefined;
}

/** Skip a balanced `open…close` group at index `i` (assumes text[i] === open). */
function skipBalanced(text: string, i: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (inString) {
      if (ch === '"') { if (text[j + 1] === '"') { j += 1; continue; } inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) return j + 1; }
  }
  return text.length;
}

/**
 * True when `expr` is a pure NAVIGATION step: a leading identifier followed only
 * by `{…}` / `[…]` selectors (e.g. `Source{[Schema="dbo",Item="t"]}[Data]`). Such
 * steps only refine the base relation, so they are absorbed into the source
 * prefix; the first step that is NOT navigation begins the foldable transforms.
 */
function navigationOnly(expr: string): boolean {
  const t = expr.trim();
  if (!t) return false;
  let i = 0;
  if (t.startsWith('#"')) {
    const end = t.indexOf('"', 2);
    if (end < 0) return false;
    i = end + 1;
  } else {
    const m = t.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!m) return false;
    i += m[0].length;
  }
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i])) i += 1;
    if (i >= t.length) break;
    if (t[i] === '{') i = skipBalanced(t, i, '{', '}');
    else if (t[i] === '[') i = skipBalanced(t, i, '[', ']');
    else return false;
  }
  return true;
}

/** Recognize a SQL connector source step → its server + (optional) database. */
function parseSqlConnector(expr: string): { server?: string; db?: string } | null {
  const m = expr.match(/\bSql\.Databases?\s*\(/);
  if (!m) return null;
  const args = splitTopLevel(balancedParens(expr, m.index ?? 0), ',').map((a) => a.trim());
  const isDatabases = /\bSql\.Databases\s*\(/.test(expr);
  return {
    server: parseMStr(args[0]),
    db: isDatabases ? undefined : parseMStr(args[1]),
  };
}

/** A `Value.NativeQuery(src, "SELECT …", …)` source step → its raw SQL, or null. */
function parseNativeQueryStep(expr: string): string | null {
  const m = expr.match(/\bValue\.NativeQuery\s*\(/);
  if (!m) return null;
  const args = splitTopLevel(balancedParens(expr, m.index ?? 0), ',').map((a) => a.trim());
  const sqlText = parseMStr(args[1]);
  return sqlText ?? null;
}

/** Name a non-SQL / non-foldable source so the gate message is precise. */
function nonSqlSourceReason(expr: string): string | null {
  const t = expr.trim();
  if (/^#table\b/.test(t)) return 'an inline #table literal (sample data)';
  if (/^(Json\.Document|Xml\.Tables)\b/.test(t)) return 'a parsed JSON/XML document';
  if (/^(AzureStorage\.|DataLake\.|Csv\.Document|Excel\.Workbook|Web\.Contents|Folder\.Files|File\.Contents|Binary\.|SharePoint|Lakehouse\.Contents|Fabric\.|PowerBI\.|PowerPlatform\.)/.test(t)) {
    return 'a file / non-SQL connector source';
  }
  return null;
}

/** The resolved base relation + the Synapse pool it runs on. */
interface ResolvedSource {
  baseSelect: string;
  target: SynapseTarget;
  /** Count of leading source/navigation steps (the foldable transforms follow). */
  prefixLen: number;
}

/**
 * Resolve the query's leading source + navigation steps to a base SELECT on the
 * deployment's bound Synapse pool. Returns the resolution, or a structured gate
 * (412) naming the remediation — never a fabricated relation.
 */
function resolveSource(steps: Array<{ name: string; expr: string }>):
  | { ok: true; resolved: ResolvedSource }
  | { ok: false; status: number; payload: Record<string, unknown> } {
  const s0 = (steps[0]?.expr || '').trim();
  const connector = parseSqlConnector(s0);
  const nativeAtSource = parseNativeQueryStep(s0);

  if (!connector && !nativeAtSource) {
    const reason = nonSqlSourceReason(s0);
    return {
      ok: false,
      status: 412,
      payload: {
        code: 'gate',
        error: reason
          ? `Column profiling runs live over the bound Loom Synapse SQL endpoint. This query reads ${reason}, ` +
            `which can’t be folded to SQL — run the dataflow (Output → Run) to materialize its result to ADLS / Azure SQL, ` +
            `then profile that table. Azure-native (Synapse / ADF); no Fabric / Power BI.`
          : `Column profiling runs live over the bound Loom Synapse SQL endpoint, but this query’s Source isn’t a ` +
            `recognized SQL table or native query. Point the Source at the Loom warehouse / lakehouse (a Synapse table or ` +
            `a Sql.Database native query), or run the dataflow to materialize its output and profile the materialized table.`,
      },
    };
  }

  // Absorb leading navigation-only steps (they refine schema/table) into the prefix.
  const prefixExprs: string[] = [s0];
  let prefixLen = 1;
  while (prefixLen < steps.length && navigationOnly(steps[prefixLen].expr)) {
    prefixExprs.push(steps[prefixLen].expr);
    prefixLen += 1;
  }
  const prefixText = prefixExprs.join('\n');

  // Native query wins (Sql.Database(…,[Query=…]) or Value.NativeQuery) — a derived SELECT.
  const nativeQuery = nativeAtSource ?? extractMField(prefixText, 'Query');
  const schema = extractMField(prefixText, 'Schema') || 'dbo';
  const item = extractMField(prefixText, 'Item');
  const server = connector?.server;
  const db = connector?.db || extractMField(prefixText, 'Name');

  if (!nativeQuery && !item) {
    return {
      ok: false,
      status: 412,
      payload: {
        code: 'gate',
        error:
          'The dataflow query’s Source has no selected table or native query to profile. Choose a table in the ' +
          'source navigator (or supply a Sql.Database native query), then profile.',
      },
    };
  }

  // ── Choose the Synapse pool from the source server ──────────────────────────
  const ws = process.env.LOOM_SYNAPSE_WORKSPACE;
  if (!ws) {
    return {
      ok: false,
      status: 412,
      payload: {
        code: 'gate',
        missing: 'LOOM_SYNAPSE_WORKSPACE',
        error:
          'Synapse is not configured in this deployment (LOOM_SYNAPSE_WORKSPACE is unset), so column profiling can’t ' +
          'run. Set the Synapse workspace env on the Console app (deployed by platform/fiab/bicep/modules/landing-zone/synapse.bicep). ' +
          'Azure-native; no Fabric / Power BI.',
      },
    };
  }
  // Leading host label is suffix-agnostic (Commercial vs Gov) — `<ws>` (dedicated)
  // or `<ws>-ondemand` (serverless). Anything else is not the bound workspace.
  const firstLabel = (server || '').replace(/^tcp:/i, '').split(/[,.]/)[0].trim().toLowerCase();
  let target: SynapseTarget;
  try {
    if (firstLabel === `${ws}-ondemand`.toLowerCase()) {
      target = serverlessTarget(db || 'master');
    } else if (firstLabel === ws.toLowerCase()) {
      target = dedicatedTarget();
    } else {
      return {
        ok: false,
        status: 412,
        payload: {
          code: 'gate',
          error:
            `Column profiling runs live over the deployment’s bound Synapse workspace ("${ws}"). This query’s Source ` +
            `connects to "${server || 'an unknown server'}", which isn’t that workspace — Loom can’t reach it from the ` +
            `profiling path. Point the Source at the Loom warehouse / lakehouse, or run the dataflow to materialize its ` +
            `output and profile the materialized table. Azure-native; no Fabric / Power BI.`,
        },
      };
    }
  } catch (e: any) {
    // dedicatedTarget()/serverlessTarget() throw on a missing env var → honest gate.
    return {
      ok: false,
      status: 412,
      payload: {
        code: 'gate',
        error:
          `Synapse is not fully configured for profiling: ${e?.message || String(e)}. Set the Synapse workspace / ` +
          `dedicated-pool env on the Console app (platform/fiab/bicep/modules/landing-zone/synapse.bicep).`,
      },
    };
  }

  const baseSelect = nativeQuery
    ? stripSemicolons(nativeQuery)
    : `SELECT * FROM ${q(schema)}.${q(item as string)}`;

  return { ok: true, resolved: { baseSelect, target, prefixLen } };
}

// ── Aggregate profiling (identical SQL/contract to the report profile route) ────

/**
 * Run the per-column aggregate stats over `relation` (wrapped as a derived
 * table). Tries MIN/MAX first; on failure retries WITHOUT them (non-orderable
 * types). A second failure rethrows → the caller surfaces the verbatim 502.
 */
async function runColumnStats(
  target: SynapseTarget,
  relation: string,
  col: string,
): Promise<{ total: number; nonnull: number; distinct: number; min?: string | number; max?: string | number }> {
  const c = q(col);
  const from = `FROM (${relation}) AS _p`;
  const withMinMax =
    `SELECT COUNT_BIG(*) AS total, COUNT_BIG(${c}) AS nonnull, ` +
    `COUNT_BIG(DISTINCT ${c}) AS distinctc, MIN(${c}) AS minv, MAX(${c}) AS maxv ${from}`;
  try {
    const r = await executeQuery(target, withMinMax, PROFILE_TIMEOUT_MS);
    const rec = firstRowRecord(r.columns, r.rows);
    return {
      total: asCount(rec.total),
      nonnull: asCount(rec.nonnull),
      distinct: asCount(rec.distinctc),
      min: normScalar(rec.minv),
      max: normScalar(rec.maxv),
    };
  } catch {
    const countsOnly =
      `SELECT COUNT_BIG(*) AS total, COUNT_BIG(${c}) AS nonnull, COUNT_BIG(DISTINCT ${c}) AS distinctc ${from}`;
    const r = await executeQuery(target, countsOnly, PROFILE_TIMEOUT_MS);
    const rec = firstRowRecord(r.columns, r.rows);
    return { total: asCount(rec.total), nonnull: asCount(rec.nonnull), distinct: asCount(rec.distinctc) };
  }
}

/**
 * Real TOP-12 value distribution (busiest first). Returns [] on failure (a type
 * that can't GROUP BY, e.g. varbinary) — an honest "no distribution for this
 * type", never a thrown 500.
 */
async function runColumnDistribution(
  target: SynapseTarget,
  relation: string,
  col: string,
): Promise<Array<{ value: string; count: number }>> {
  const c = q(col);
  const sql =
    `SELECT TOP ${DISTRIBUTION_TOP} ${c} AS val, COUNT_BIG(*) AS cnt ` +
    `FROM (${relation}) AS _p GROUP BY ${c} ORDER BY COUNT_BIG(*) DESC`;
  try {
    const r = await executeQuery(target, sql, PROFILE_TIMEOUT_MS);
    return r.rows.map((row) => ({ value: distValue(row[0]), count: asCount(row[1]) }));
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSession();
  if (!session) return err(401, { error: 'unauthenticated' });

  const body = (await req.json().catch(() => ({}))) as ProfileBody;
  const mScript = typeof body.mScript === 'string' ? body.mScript : '';
  const queryName = typeof body.queryName === 'string' ? body.queryName.trim() : '';
  const column = typeof body.column === 'string' ? body.column.trim() : '';

  if (!mScript.trim()) {
    return err(400, { error: 'mScript is required (the Power Query M section text).' });
  }

  // ── Resolve the named query (default to the last query when none given) ──────
  const queries = parseSharedQueries(mScript);
  if (!queries.length) {
    return err(412, {
      code: 'gate',
      error: 'No queries found in the Power Query script. Author at least one query before profiling.',
    });
  }
  let queryBody: string;
  if (queryName) {
    const exact = queries.find((qy) => qy.name === queryName)
      || queries.find((qy) => qy.name.toLowerCase() === queryName.toLowerCase());
    if (!exact) {
      return err(400, {
        error: `Query "${queryName}" was not found. Available: ${queries.map((qy) => qy.name).join(', ')}.`,
      });
    }
    queryBody = exact.body;
  } else {
    queryBody = queries[queries.length - 1].body;
  }

  const { steps, result } = parseLetBody(queryBody);
  if (!steps.length) {
    return err(412, {
      code: 'gate',
      error: 'The selected query has no applied steps to profile. Add a Source step (and any transforms) first.',
    });
  }

  // ── Resolve the base relation + Synapse pool from the source prefix ──────────
  const src = resolveSource(steps);
  if (!src.ok) return err(src.status, src.payload);
  const { baseSelect, target, prefixLen } = src.resolved;

  // ── Fold the remaining applied steps onto the base (DirectQuery) ─────────────
  // Rebuild a synthetic `let` whose step[0] is the opaque source (substituted by
  // baseSelect) followed by the transform steps in order; `foldAppliedStepsToSql`
  // walks them exactly as it does for the report route. A non-foldable step is an
  // honest gate (Import materializes the FULL M via the dataflow run, unchanged).
  let relation = baseSelect;
  const remaining = steps.slice(prefixLen);
  if (remaining.length) {
    const synthSteps = [{ name: 'Source', expr: 'null' }, ...remaining];
    const resultName = remaining.some((st) => st.name === result)
      ? result
      : remaining[remaining.length - 1].name;
    const synthBody = buildLetBody(synthSteps, resultName);
    const folded = foldAppliedStepsToSql(baseSelect, synthBody, DIALECT);
    if (!folded.ok) {
      return err(412, {
        code: 'gate',
        unfoldableStep: folded.unfoldableStep,
        error:
          `Column profiling runs live (DirectQuery), but the transform step "${folded.unfoldableStep}" can’t be folded ` +
          `to SQL. Switch this query to Import and run Refresh to materialize it via the dataflow run (ADF wrangling → ` +
          `Delta), then profile the materialized data — or remove/replace the non-foldable step. Azure-native; no Fabric.`,
      });
    }
    relation = folded.sql;
  }

  // ── Probe the resolved/folded relation for its REAL post-transform columns ───
  let probedColumns: string[];
  try {
    const probe = await executeQuery(target, `SELECT TOP 0 * FROM (${relation}) AS _probe`, PROFILE_TIMEOUT_MS);
    probedColumns = probe.columns;
  } catch (e: any) {
    return err(502, { error: e?.message || String(e), status: 502 });
  }
  if (!probedColumns.length) {
    return err(412, {
      code: 'gate',
      error: 'The resolved source returned no columns to profile. Adjust the source / transform and retry.',
    });
  }

  // Which columns to profile: the requested one (must exist post-transform), else
  // every column (capped). A bad `column` is a client error (400), not a gate.
  let columnsToProfile: string[];
  if (column) {
    const match = probedColumns.find((c) => c.toLowerCase() === column.toLowerCase());
    if (!match) {
      return err(400, {
        error: `Column "${column}" is not present in the query’s data (after any transform). Available: ${probedColumns
          .slice(0, 50)
          .join(', ')}.`,
      });
    }
    columnsToProfile = [match];
  } else {
    columnsToProfile = probedColumns.slice(0, MAX_PROFILE_COLUMNS);
  }

  // ── Total row count (one real COUNT over the relation) ──────────────────────
  let rowCount = 0;
  try {
    const rc = await executeQuery(target, `SELECT COUNT_BIG(*) AS cnt FROM (${relation}) AS _p`, PROFILE_TIMEOUT_MS);
    rowCount = asCount(firstRowRecord(rc.columns, rc.rows).cnt);
  } catch (e: any) {
    return err(502, { error: e?.message || String(e), status: 502 });
  }

  // ── Per-column REAL aggregate profiling ─────────────────────────────────────
  let columns: ProfileColumn[];
  try {
    columns = await Promise.all(
      columnsToProfile.map(async (name): Promise<ProfileColumn> => {
        const stats = await runColumnStats(target, relation, name);
        const distribution = await runColumnDistribution(target, relation, name);
        const nulls = Math.max(0, stats.total - stats.nonnull);
        const nullPct = stats.total > 0 ? Math.round((nulls / stats.total) * 10000) / 100 : 0;
        return {
          name,
          count: stats.total,
          distinct: stats.distinct,
          nulls,
          nullPct,
          ...(stats.min !== undefined ? { min: stats.min } : {}),
          ...(stats.max !== undefined ? { max: stats.max } : {}),
          distribution,
        };
      }),
    );
  } catch (e: any) {
    // A genuine backend failure (auth / connectivity / invalid folded SQL) — the
    // verbatim message is the honest gate, never a mock column (no-vaporware.md).
    return err(502, { error: e?.message || String(e), status: 502 });
  }

  return NextResponse.json({ ok: true, rowCount, sampled: false, columns });
}
