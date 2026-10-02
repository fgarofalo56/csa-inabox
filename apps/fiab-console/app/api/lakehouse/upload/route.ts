/**
 * POST /api/lakehouse/upload (multipart/form-data)
 * Fields: lakehouseId | reportId (+ reportItemType), container, path, file
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
 *   REPORT FORM (`reportId`) — what the shared Get Data gallery sends, from a
 *   report, a semantic model or a paginated report (`reportItemType`, default
 *   `report`). Edit rights on that item are required, and the file must be
 *   `landing/report-uploads/<item id>/<file name>` (`scopeReportUpload`).
 *
 *   STORAGE FORM (neither) — names a container + path directly. Only a tenant
 *   admin may use it; everyone else is refused before any storage call.
 *
 * Returns 4xx with structured { ok:false, error, code, remediation } JSON on
 * validation failures. Never returns HTML — the caller can therefore safely parse the
 * body as JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_CONTAINERS, pathToHttpsUrlFor, uploadFile, type KnownContainer } from '@/lib/azure/adls-client';
import { dfsSuffix, httpsToAbfss } from '@/lib/azure/cloud-endpoints';
import { detectSparkFormat, renderReadSnippet } from '@/lib/azure/spark-format-detect';
import { withSession } from '@/lib/api/route-toolkit';
import { scopeItem } from '../_lib/refusal-envelope';
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
      { ok: false, error: 'invalid multipart body', detail: e?.message, code: 'bad_request', remediation: 'Send the file as multipart/form-data and retry.' },
      { status: 400 },
    );
  }

  const lakehouseId = (form.get('lakehouseId') || '').toString().trim();
  const reportId = (form.get('reportId') || '').toString().trim();
  const reportItemType = (form.get('reportItemType') || 'report').toString().trim();
  const rawContainer = (form.get('container') || '').toString().trim();
  const rawPath = (form.get('path') || '').toString();
  const file = form.get('file');

  if (!rawPath) {
    return NextResponse.json(
      { ok: false, error: 'path is required', code: 'bad_request', remediation: 'Name the target path and retry.' },
      { status: 400 },
    );
  }

  // Decide the target before touching the file body.
  const scoped = reportId && !lakehouseId
    ? await scopeReportUpload(session, reportId, rawContainer, rawPath, reportItemType)
    : await scopeItem(
        session,
        { lakehouseId, container: rawContainer, rawPath },
        { write: true, readOnlyMessage: READ_ONLY_MESSAGE, knownContainers: KNOWN_CONTAINERS },
      );
  if (scoped instanceof NextResponse) return scoped;
  const { container, path } = scoped;
  // The item form writes to the item's BOUND storage account. The report form
  // and the tenant-admin storage form carry none and use the container's
  // configured account.
  const boundAccount: unknown = 'account' in scoped ? scoped.account : undefined;
  const account = typeof boundAccount === 'string' && boundAccount ? boundAccount : undefined;

  if (!file || typeof file === 'string') {
    return NextResponse.json(
      { ok: false, error: 'file part is required', code: 'bad_request', remediation: 'Attach the file as the "file" part and retry.' },
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
      account,
    );
    const accountFromEnv =
      process.env[`LOOM_${container.toUpperCase()}_URL`] || '';
    const accountName = accountFromEnv
      .replace(/^https?:\/\//, '')
      .split('.')[0] || '';
    const abfssPath = account
      ? httpsToAbfss(pathToHttpsUrlFor(account, container, path))
      : accountName
        ? `abfss://${container}@${accountName}.${dfsSuffix()}/${path}`
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
