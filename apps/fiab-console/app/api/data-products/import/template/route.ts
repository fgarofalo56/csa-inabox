/**
 * GET /api/data-products/import/template
 *
 * Returns a valid sample CSV with the exact column headers the bulk importer
 * expects, so users can download → fill → re-upload. Required columns:
 *   name, description, domain, owner
 * Optional columns:
 *   tags  (semicolon-separated, e.g. "finance;daily")
 *
 * Real, downloadable file — no mock. The header row here is the single source
 * of truth for the importer's column contract (see lib/util/csv-parse.ts).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SAMPLE_CSV =
  'name,description,domain,owner,tags\r\n' +
  'Sales Product,Daily sales roll-up,Sales,alice@contoso.com,finance;daily\r\n' +
  'IoT Telemetry,Device sensor streams,Operations,bob@contoso.com,iot\r\n' +
  'Customer 360,CRM data lake view,Marketing,carol@contoso.com,crm;marketing\r\n';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  return new NextResponse(SAMPLE_CSV, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="data-products-import-template.csv"',
      'cache-control': 'no-store',
    },
  });
}
