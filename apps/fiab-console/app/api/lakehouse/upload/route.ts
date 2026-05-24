/**
 * POST /api/lakehouse/upload (multipart/form-data)
 * Fields: container, path, file
 * Returns 201 on success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, uploadFile, type KnownContainer } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'invalid multipart body' }, { status: 400 });
  }

  const container = (form.get('container') || '').toString();
  const path = (form.get('path') || '').toString();
  const file = form.get('file');

  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ ok: false, error: 'file part is required' }, { status: 400 });
  }

  const arrayBuf = await (file as File).arrayBuffer();
  if (arrayBuf.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `file too large (>${MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  const buf = Buffer.from(arrayBuf);
  const contentType = (file as File).type || 'application/octet-stream';

  try {
    const res = await uploadFile(container as KnownContainer, path, buf, contentType);
    return NextResponse.json(
      {
        ...res,
        container,
        path,
        contentType,
        uploadedBy: session.claims.upn,
      },
      { status: 201 },
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
