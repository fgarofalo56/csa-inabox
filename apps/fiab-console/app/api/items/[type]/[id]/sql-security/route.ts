/**
 * SQL granular security wizards (F11) — BFF route.
 *
 *   GET  /api/items/[type]/[id]/sql-security
 *        → returns the live security state for the wizard pickers + state panel:
 *          { principals, tables, views, columns, grants, maskedColumns,
 *            securityPolicies }
 *
 *   POST /api/items/[type]/[id]/sql-security
 *        body { wizard, params, preview?, server?, database? }
 *        - preview:true  → returns { ok, sql } WITHOUT executing (preview pane)
 *        - preview:false → executes the generated T-SQL over TDS and returns
 *                          { ok, sql, recordsAffected, executionMs }
 *        body { action:'verify', verify:{principal, schema, table, column?}, … }
 *        - runs EXECUTE AS USER + SELECT + REVERT so the masked/RLS effect is
 *          provable for the test principal (returns the rows that principal sees).
 *
 * Backends dispatched by [type] (Azure-native default, NO Microsoft Fabric):
 *   - synapse-dedicated-sql-pool  → Synapse Dedicated pool (env-bound)
 *   - synapse-serverless-sql-pool → Synapse Serverless endpoint (?database=)
 *   - azure-sql-database / warehouse → Azure SQL (server + database from body)
 *
 * AUTH IS ENTRA-ONLY. Both clients build their TDS pool with
 * `authentication.type='azure-active-directory-access-token'` — there is no
 * SQL-auth (username/password) code path anywhere in this route or its clients,
 * which satisfies the "Entra-only connection enforced" acceptance criterion.
 *
 * The client NEVER sends raw SQL: it sends a structured `params` object and the
 * SQL is built server-side by lib/sql/tsql-builders.ts (bracket-quoted
 * identifiers + allowlisted verbs/masks), so there is no injection path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery as synapseExecute,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { executeQuery as azureSqlExecute, AzureSqlError } from '@/lib/azure/azure-sql-client';
import {
  buildWizardSql,
  buildVerifyAs,
  splitSqlBatches,
  TsqlBuildError,
  SQL_LIST_DATABASE_PRINCIPALS,
  SQL_LIST_TABLES,
  SQL_LIST_VIEWS,
  SQL_LIST_COLUMNS,
  SQL_LIST_OBJECT_GRANTS,
  SQL_LIST_MASKED_COLUMNS,
  SQL_LIST_SECURITY_POLICIES,
  type WizardKind,
} from '@/lib/sql/tsql-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'synapse-dedicated' | 'synapse-serverless' | 'azure-sql';

interface Reader {
  backend: Backend;
  serverless: boolean;
  /** Run a single-statement read and return columns + row objects. */
  run: (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;
  /** Execute one or more T-SQL batches (split on GO) and return a receipt. */
  exec: (sql: string) => Promise<{ recordsAffected: number; executionMs: number; messages: string[] }>;
}

/** Honest gate object — UI renders a MessageBar with `missing`. */
interface Gate { gated: true; error: string }

/**
 * Resolve the execution backend for the item type. Returns either a Reader or
 * an honest infra gate (never a Fabric gate — Azure-native is the default).
 */
function resolveBackend(
  type: string,
  opts: { server?: string; database?: string },
): Reader | Gate {
  if (type === 'synapse-dedicated-sql-pool' || type === 'warehouse') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
      return {
        gated: true,
        error:
          'Synapse Dedicated SQL pool is not configured. Set LOOM_SYNAPSE_WORKSPACE and ' +
          'LOOM_SYNAPSE_DEDICATED_POOL (admin-plane bicep deploys the Synapse workspace + pool).',
      };
    }
    return synapseReader('synapse-dedicated', dedicatedTarget());
  }

  if (type === 'synapse-serverless-sql-pool') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return {
        gated: true,
        error:
          'Synapse Serverless SQL endpoint is not configured. Set LOOM_SYNAPSE_WORKSPACE ' +
          '(admin-plane bicep deploys the Synapse workspace).',
      };
    }
    return synapseReader('synapse-serverless', serverlessTarget(opts.database || 'master'), true);
  }

  // azure-sql-database (+ family). server + database come from the editor state.
  if (!opts.server || !opts.database) {
    return {
      gated: true,
      error:
        'Pick a server and database on the Connect tab first — the SQL security ' +
        'wizards run against that Azure SQL database via TDS + Microsoft Entra token.',
    };
  }
  const server = opts.server;
  const database = opts.database;
  return {
    backend: 'azure-sql',
    serverless: false,
    run: async (sql: string) => {
      const r = await azureSqlExecute(server, database, sql);
      return { columns: r.columns, rows: r.rows };
    },
    exec: async (sql: string) => {
      const started = Date.now();
      let recordsAffected = 0;
      for (const batch of splitSqlBatches(sql)) {
        const r = await azureSqlExecute(server, database, batch);
        recordsAffected += r.rowCount;
      }
      return { recordsAffected, executionMs: Date.now() - started, messages: [] };
    },
  };
}

