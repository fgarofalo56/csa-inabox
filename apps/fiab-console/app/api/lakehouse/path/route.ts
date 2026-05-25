/**
 * DELETE /api/lakehouse/path?container=&path=&recursive=true
 *   Deletes a file or directory.
 *
 * POST   /api/lakehouse/path?container=&path=
 *   Creates a directory (idempotent).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  createDirectory,
  deletePath,
  type KnownContainer,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function validate(req: NextRequest): { container: KnownContainer; path: string } | NextResponse {
  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  return { container: container as KnownContainer, path };
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const v = validate(req);
  if (v instanceof NextResponse) return v;
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';
  try {
    const res = await deletePath(v.container, v.path, recursive);
    return NextResponse.json({ ...res, container: v.container, path: v.path });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const v = validate(req);
  if (v instanceof NextResponse) return v;
  try {
    const res = await createDirectory(v.container, v.path);
    return NextResponse.json({ ...res, container: v.container, path: v.path }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
