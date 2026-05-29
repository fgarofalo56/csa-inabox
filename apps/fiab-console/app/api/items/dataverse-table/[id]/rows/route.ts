/**
 * GET /api/items/dataverse-table/[id]/rows?envId=<env>&entitySet=<set>&top=25
 *   id = table LogicalName (kept for symmetry). entitySet is the OData
 *   EntitySetName (e.g. "accounts"). Returns real business-data rows.
 *   (Named "rows" not "data" — the repo .gitignore excludes any `data/` dir.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTable, getTableData, PowerPlatformError } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  const top = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get('top') || '25')));
  try {
    const logicalName = (await ctx.params).id;
    let entitySet = req.nextUrl.searchParams.get('entitySet') || '';
    if (!entitySet) {
      // Resolve EntitySetName from the table definition if not supplied.
      const table = await getTable(envId, logicalName);
      entitySet = table.EntitySetName || `${logicalName}s`;
    }
    const data = await getTableData(envId, entitySet, top);
    return NextResponse.json({ ok: true, envId, entitySet, ...data });
  } catch (e: any) { return err(e); }
}
