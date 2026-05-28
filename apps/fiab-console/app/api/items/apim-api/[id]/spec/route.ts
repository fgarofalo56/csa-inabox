/** GET /api/items/apim-api/[id]/spec?format=openapi+json — exports OpenAPI spec */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApiSpec, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const fmt = (req.nextUrl.searchParams.get('format') || 'openapi+json') as
    'openapi' | 'openapi+json' | 'swagger';
  try {
    const spec = await getApiSpec((await ctx.params).id, fmt);
    if (!spec) return NextResponse.json({ ok: false, error: 'no spec', status: 404 }, { status: 404 });
    return NextResponse.json({ ok: true, ...spec });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
