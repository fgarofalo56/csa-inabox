/**
 * POST /api/lakehouse/upload (multipart/form-data)
 * Fields: container, path, file
 *
 * Accepts ANY file type readable by Apache Spark (parquet, delta, orc, avro,
 * json, csv, tsv, xml, geojson, geoparquet, shapefile, geotiff, raster, plain
 * binary, etc.). Returns 201 with a detected Spark format hint so the
 * lakehouse UI can show the user a one-line read snippet.
 *
 * Returns 4xx with structured { ok:false, error } JSON on validation
 * failures. Never returns HTML — the caller can therefore safely parse the
 * body as JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, uploadFile, type KnownContainer } from '@/lib/azure/adls-client';
import { detectSparkFormat, renderReadSnippet } from '@/lib/azure/spark-format-detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADLS Gen2 supports up to 5 TB per blob via append/flush; we cap server-side
// at 4 GB here to keep the in-process buffer manageable. For larger files,
// see /api/lakehouse/upload-stream (streamed, chunked) once landed.
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: 'unauthenticated' },
      { status: 401 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'invalid multipart body', detail: e?.message },
      { status: 400 },
    );
  }

  const container = (form.get('container') || '').toString();
  const path = (form.get('path') || '').toString();
  const file = form.get('file');

  if (!container || !path) {
    return NextResponse.json(
      { ok: false, error: 'container and path are required' },
      { status: 400 },
    );
  }
  // Folder drag-and-drop sends a multi-segment relative path. Reject traversal
  // (`..`) and absolute paths so a crafted folder name can't escape the
  // container root.
  if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    return NextResponse.json(
      { ok: false, error: 'invalid path: must be a relative path without ".." segments' },
      { status: 400 },
    );
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json(
      { ok: false, error: `unknown container: ${container}` },
      { status: 404 },
    );
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json(
      { ok: false, error: 'file part is required' },
      { status: 400 },
    );
  }

  const f = file as File;
  const filename = (f.name || path.split('/').pop() || 'upload.bin');

  const arrayBuf = await f.arrayBuffer();
  if (arrayBuf.byteLength > MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `file too large (${arrayBuf.byteLength} bytes > ${MAX_BYTES} bytes / 4 GB)`,
        hint: 'For larger files use ADF, AzCopy, or azcopy through a Bastion-jumpbox.',
      },
      { status: 413 },
    );
  }
  const buf = Buffer.from(arrayBuf);

  // Detect the Spark format from filename + sender-provided content-type.
  // Fall back to the detector's preferred mime when the browser sent a
  // generic 'application/octet-stream' (common for parquet/avro/orc).
  const browserContentType = f.type || '';
  const hint = detectSparkFormat(filename, browserContentType);
  const contentType =
    browserContentType && browserContentType !== 'application/octet-stream'
      ? browserContentType
      : hint.mimeType;

  try {
    const res = await uploadFile(
      container as KnownContainer,
      path,
      buf,
      contentType,
    );
    const accountFromEnv =
      process.env[`LOOM_${container.toUpperCase()}_URL`] || '';
    const accountName = accountFromEnv
      .replace(/^https?:\/\//, '')
      .split('.')[0] || '';
    const abfssPath = accountName
      ? `abfss://${container}@${accountName}.dfs.core.windows.net/${path}`
      : `${container}/${path}`;
    return NextResponse.json(
      {
        ok: true,
        size: res.size,
        etag: res.etag,
        container,
        path,
        contentType,
        filename,
        uploadedBy: session.claims.upn,
        sparkFormat: {
          format: hint.format,
          label: hint.label,
          readSnippet: renderReadSnippet(hint, abfssPath),
          native: hint.native,
          connector: hint.connector,
        },
        abfssPath,
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
