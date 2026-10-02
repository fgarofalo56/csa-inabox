/**
 * GET /api/lakehouse/download?lakehouseId=&container=&path=[&labelId=&labelName=&labelMethod=]
 *
 * Streams a file's bytes from ADLS Gen2 to the browser with a
 * Content-Disposition: attachment header so the lakehouse explorer's
 * right-click "Download" command works (Fabric lakehouse explorer parity).
 *
 * The file is resolved through the lakehouse item (`scopeItemPath` in
 * `../_lib/item-scope`): `lakehouseId` is authorized (404 when the caller
 * cannot reach it) and `container` + `path` must lie strictly below that
 * item's storage root. Without `lakehouseId` only a tenant admin may name a
 * storage path directly.
 *
 * MIP sensitivity-label stamp (F5):
 *   For supported document types (PDF + Office Open XML) the proxy stamps the
 *   bytes with a MIP sensitivity label before streaming them — the same
 *   MSIP_Label_<GUID>_* metadata the native MIP SDK writes (see
 *   lib/azure/mip-file-inject.ts). The label is either:
 *     (a) explicitly CHOSEN by the caller (labelId + labelName query params), or
 *     (b) resolved from the file's Microsoft Purview catalog entry
 *         (LOOM_PURVIEW_ACCOUNT) when no explicit label is supplied.
 *   The outcome is reported back in the `x-loom-mip-status` response header so
 *   the UI can confirm the stamp or surface an honest gate. Where MIP is
 *   unavailable (no Purview, no label, or a type that can't be stamped) the
 *   download STILL succeeds with the original bytes — never blocked.
 *
 * Real backend: @azure/storage-file-datalake readToBuffer via the BFF UAMI
 * (Storage Blob Data Reader) + Purview Atlas Data Map lookup. No mock data.
 *
 * On error returns JSON { ok:false, error } so the caller can surface it.
 */

import { trimTrailingSlashes } from '@/lib/util/trim';
import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { KNOWN_CONTAINERS, downloadFile, getAccountName } from '@/lib/azure/adls-client';
import { getLabelForAdlsPath, type MipLabelInfo } from '@/lib/azure/purview-mip-client';
import { isMipSupportedType, stampMipLabel } from '@/lib/azure/mip-file-inject';
import { contentDisposition } from '@/lib/api/content-disposition';
import { withSession } from '@/lib/api/route-toolkit';
import { scopeItemPath } from '../_lib/item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function leaf(path: string): string {
  const t = trimTrailingSlashes(path);
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

/**
 * Resolve the label to stamp:
 *   - explicit caller-chosen label (labelId + labelName) wins;
 *   - else the file's Purview catalog label (best-effort, non-throwing).
 * Returns null when no label applies.
 */
async function resolveLabel(
  req: NextRequest,
  container: string,
  path: string,
  boundAccount: string | null,
): Promise<MipLabelInfo | null> {
  const labelId = req.nextUrl.searchParams.get('labelId') || '';
  const labelName = req.nextUrl.searchParams.get('labelName') || '';
  if (labelId) {
    return {
      labelId,
      labelName: labelName || labelId,
      setDate: new Date().toISOString(),
      siteId: process.env.LOOM_MSAL_TENANT_ID || process.env.AZURE_TENANT_ID || undefined,
      method: req.nextUrl.searchParams.get('labelMethod') === 'Privileged' ? 'Privileged' : 'Standard',
    };
  }
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return null;
  try {
    const account = boundAccount ?? getAccountName();
    return await getLabelForAdlsPath(account, container, path);
  } catch {
    return null; // Purview lookup failed — download proceeds unstamped.
  }
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const limited = await enforceRateLimit(session, 'export');
  if (limited) return limited;

  const rawContainer = req.nextUrl.searchParams.get('container') || '';
  const rawPath = req.nextUrl.searchParams.get('path') || '';
  if (!rawPath) {
    return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  }
  // The file must lie inside the caller's own lakehouse root (or, with no
  // lakehouseId, the caller must be a tenant admin). See ../_lib/item-scope.
  const scoped = await scopeItemPath(
    session,
    { lakehouseId: req.nextUrl.searchParams.get('lakehouseId') || '', container: rawContainer, rawPath },
    { knownContainers: KNOWN_CONTAINERS },
  );
  if (scoped instanceof NextResponse) return scoped;
  // `account` is the storage account the item is bound to; null only on the
  // tenant-admin storage form, which reads the deployment's primary account.
  const { container, path, account } = scoped;

  try {
    const { body, contentType } = await downloadFile(container, path, account ?? undefined);
    const filename = leaf(path) || 'download.bin';

    // ---- MIP stamp (never blocks the download) ----------------------------
    let finalBody: Buffer = body;
    // Status vocabulary surfaced to the UI:
    //   unsupported-type | not-configured | no-label | stamped |
    //   no-xmp-stream | pdf-insufficient-xmp-padding | ooxml-zip64-unsupported |
    //   ooxml-parse-failed | error
    let mipStatus = 'unsupported-type';
    let mipLabelName = '';
    if (isMipSupportedType(filename)) {
      const explicit = !!req.nextUrl.searchParams.get('labelId');
      if (!explicit && !process.env.LOOM_PURVIEW_ACCOUNT) {
        mipStatus = 'not-configured';
      } else {
        try {
          const label = await resolveLabel(req, container, path, account);
          if (!label) {
            mipStatus = 'no-label';
          } else {
            const res = stampMipLabel(body, filename, label);
            finalBody = res.body;
            mipStatus = res.status;
            if (res.status === 'stamped') mipLabelName = label.labelName;
          }
        } catch {
          mipStatus = 'error';
        }
      }
    }

    const headers: Record<string, string> = {
      'content-type': contentType || 'application/octet-stream',
      'content-length': String(finalBody.length),
      'content-disposition': contentDisposition('attachment', filename, 'download.bin'),
      'cache-control': 'no-store',
      'x-loom-mip-status': mipStatus,
    };
    if (mipLabelName) headers['x-loom-mip-label'] = encodeURIComponent(mipLabelName);

    return new NextResponse(finalBody as any, { status: 200, headers });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
});
