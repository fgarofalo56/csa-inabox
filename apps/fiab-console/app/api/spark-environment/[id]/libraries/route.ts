/**
 * Custom library management for a spark-environment item.
 *
 *   POST   /api/spark-environment/[id]/libraries   (multipart/form-data)
 *            fields: file (.whl|.jar), type ('whl'|'jar', optional — inferred)
 *          → uploads the file to ADLS landing/spark-env-libs/<id>/<name>,
 *            records a LibraryInfo entry on state.customLibraries, returns it.
 *
 *   DELETE /api/spark-environment/[id]/libraries?name=<filename>
 *          → removes the entry from state.customLibraries and deletes the
 *            staged blob from ADLS (best-effort).
 *
 * Backend: ADLS Gen2 (uploadFile/deletePath). No Microsoft Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uploadFile, deletePath } from '@/lib/azure/adls-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';
const CONTAINER = 'landing';
// 256 MB cap — workspace packages well above what Synapse accepts inline.
const MAX_BYTES = 256 * 1024 * 1024;

interface LibraryInfo {
  name: string;
  path: string;          // relative path within the container
  containerName: string; // ADLS container, e.g. 'landing'
  type: 'whl' | 'jar';
  size?: number;
  uploadedAt?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return jerr(`invalid multipart body: ${e?.message || e}`, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return jerr('file part is required', 400);
  const f = file as File;
  const filename = (f.name || 'library.whl').replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = filename.toLowerCase().endsWith('.jar') ? 'jar' : 'whl';
  const type = ((form.get('type') || ext).toString() === 'jar' ? 'jar' : 'whl') as 'whl' | 'jar';

  const buf = Buffer.from(await f.arrayBuffer());
  if (buf.byteLength === 0) return jerr('file is empty', 400);
  if (buf.byteLength > MAX_BYTES) {
    return jerr(`file too large (${buf.byteLength} bytes > 256 MB)`, 413);
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);

    const path = `spark-env-libs/${id}/${filename}`;
    const contentType = type === 'jar' ? 'application/java-archive' : 'application/octet-stream';
    let res;
    try {
      res = await uploadFile(CONTAINER, path, buf, contentType);
    } catch (e: any) {
      // Honest infra gate: ADLS not provisioned / UAMI missing the role.
      return NextResponse.json({
        ok: false,
        error: e?.message || String(e),
        hint: 'Custom-library upload needs the LANDING ADLS container (LOOM_LANDING_URL) and the Console UAMI granted Storage Blob Data Contributor on it. See platform/fiab/bicep/modules/landing-zone/storage.bicep.',
      }, { status: 502 });
    }

    const state: any = item.state || {};
    const libs: LibraryInfo[] = Array.isArray(state.customLibraries) ? [...state.customLibraries] : [];
    const existingIdx = libs.findIndex((l) => l.name === filename);
    const entry: LibraryInfo = {
      name: filename,
      path,
      containerName: CONTAINER,
      type,
      size: res.size,
      uploadedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) libs[existingIdx] = entry; else libs.push(entry);

    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, customLibraries: libs },
    });
    if (!updated) return jerr('not found', 404);

    const account = (process.env.LOOM_LANDING_URL || '').replace(/^https?:\/\//, '').split('.')[0] || '';
    const abfssPath = account
      ? `abfss://${CONTAINER}@${account}.dfs.core.windows.net/${path}`
      : `${CONTAINER}/${path}`;
    return NextResponse.json({ ok: true, library: entry, abfssPath, customLibraries: libs }, { status: 201 });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return jerr('name query param is required', 400);

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const state: any = item.state || {};
    const libs: LibraryInfo[] = Array.isArray(state.customLibraries) ? state.customLibraries : [];
    const target = libs.find((l) => l.name === name);
    const remaining = libs.filter((l) => l.name !== name);

    // Best-effort blob delete — do not fail the state update if the blob is
    // already gone or ADLS is unreachable.
    if (target?.path) {
      try { await deletePath(target.containerName || CONTAINER, target.path); } catch { /* ignore */ }
    }

    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, customLibraries: remaining },
    });
    if (!updated) return jerr('not found', 404);
    return NextResponse.json({ ok: true, customLibraries: remaining });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
