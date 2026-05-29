/**
 * GET  /api/items/apim-api/[id]/revisions      — list revisions + releases
 * POST /api/items/apim-api/[id]/revisions       — create a new revision.
 *        body: { apiRevision, sourceApiRevision?, description?, release?, notes? }
 *        When release=true, the new revision is immediately released (made current).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listApiRevisions, createApiRevision, listApiReleases, createApiRelease, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  try {
    const [revisions, releases] = await Promise.all([listApiRevisions(id), listApiReleases(id)]);
    return NextResponse.json({ ok: true, revisions, releases });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const apiRevision = String(body?.apiRevision || '').trim();
  if (!apiRevision) return NextResponse.json({ ok: false, error: 'apiRevision is required' }, { status: 400 });
  try {
    const api = await createApiRevision(id, apiRevision, {
      sourceApiRevision: body?.sourceApiRevision ? String(body.sourceApiRevision) : undefined,
      description: body?.description ? String(body.description) : undefined,
    });
    let release;
    if (body?.release) {
      release = await createApiRelease(id, apiRevision, body?.notes ? String(body.notes) : undefined);
    }
    return NextResponse.json({ ok: true, api, release });
  } catch (e: any) { return handleErr(e); }
}
