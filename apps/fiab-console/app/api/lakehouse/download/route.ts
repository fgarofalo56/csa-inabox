/**
 * GET /api/lakehouse/download?container=&path=[&labelId=&labelName=&labelMethod=]
 *
 * Streams a file's bytes from ADLS Gen2 to the browser with a
 * Content-Disposition: attachment header so the lakehouse explorer's
 * right-click "Download" command works (Fabric lakehouse explorer parity).
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

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { KNOWN_CONTAINERS, downloadFile, getAccountName } from '@/lib/azure/adls-client';
import { getLabelForAdlsPath, type MipLabelInfo } from '@/lib/azure/purview-mip-client';
import { isMipSupportedType, stampMipLabel } from '@/lib/azure/mip-file-inject';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function leaf(path: string): string {
  const t = path.replace(/\/+$/, '');
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
    const account = getAccountName();
    return await getLabelForAdlsPath(account, container, path);
  } catch {
    return null; // Purview lookup failed — download proceeds unstamped.
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'export');
  if (limited) return limited;

  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    const { body, contentType } = await downloadFile(container, path);
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
          const label = await resolveLabel(req, container, path);
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
      'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
      'x-loom-mip-status': mipStatus,
    };
    if (mipLabelName) headers['x-loom-mip-label'] = encodeURIComponent(mipLabelName);

    return new NextResponse(finalBody as any, { status: 200, headers });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
