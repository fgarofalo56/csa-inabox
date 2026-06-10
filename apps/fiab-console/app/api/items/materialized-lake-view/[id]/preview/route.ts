/**
 * POST /api/items/materialized-lake-view/[id]/preview
 *
 * Previews the materialized Delta table via the Synapse Serverless SQL endpoint
 * (OPENROWSET FORMAT='DELTA' over the MLV's abfss Delta path). Proves the MLV
 * was materialized for real — same backend the lakehouse SQL endpoint uses. No
 * mock data; honest gate when Synapse Serverless is unconfigured.
 *
 * Body: { maxRows?: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMlvItem, specFromItem } from '../../_lib/load';
import {
  serverlessTarget,
  executeQuery,
  buildDeltaOpenRowsetSql,
  getSynapseSqlSuffix,
} from '@/lib/azure/synapse-sql-client';
import { resolveMlvDeltaUrl } from '@/lib/azure/materialized-lake-view-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Convert an abfss://container@host/path URL to the https DFS URL serverless OPENROWSET expects. */
function abfssToHttps(abfss: string): string | null {
  const m = abfss.match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
  if (!m) return null;
  const [, container, host, path] = m;
  return `https://${host}/${container}/${path}`;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const item = await loadMlvItem(id, session.claims.oid).catch(() => null);
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const spec = specFromItem(item);
  if (!spec) return NextResponse.json({ ok: false, error: 'No MLV definition — author + refresh it first.' }, { status: 400 });

  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        gate: 'synapse_not_configured',
        error: 'Preview needs a Synapse Serverless SQL endpoint.',
        remediation:
          'Set LOOM_SYNAPSE_WORKSPACE and grant the Console UAMI CONNECT + db_datareader on ' +
          'the serverless DB. No Microsoft Fabric required.',
      },
      { status: 503 },
    );
  }

  const abfss = resolveMlvDeltaUrl(spec);
  if (!abfss) {
    return NextResponse.json(
      { ok: false, gate: 'adls_not_configured', error: `LOOM_${spec.container.toUpperCase()}_URL is not configured for the MLV container.` },
      { status: 503 },
    );
  }
  const https = abfssToHttps(abfss);
  if (!https) return NextResponse.json({ ok: false, error: 'Could not resolve the Delta https URL.' }, { status: 500 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const maxRows = Math.min(5000, Math.max(1, parseInt(body?.maxRows, 10) || 200));
  const sql = buildDeltaOpenRowsetSql(https, maxRows);

  try {
    const result = await executeQuery(serverlessTarget('master'), sql);
    return NextResponse.json({
      ok: true,
      ...result,
      deltaUrl: abfss,
      fqn: `${spec.schema}.${spec.viewName}`,
      endpoint: `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`,
    });
  } catch (e: any) {
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // A "not found" / path-empty error means the refresh hasn't written the Delta yet.
    if (/cannot bulk load|does not exist|external file|path|0 files/i.test(raw)) {
      return NextResponse.json(
        { ok: false, code: 'not_materialized', error: 'The Delta table is not materialized yet — run a Refresh and wait for the Spark batch to finish.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: raw.slice(0, 400) }, { status: 502 });
  }
}
