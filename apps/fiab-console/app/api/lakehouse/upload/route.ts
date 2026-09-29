/**
 * POST /api/lakehouse/upload (multipart/form-data)
 * Fields: lakehouseId | reportId, container, path, file
 *
 * Accepts ANY file type readable by Apache Spark (parquet, delta, orc, avro,
 * json, csv, tsv, xml, geojson, geoparquet, shapefile, geotiff, raster, plain
 * binary, etc.). Returns 201 with a detected Spark format hint so the
 * lakehouse UI can show the user a one-line read snippet.
 *
 * Three request forms, each deciding where the file may land before any byte
 * is read or written:
 *
 *   ITEM FORM (`lakehouseId`) — what the lakehouse editor sends. Edit rights on
 *   the item are required; the file must sit strictly below the item's own
 *   root in its own container (`scopeItemPath`).
 *
 *   REPORT FORM (`reportId`) — what the report Get Data gallery sends. Edit
 *   rights on the report are required, and the file must be
 *   `landing/report-uploads/<reportId>/<file name>` (`scopeReportUpload`).
 *
 *   STORAGE FORM (neither) — names a container + path directly. Only a tenant
 *   admin may use it; everyone else is refused before any storage call.
 *
 * Returns 4xx with structured { ok:false, error } JSON on validation
 * failures. Never returns HTML — the caller can therefore safely parse the
 * body as JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_CONTAINERS, uploadFile, type KnownContainer } from '@/lib/azure/adls-client';
import { detectSparkFormat, renderReadSnippet } from '@/lib/azure/spark-format-detect';
import { withSession } from '@/lib/api/route-toolkit';
import { scopeItemPath } from '../_lib/item-scope';
import { scopeReportUpload } from '../_lib/report-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADLS Gen2 supports up to 5 TB per blob via append/flush; we cap server-side
// at 4 GB here to keep the in-process buffer manageable. For larger files,
// see /api/lakehouse/upload-stream (streamed, chunked) once landed.
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

const READ_ONLY_MESSAGE =
  'Your role on this lakehouse is read-only, so Loom did not upload the file. A workspace '
  + 'Member/Admin, or an item grant that includes Edit, can upload to it.';

export const POST = withSession(async (req: NextRequest, { session }) => {

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'invalid multipart body', detail: e?.message },
      { status: 400 },
    );
  }

  const lakehouseId = (form.get('lakehouseId') || '').toString().trim();
  const reportId = (form.get('reportId') || '').toString().trim();
  const rawContainer = (form.get('container') || '').toString().trim();
  const rawPath = (form.get('path') || '').toString();
  const file = form.get('file');

  if (!rawPath) {
    return NextResponse.json(
      { ok: false, error: 'path is required' },
      { status: 400 },
    );
  }

  // Decide the target before touching the file body.
  const scoped = reportId && !lakehouseId
    ? await scopeReportUpload(session, reportId, rawContainer, rawPath)
    : await scopeItemPath(
        session,
        { lakehouseId, container: rawContainer, rawPath },
        { write: true, readOnlyMessage: READ_ONLY_MESSAGE, knownContainers: KNOWN_CONTAINERS },
      );
  if (scoped instanceof NextResponse) return scoped;
  const { container, path } = scoped;

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
});
