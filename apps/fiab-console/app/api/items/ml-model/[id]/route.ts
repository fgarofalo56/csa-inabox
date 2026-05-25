/**
 * GET /api/items/ml-model/[id] — fetch one registered model + its versions.
 *   Response: { ok, model, versions }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getModel, listModelVersions, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const model = await getModel(ctx.params.id);
    if (!model) return NextResponse.json({ ok: false, error: 'not found', status: 404 }, { status: 404 });
    const versions = await listModelVersions(ctx.params.id).catch(() => []);
    return NextResponse.json({ ok: true, model, versions });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
