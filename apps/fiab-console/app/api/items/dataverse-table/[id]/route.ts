/**
 * GET /api/items/dataverse-table/[id]?envId=<env> — table schema (attributes)
 *   id = table LogicalName (e.g. "account", "contact", "new_invoice").
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTable, getTableSchema, PowerPlatformError } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  try {
    const [table, attributes] = await Promise.all([
      getTable(envId, ctx.params.id),
      getTableSchema(envId, ctx.params.id),
    ]);
    return NextResponse.json({ ok: true, envId, table, attributes });
  } catch (e: any) { return err(e); }
}
