/**
 * GET  /api/downloads — recent downloads for the signed-in user
 * POST /api/downloads — record a download (filename, sourceItemId?, sizeBytes?)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { downloadsContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await downloadsContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT TOP 25 * FROM c WHERE c.userId = @u ORDER BY c._ts DESC',
      parameters: [{ name: '@u', value: s.claims.oid }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, downloads: resources });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.filename) return NextResponse.json({ ok: false, error: 'filename required' }, { status: 400 });
  const c = await downloadsContainer();
  const doc = {
    id: crypto.randomUUID(),
    userId: s.claims.oid,
    filename: body.filename,
    sourceItemId: body.sourceItemId || null,
    sourceItemType: body.sourceItemType || null,
    sizeBytes: body.sizeBytes || 0,
    contentType: body.contentType || null,
    downloadedAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, download: resource }, { status: 201 });
}
