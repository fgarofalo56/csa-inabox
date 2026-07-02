/**
 * GET /api/items/dataset/[id]/lineage?project=<name> — real producers/consumers
 * of a data asset, derived from AML jobs that reference it (inputs = consumers,
 * outputs = producers). No mock data; empty arrays when nothing references it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataAssetLineage, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project') || undefined;
  try {
    const lineage = await getDataAssetLineage((await ctx.params).id, project);
    return NextResponse.json({ ok: true, ...lineage });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
