/**
 * GET /api/items/dataverse-table/[id]/business-rules?envId=<env>
 *   id = table LogicalName. Returns business rules (workflows, category 2).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTableBusinessRules, PowerPlatformError } from '@/lib/azure/powerplatform-client';

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
  try {
    const businessRules = await getTableBusinessRules(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true, envId, businessRules });
  } catch (e: any) { return err(e); }
}
