import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/notebook/execute
 *
 * The Loom notebook cell-run path is per-language and goes through a
 * specific compute target:
 *   - Spark / PySpark / SparkR / Spark SQL → Synapse Spark or Databricks
 *     (use /api/items/databricks-notebook/{id}/run or the Synapse Livy
 *     submission flow in lib/azure/synapse-spark-client.ts)
 *   - T-SQL → /api/items/warehouse/{id}/query or
 *     /api/items/synapse-dedicated-sql-pool/{id}/query
 *   - KQL → /api/items/kql-database/{id}/query
 *   - Python (non-Spark) → not yet wired
 *
 * This generic /api/notebook/execute route used to return a stubbed
 * "kernel not wired" string and was the source of "fake 200" findings
 * in the v2 validator. Per .claude/rules/no-vaporware.md this returns
 * 501 with the right per-language route to call instead.
 */
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const language = (body?.language || '').toString().toLowerCase();

  const dispatch: Record<string, string> = {
    pyspark: '/api/items/databricks-notebook/{id}/run (or Synapse Livy)',
    spark: '/api/items/databricks-notebook/{id}/run (or Synapse Livy)',
    sparksql: '/api/items/databricks-sql-warehouse/{id}/query',
    sparkr: '/api/items/databricks-notebook/{id}/run',
    python: 'Databricks notebook task with %python magic',
    tsql: '/api/items/warehouse/{id}/query or /api/items/synapse-dedicated-sql-pool/{id}/query',
    sql: '/api/items/synapse-serverless-sql-pool/{id}/query',
    kql: '/api/items/kql-database/{id}/query',
  };

  return NextResponse.json(
    {
      ok: false,
      error: `Generic /api/notebook/execute is not wired — language='${language || 'unknown'}'`,
      remediation: {
        message: 'Cell execution routes through the editor that owns the compute target. Use the per-language route below:',
        route: dispatch[language] || 'unknown language',
        bicepModule: 'platform/fiab/bicep/modules/{databricks,synapse,kusto}/*.bicep',
      },
    },
    { status: 501 },
  );
}
