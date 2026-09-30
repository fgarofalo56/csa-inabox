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
 *
 * DELETE scope (#4619): the blob DELETE removes is RE-DERIVED on the server as
 * `landing/spark-env-libs/<this environment's id>/<name>` — the exact location
 * POST writes — and the recorded entry must name that location. The recorded
 * `path` / `containerName` are item state, which is not a trusted source of a
 * storage target, so an entry naming any other container or path is refused
 * with 400 and nothing is deleted or rewritten.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { uploadFile, deletePath } from '@/lib/azure/adls-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';
import { blobRelPathError } from '@/lib/util/blob-rel-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';
const CONTAINER = 'landing';
/** Every library blob lives under `<LIB_ROOT>/<environment id>/<file name>`. */
const LIB_ROOT = 'spark-env-libs';
// 256 MB cap — workspace packages well above what Synapse accepts inline.
const MAX_BYTES = 256 * 1024 * 1024;
/** The charset POST's filename sanitiser produces (`[^A-Za-z0-9._-]` → `_`). */
const LIB_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;

interface LibraryInfo {
  name: string;
  path: string;          // relative path within the container
  containerName: string; // ADLS container, e.g. 'landing'
  type: 'whl' | 'jar';
  size?: number;
  uploadedAt?: string;
}

/** A single path segment: non-empty, no separator, not a dot segment. */
function isPlainSegment(s: unknown): s is string {
  return typeof s === 'string' && s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\');
}

/**
 * The library roots this environment owns. Both the id the caller addressed and
 * the id of the item `loadOwnedItem` resolved are admitted, because the list
 * route hands the editor a `loom:`-prefixed synthetic id that `loadOwnedItem`
 * resolves to the Cosmos id, and POST recorded whichever form it was called
 * with. Both name the SAME authorized item; neither comes from item state.
 */
function libraryRoots(routeId: string, itemId: unknown): string[] {
  const ids = new Set<string>();
  for (const x of [routeId, itemId]) if (isPlainSegment(x)) ids.add(x);
  return [...ids].map((x) => `${LIB_ROOT}/${x}/`);
}

/**
 * The container-relative path to delete for `lib`, or null when the recorded
 * entry does not name this environment's own library location.
 */
function ownedLibraryPath(lib: LibraryInfo, roots: string[]): string | null {
  if (!isPlainSegment(lib?.name) || !LIB_NAME_RE.test(lib.name)) return null;
  if ((lib.containerName ?? CONTAINER) !== CONTAINER) return null;
  if (typeof lib.path !== 'string' || blobRelPathError(lib.path)) return null;
  for (const root of roots) {
    const derived = `${root}${lib.name}`;
    if (lib.path === derived) return derived;
  }
  return null;
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;

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

    const path = `${LIB_ROOT}/${id}/${filename}`;
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
});

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return jerr('name query param is required', 400);
  if (!isPlainSegment(name) || !LIB_NAME_RE.test(name)) {
    return jerr('name must be a library file name: letters, digits, ".", "_" or "-", with no path separators', 400);
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const state: any = item.state || {};
    const libs: LibraryInfo[] = Array.isArray(state.customLibraries) ? state.customLibraries : [];
    const target = libs.find((l) => l.name === name);
    const remaining = libs.filter((l) => l.name !== name);

    if (target) {
      const blobPath = ownedLibraryPath(target, libraryRoots(id, item.id));
      if (!blobPath) {
        return jerr(
          `library "${name}" is recorded at a location outside this environment's library folder `
          + `(${CONTAINER}/${LIB_ROOT}/<environment id>/), so nothing was deleted. Re-upload the library to replace the entry.`,
          400,
        );
      }
      // Best-effort blob delete — do not fail the state update if the blob is
      // already gone or ADLS is unreachable.
      try { await deletePath(CONTAINER, blobPath); } catch { /* ignore */ }
    }

    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, customLibraries: remaining },
    });
    if (!updated) return jerr('not found', 404);
    return NextResponse.json({ ok: true, customLibraries: remaining });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
