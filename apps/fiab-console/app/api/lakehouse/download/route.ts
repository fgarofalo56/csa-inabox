/**
 * GET /api/lakehouse/download?container=&path=
 *
 * Streams a file's bytes from ADLS Gen2 to the browser with a
 * Content-Disposition: attachment header so the lakehouse explorer's
 * right-click "Download" command works (Fabric lakehouse explorer parity).
 *
 * Real backend: @azure/storage-file-datalake readToBuffer via the BFF UAMI
 * (Storage Blob Data Reader). No mock data.
 *
 * On error returns JSON { ok:false, error } so the caller can surface it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, downloadFile } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function leaf(path: string): string {
  const t = path.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    const { body, contentType, size } = await downloadFile(container, path);
    const filename = leaf(path) || 'download.bin';
    return new NextResponse(body as any, {
      status: 200,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
