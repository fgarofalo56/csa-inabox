/**
 * POST /api/items/graphql-api/[id]/publish
 *   Push the saved SDL spec for this item up to APIM as a GraphQL API
 *   (apiType=graphql). Body: { displayName, path, sdl, serviceUrl? }
 *   The Cosmos `state` itself is persisted via the generic
 *   PATCH /api/items/graphql-api/[id]. This route only handles the
 *   APIM-side publish action.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishGraphqlApi, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  const path = String(body?.path || '').trim();
  const sdl = String(body?.sdl || '');
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });
  if (!path) return NextResponse.json({ ok: false, error: 'path required' }, { status: 400 });
  if (!sdl.trim()) return NextResponse.json({ ok: false, error: 'sdl (schema) required' }, { status: 400 });
  try {
    const api = await publishGraphqlApi((await ctx.params).id, {
      displayName,
      path,
      sdl,
      protocols: ['https'],
      subscriptionRequired: body?.subscriptionRequired ?? true,
      serviceUrl: body?.serviceUrl,
      description: body?.description,
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
