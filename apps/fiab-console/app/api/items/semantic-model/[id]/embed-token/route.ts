/**
 * POST /api/items/semantic-model/[id]/embed-token
 *
 * Body: { workspaceId: string }
 * Returns: { ok, token, tokenId, expiration }
 *
 * Semantic models (datasets in Power BI REST) GenerateToken returns a
 * Q&A-capable embed token. The semantic-model editor uses this to wire
 * the Q&A pane + the relationship-view preview.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateDatasetEmbedToken, getDataset, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [tokenResp, dataset] = await Promise.all([
      generateDatasetEmbedToken(workspaceId, ctx.params.id, 'View'),
      getDataset(workspaceId, ctx.params.id),
    ]);
    return NextResponse.json({
      ok: true,
      ...tokenResp,
      datasetId: dataset.id,
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
