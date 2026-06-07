/**
 * GET /api/items/synapse-serverless-sql-pool/[id]/objects?database=<db>
 *
 * Enumerates the SQL objects in a Serverless SQL database for the editor's
 * object explorer + Monaco IntelliSense:
 *   - Views               (sys.views + sys.sql_modules)
 *   - Stored procedures   (sys.procedures + sys.sql_modules)
 *   - Table-valued funcs  (sys.objects type IN ('IF','TF') — serverless does
 *                          NOT support scalar UDFs)
 *   - External tables     (sys.external_tables + sys.external_data_sources)
 *   - Columns             (sys.columns, keyed by [schema].[object]) → IntelliSense
 *
 * Every query runs against the real TDS endpoint via the shared
 * synapse-sql-client (AAD MI). Each catalog query is independently
 * try/caught so one empty/failed catalog (e.g. no external tables) does not
 * fail the whole response — per no-vaporware.md the surface degrades to a
 * partial-but-honest result rather than an opaque error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, serverlessEndpoint, executeQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q_VIEWS = `
SELECT s.name AS [schema], v.name AS name, m.definition AS definition
FROM sys.views v
JOIN sys.schemas s ON s.schema_id = v.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = v.object_id
ORDER BY s.name, v.name`;

const Q_PROCS = `
SELECT s.name AS [schema], p.name AS name, m.definition AS definition
FROM sys.procedures p
JOIN sys.schemas s ON s.schema_id = p.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = p.object_id
ORDER BY s.name, p.name`;

const Q_FUNCS = `
SELECT s.name AS [schema], o.name AS name, m.definition AS definition, o.type AS type
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.type IN ('IF', 'TF')
ORDER BY s.name, o.name`;

const Q_EXTERNAL_TABLES = `
SELECT s.name AS [schema], t.name AS name,
       ds.name AS data_source_name, ds.location AS location
FROM sys.external_tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.external_data_sources ds ON ds.data_source_id = t.data_source_id
ORDER BY s.name, t.name`;

// Columns across views, iTVFs/TVFs, external tables and user tables — these
// feed Monaco IntelliSense (object + column suggestions).
const Q_COLUMNS = `
SELECT QUOTENAME(s.name) + '.' + QUOTENAME(o.name) AS full_name,
       c.name AS col_name, tp.name AS data_type, c.column_id AS column_id
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types tp ON tp.user_type_id = c.user_type_id
WHERE o.type IN ('V', 'IF', 'TF', 'ET', 'U')
ORDER BY full_name, c.column_id`;

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

export async function GET(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest infra gate — no Fabric required; Azure-native Synapse Serverless is
  // the default backend. If the workspace env var is unset, the editor shows a
  // MessageBar naming exactly what to set (per no-vaporware.md / no-fabric).
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json({
      ok: false,
      gated: true,
      error: 'Synapse Serverless SQL endpoint is not configured. Set LOOM_SYNAPSE_WORKSPACE (admin-plane bicep deploys the Synapse workspace).',
    }, { status: 200 });
  }

  const database = (req.nextUrl.searchParams.get('database') || 'master').toString();
  const target = serverlessTarget(database);

  async function safe(label: string, q: string): Promise<{ columns: string[]; rows: unknown[][]; error?: string }> {
    try {
      const r = await executeQuery(target, q);
      return { columns: r.columns, rows: r.rows };
    } catch (e: any) {
      return { columns: [], rows: [], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const [viewsR, procsR, funcsR, extR, colsR] = await Promise.all([
      safe('views', Q_VIEWS),
      safe('procedures', Q_PROCS),
      safe('functions', Q_FUNCS),
      safe('externalTables', Q_EXTERNAL_TABLES),
      safe('columns', Q_COLUMNS),
    ]);

    const views = rowsToObjects(viewsR.columns, viewsR.rows).map((r) => ({
      schema: String(r.schema), name: String(r.name), definition: r.definition ? String(r.definition) : '',
    }));
    const procedures = rowsToObjects(procsR.columns, procsR.rows).map((r) => ({
      schema: String(r.schema), name: String(r.name), definition: r.definition ? String(r.definition) : '',
    }));
    const functions = rowsToObjects(funcsR.columns, funcsR.rows).map((r) => ({
      schema: String(r.schema), name: String(r.name), definition: r.definition ? String(r.definition) : '',
      type: (String(r.type).trim() === 'IF' ? 'IF' : 'TF') as 'IF' | 'TF',
    }));
    const externalTables = rowsToObjects(extR.columns, extR.rows).map((r) => ({
      schema: String(r.schema), name: String(r.name),
      dataSource: r.data_source_name ? String(r.data_source_name) : '',
      location: r.location ? String(r.location) : '',
    }));

    const columns: Record<string, { name: string; dataType: string }[]> = {};
    for (const r of rowsToObjects(colsR.columns, colsR.rows)) {
      const key = String(r.full_name);
      (columns[key] ||= []).push({ name: String(r.col_name), dataType: String(r.data_type) });
    }

    const errors = [viewsR.error, procsR.error, funcsR.error, extR.error, colsR.error].filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      database,
      endpoint: serverlessEndpoint(),
      views,
      procedures,
      functions,
      externalTables,
      columns,
      ...(errors.length ? { warnings: errors } : {}),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
