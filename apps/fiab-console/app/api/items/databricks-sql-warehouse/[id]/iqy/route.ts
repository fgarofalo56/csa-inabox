/**
 * POST /api/items/databricks-sql-warehouse/[id]/iqy
 *   body: { sql, warehouseId, catalog?, schema? }
 *
 * Generates an Excel web-query (.iqy) file pointed at the Loom Databricks
 * query route. The .iqy carries the SQL + warehouseId (and optional
 * catalog/schema) so Excel re-executes the same statement on refresh via
 * the BFF, which calls the Databricks Statement Execution API using the
 * Container App MI. Azure-native — no Fabric / Power BI dependency.
 *
 * The .iqy WEB format is 4 lines:
 *   WEB
 *   1
 *   <URL the query is POSTed to>
 *   <JSON POST body>
 * Modern Excel honours POST data when line 4 carries the JSON body.
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
  const warehouseId = (body?.warehouseId || '').toString().trim();
  if (!sql) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;

  // Excel calls back into the same Databricks query route the editor uses.
  const origin = req.nextUrl.origin;
  const target = `${origin}/api/items/databricks-sql-warehouse/${encodeURIComponent(id)}/query`;
  const postBody = JSON.stringify({ sql, warehouseId, ...(catalog && { catalog }), ...(schema && { schema }) });

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
      'content-disposition': `attachment; filename="loom-databricks-${id}.iqy"`,
      'cache-control': 'no-store',
    },
  });
}
