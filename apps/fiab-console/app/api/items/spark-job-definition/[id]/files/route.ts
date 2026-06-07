/**
 * POST /api/items/spark-job-definition/[id]/files  (multipart/form-data)
 * Fields: kind ('main' | 'reference'), file
 *
 * Uploads the main definition file (.py / .jar / .R) or a reference file to
 * the workspace ADLS Gen2 `landing` container under
 *   sjd/<itemId>/<Main|Refs>/<filename>
 * and returns the full `abfss://` URI so the editor can record it in the
 * spec. This is the "Upload from local" path that parallels pasting an ABFSS
 * URI by hand. Real ADLS write — no placeholder.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uploadFile } from '@/lib/azure/adls-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';
// Job binaries / reference modules are small; cap the in-process buffer at 256 MB.
const MAX_BYTES = 256 * 1024 * 1024;
const CONTAINER = 'landing';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);

    let form: FormData;
    try { form = await req.formData(); }
    catch (e: any) { return jerr(`invalid multipart body: ${e?.message || e}`, 400); }

    const kind = (form.get('kind') || 'reference').toString();
    const file = form.get('file');
    if (!file || typeof file === 'string') return jerr('file part is required', 400);

    const f = file as File;
    const filename = (f.name || 'upload.bin').replace(/[^A-Za-z0-9_.-]/g, '_');
    const arrayBuf = await f.arrayBuffer();
    if (arrayBuf.byteLength > MAX_BYTES) {
      return jerr(`file too large (${arrayBuf.byteLength} bytes > ${MAX_BYTES} bytes / 256 MB)`, 413);
    }
    const buf = Buffer.from(arrayBuf);
    const sub = kind === 'main' ? 'Main' : 'Refs';
    const path = `sjd/${id}/${sub}/${filename}`;

    const accountFromEnv = process.env[`LOOM_${CONTAINER.toUpperCase()}_URL`];
    if (!accountFromEnv) {
      return jerr(
        `ADLS not configured: set LOOM_${CONTAINER.toUpperCase()}_URL (provisioned by the DLZ storage bicep module) to upload files. You can paste an abfss:// URI directly instead.`,
        400, 'adls_not_configured',
      );
    }
    const accountName = accountFromEnv.replace(/^https?:\/\//, '').split('.')[0] || '';
    await uploadFile(CONTAINER, path, buf, f.type || 'application/octet-stream');
    const abfssPath = `abfss://${CONTAINER}@${accountName}.dfs.core.windows.net/${path}`;
    return NextResponse.json({ ok: true, filename, path, abfssPath, size: buf.length }, { status: 201 });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
