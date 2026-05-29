/**
 * POST /api/items/semantic-model/[id]/take-over?workspaceId=...
 *
 * Transfers dataset ownership to the Console UAMI via the REAL Power BI REST:
 *   POST /groups/{ws}/datasets/{id}/Default.TakeOver   (groupId-scoped)
 *
 * Required before the UAMI can edit the refresh schedule / bind credentials
 * when another user or SP currently owns the dataset (PBI returns a 401/403
 * "not the dataset owner" on PATCH refreshSchedule otherwise). No mocks; PBI
 * errors surface verbatim.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/take-over-in-group
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { takeOverDataset, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await takeOverDataset(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true, tookOverAt: new Date().toISOString() });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
