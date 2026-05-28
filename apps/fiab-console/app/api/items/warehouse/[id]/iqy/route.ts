/**
 * POST /api/items/warehouse/[id]/iqy
 *   body: { sql }
 *
 * Generates a .iqy web-query file pointed at the Loom warehouse query
 * route, signed with the current session so Excel can replay the same
 * T-SQL on demand. Returns a downloadable text blob.
 *
 * The .iqy format is 4 lines:
 *   WEB
 *   1
 *   <URL the query is posted to>
 *   <query string or POST body>
 *
 * Modern Excel honours POST data when line 4 carries the JSON body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  if (!sql) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });

  // The .iqy WEB endpoint is the same warehouse query route Excel will
  // call when the user refreshes the data connection.
  const origin = req.nextUrl.origin;
  const target = `${origin}/api/items/warehouse/${encodeURIComponent(ctx.params.id)}/query`;
  const iqy = [
    'WEB',
    '1',
    target,
    JSON.stringify({ sql }),
    '',
    "Selection=AllTables",
    "Formatting=All",
    "PreFormattedTextToColumns=True",
    "ConsecutiveDelimitersAsOne=True",
    "SingleBlockTextImport=False",
    "DisableDateRecognition=False",
    "DisableRedirections=False",
  ].join('\r\n');

  return new NextResponse(iqy, {
    status: 200,
    headers: {
      'content-type': 'text/x-ms-iqy; charset=utf-8',
      'content-disposition': `attachment; filename="loom-warehouse-${ctx.params.id}.iqy"`,
      'cache-control': 'no-store',
    },
  });
}
