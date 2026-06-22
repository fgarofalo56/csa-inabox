/**
 * POST /api/items/lakehouse/[id]/query
 *
 * Runs T-SQL for a Lakehouse SQL analytics endpoint. In this deployment a
 * Lakehouse is an ADLS Gen2 medallion container (bronze/silver/gold/landing)
 * whose tabular SQL surface is Synapse Serverless (OPENROWSET over the lake
 * files + Delta tables) — the same backend the Files/Preview tab uses.
 *
 * Previously the editor POSTed to
 *   /api/items/synapse-serverless-sql-pool/<lakehouseId>/query
 * which is the wrong item type. Even though that route ignores the id, the
 * mismatch was fragile and meant the lakehouse had no SQL route of its own.
 * This route is the lakehouse's own SQL analytics endpoint, calling the real
 * Synapse Serverless TDS client (no mock data).
 *
 * Body: { sql: string, database?: string }
 * Auth: session-required.
 *
 * Background:
 *  - Fabric lakehouse SQL analytics endpoint: a read-only T-SQL endpoint over
 *    the lakehouse Delta tables (https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint).
 *  - OPENROWSET serverless over raw CSV/Parquet:
 *    https://learn.microsoft.com/azure/synapse-analytics/sql/develop-openrowset
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, executeQuery, getSynapseSqlSuffix } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const database = (body?.database || 'master').toString();
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

  // Honest infra-gate: the lakehouse SQL endpoint requires a configured
  // Synapse Serverless workspace. Name the exact env var if it's missing,
  // rather than letting executeQuery throw an opaque "Missing env var".
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Lakehouse SQL analytics endpoint not provisioned in this deployment. ' +
          'Set LOOM_SYNAPSE_WORKSPACE (the Synapse workspace whose -ondemand serverless ' +
          'endpoint serves OPENROWSET over the medallion lake) and grant the Console UAMI ' +
          'the Synapse SQL admin / Storage Blob Data Reader roles.',
        code: 'synapse_not_configured',
      },
      { status: 503 },
    );
  }

  try {
    const result = await executeQuery(serverlessTarget(database), sqlText);
    return NextResponse.json({
      ok: true,
      ...result,
      endpoint: `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`,
      database,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    // Sanitize: never surface a raw HTML error body to the UI (a firewall /
    // gateway 403 returns an XHTML page). Strip tags + collapse whitespace.
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Cold-start timeout: Synapse serverless OPENROWSET on CSV can take 30-60s on first run.
    // Surface a user-friendly message with honest remediation instead of a raw 502.
    const isColdTimeout = /timeout|cold/.test(raw);
    if (isColdTimeout) {
      return NextResponse.json(
        {
          ok: false,
          code: 'synapse_cold_start',
          error:
            'Query took longer than 60 seconds (Synapse serverless pool cold-start). ' +
            'OPENROWSET over CSV files can be slow on first execution. ' +
            'Retry the query — the pool will stay warm and subsequent queries run faster. ' +
            'For better performance, materialize the data as a Parquet or Delta table via a notebook.',
        },
        { status: 504 },
      );
    }
    
    const is403 = /\b403\b|forbidden|not allowed|denied/i.test(raw);
    if (is403) {
      // Auth-or-firewall denial: the endpoint is provisioned but the Console
      // identity can't reach/authorize against it. Honest gate, no HTML dump.
      return NextResponse.json(
        {
          ok: false,
          code: 'synapse_access_denied',
          error:
            'Access denied to the Synapse Serverless SQL endpoint ' +
            `(${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}). ` +
            'Two grants are required and one is missing in this deployment: ' +
            '(1) the Console UAMI must have CONNECT + db_datareader on the serverless DB ' +
            '(run: CREATE LOGIN/USER FROM EXTERNAL PROVIDER for the UAMI + GRANT), and ' +
            '(2) the Container App must be allowed through the Synapse SQL firewall ' +
            '(add its outbound IP / a managed private endpoint). ' +
            'See docs/fiab/v3-tenant-bootstrap.md.',
        },
        { status: 502 },
      );
    }
    // Empty / non-existent target path. OPENROWSET errors ("Content of
    // directory on path '…' cannot be listed", "Cannot bulk load … does not
    // exist", "path … not found") when the file/folder it points at has no
    // data yet — e.g. a shortcut to an Event Hubs capture path before any
    // events land, or a medallion folder not yet populated. This is an honest
    // "no data yet" state, not a failure — surface it as such, not a raw
    // EREQUEST.
    const isEmptyPath = /cannot be listed|does not exist|not found|no files|path.*could not be found|0x80070002/i.test(raw);
    if (isEmptyPath) {
      const m = raw.match(/path '([^']+)'/i);
      const where = m ? ` ('${m[1]}')` : '';
      return NextResponse.json(
        {
          ok: false,
          code: 'empty_or_missing_path',
          error:
            `No data at the query target${where} yet. The path is empty or doesn't exist — ` +
            `for a shortcut, its source hasn't been populated (e.g. an Event Hubs capture ` +
            `path before any events land, or a folder not yet written). Point the query/` +
            `shortcut at a populated path, run the pipeline/capture that fills it, or upload ` +
            `a file, then re-run. (No rows is expected until then.)`,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: raw.slice(0, 400),
        code: e?.code,
        sqlState: e?.originalError?.info?.state,
        sqlNumber: e?.number,
      },
      { status: 502 },
    );
  }
}
