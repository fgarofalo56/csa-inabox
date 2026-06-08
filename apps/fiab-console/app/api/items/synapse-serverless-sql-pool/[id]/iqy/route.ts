/**
 * POST /api/items/synapse-serverless-sql-pool/[id]/iqy
 *   body: { sql, database? }
 *
 * Generates an Excel web-query (.iqy) file pointed at the Loom Synapse
 * Serverless query route. The BFF executes the T-SQL via TDS + AAD (the
 * Container App MI) against
 *   {workspace}-ondemand.sql.azuresynapse[.usgovcloudapi].net
 * The .iqy is cloud-portable: it always targets the BFF origin
 * (req.nextUrl.origin), never the raw TDS FQDN, so the sovereign suffix is
 * resolved server-side by synapseSqlSuffix(). Azure-native — no Fabric /
 * Power BI dependency.
 *
 * The .iqy WEB format is 4 lines:
 *   WEB
 *   1
 *   <URL the query is POSTed to>
 *   <JSON POST body>
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  if (!sql) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });

  const database = body?.database ? String(body.database) : 'master';

  const origin = req.nextUrl.origin;
  const target = `${origin}/api/items/synapse-serverless-sql-pool/${encodeURIComponent(id)}/query`;
  const postBody = JSON.stringify({ sql, database });

  const iqy = [
    'WEB',
    '1',
    target,
    postBody,
    '',
    'Selection=AllTables',
    'Formatting=All',
    'PreFormattedTextToColumns=True',
    'ConsecutiveDelimitersAsOne=True',
    'SingleBlockTextImport=False',
    'DisableDateRecognition=False',
    'DisableRedirections=False',
  ].join('\r\n');

  return new NextResponse(iqy, {
    status: 200,
    headers: {
      'content-type': 'text/x-ms-iqy; charset=utf-8',
      'content-disposition': `attachment; filename="loom-synapse-serverless-${id}.iqy"`,
      'cache-control': 'no-store',
    },
  });
}