function synapseReader(backend: Backend, target: SynapseTarget, serverless = false): Reader {
  return {
    backend,
    serverless,
    run: async (sql: string) => {
      const r = await synapseExecute(target, sql);
      return { columns: r.columns, rows: r.rows };
    },
    exec: async (sql: string) => {
      const started = Date.now();
      let recordsAffected = 0;
      const messages: string[] = [];
      for (const batch of splitSqlBatches(sql)) {
        const r = await synapseExecute(target, batch);
        recordsAffected += r.recordsAffected;
        messages.push(...r.messages);
      }
      return { recordsAffected, executionMs: Date.now() - started, messages };
    },
  };
}

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

async function ctxParams(ctx: { params: Promise<{ type: string; id: string }> }) {
  return ctx.params;
}

// ============================================================
// GET — live security state for the pickers + state panel
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const server = req.nextUrl.searchParams.get('server') || undefined;
  const database = req.nextUrl.searchParams.get('database') || undefined;

  const backend = resolveBackend(type, { server, database });
  if ('gated' in backend) {
    return NextResponse.json({ ok: false, gated: true, error: backend.error }, { status: 200 });
  }

  // Each catalog read is independently try/caught so one failure (e.g. no
  // masked columns yet) degrades to a partial-but-honest result.
  async function safe(label: string, sql: string) {
    try {
      const r = await (backend as Reader).run(sql);
      return { rows: rowsToObjects(r.columns, r.rows), error: undefined as string | undefined };
    } catch (e: any) {
      return { rows: [] as Record<string, unknown>[], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const [principals, tables, views, columns, grants, masked, policies] = await Promise.all([
      safe('principals', SQL_LIST_DATABASE_PRINCIPALS),
      safe('tables', SQL_LIST_TABLES),
      safe('views', SQL_LIST_VIEWS),
      safe('columns', SQL_LIST_COLUMNS),
      safe('grants', SQL_LIST_OBJECT_GRANTS),
      safe('maskedColumns', SQL_LIST_MASKED_COLUMNS),
      safe('securityPolicies', SQL_LIST_SECURITY_POLICIES),
    ]);

    // Group columns by `schema.object` for the wizard pickers.
    const columnsByObject: Record<string, { name: string; dataType: string }[]> = {};
    for (const r of columns.rows) {
      const key = `${String(r.schema_name)}.${String(r.object_name)}`;
      (columnsByObject[key] ||= []).push({ name: String(r.column_name), dataType: String(r.data_type) });
    }

    const warnings = [principals.error, tables.error, views.error, columns.error, grants.error, masked.error, policies.error]
      .filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      backend: backend.backend,
      serverless: backend.serverless,
      principals: principals.rows,
      tables: tables.rows,
      views: views.rows,
      columnsByObject,
      grants: grants.rows,
      maskedColumns: masked.rows,
      securityPolicies: policies.rows,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// POST — preview / execute a wizard, or verify (EXECUTE AS)
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctxParams(ctx);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'wizard');
  const server = body?.server ? String(body.server) : undefined;
  const database = body?.database ? String(body.database) : undefined;

  const backend = resolveBackend(type, { server, database });
  if ('gated' in backend) {
    return NextResponse.json({ ok: false, gated: true, error: backend.error }, { status: 200 });
  }

  // ---- Verification: run a SELECT as the test principal (EXECUTE AS) ----
  if (action === 'verify') {
    const v = body?.verify || {};
    let sql: string;
    try {
      sql = buildVerifyAs({
        principal: String(v.principal || ''),
        schema: String(v.schema || ''),
        table: String(v.table || ''),
        column: v.column ? String(v.column) : undefined,
        top: v.top,
      });
    } catch (e: any) {
      const status = e instanceof TsqlBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    if (!v.principal || !v.schema || !v.table) {
      return NextResponse.json({ ok: false, error: 'verify requires principal, schema and table' }, { status: 400 });
    }
    try {
      const r = await backend.run(sql);
      return NextResponse.json({ ok: true, sql, columns: r.columns, rows: r.rows, executedBy: session.claims.upn });
    } catch (e: any) {
      const status = e instanceof AzureSqlError ? e.status : 502;
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e) }, { status });
    }
  }

  // ---- Wizard: build SQL from structured params ----
  const wizard = String(body?.wizard || '') as WizardKind;
  const preview = body?.preview === true;
  const params = body?.params ?? {};

  // Serverless does NOT support RLS — honest functional gate (Learn: serverless
  // T-SQL feature matrix). No SQL is executed; the UI disables the Execute btn.
  if (backend.serverless && wizard === 'rls') {
    return NextResponse.json({
      ok: false,
      gated: true,
      error:
        'Row-level security is not supported on Synapse Serverless SQL pools. ' +
        'Apply RLS on a Dedicated SQL pool / Azure SQL database, or use a view-based ' +
        'workaround over the serverless dataset.',
    }, { status: 200 });
  }

  let sql: string;
  try {
    sql = buildWizardSql(wizard, params);
  } catch (e: any) {
    const status = e instanceof TsqlBuildError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  // Preview pane: return the generated SQL without touching the database.
  if (preview) {
    return NextResponse.json({ ok: true, preview: true, sql });
  }

  try {
    const receipt = await backend.exec(sql);
    return NextResponse.json({
      ok: true,
      sql,
      recordsAffected: receipt.recordsAffected,
      executionMs: receipt.executionMs,
      messages: receipt.messages,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      sql,
      error: e?.message || String(e),
      code: e?.code,
      sqlNumber: e?.number,
    }, { status });
  }
}
