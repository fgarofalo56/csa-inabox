/**
 * POST /api/items/notebook/import
 *
 * Imports a desktop notebook file directly into a Loom workspace as a
 * native Loom notebook item with its cells fully populated.
 *
 * Body: { workspaceId, filename, contentBase64 }
 *   - workspaceId    target Loom workspace (must be tenant-owned)
 *   - filename       original filename (drives format detection)
 *   - contentBase64  base64-encoded file bytes
 *
 * Flow: decode → parseNotebookFile → createOwnedItem('notebook', …) with
 * state.cells + state.defaultLang (the exact shape NotebookEditor reads via
 * its cell-based loadDetail path). Returns { ok, id } on success.
 *
 * No mocks — the file is really parsed and a real Cosmos item is created.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr } from '../../_lib/item-crud';
import { parseNotebookFile } from '@/lib/notebook/import-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'notebook';

/** Derive a display name from the uploaded filename (drop extension/path). */
function nameFromFilename(filename: string): string {
  const base = String(filename || '').split(/[\\/]/).pop() || 'Imported notebook';
  return base.replace(/\.[^.]+$/, '').trim() || 'Imported notebook';
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);

  const body = await req.json().catch(() => ({} as any));
  const { workspaceId, filename, contentBase64 } = (body || {}) as {
    workspaceId?: string;
    filename?: string;
    contentBase64?: string;
  };

  if (!workspaceId) return jerr('workspaceId is required', 400);
  if (!filename) return jerr('filename is required', 400);
  if (!contentBase64) return jerr('contentBase64 is required', 400);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(contentBase64, 'base64');
  } catch (e: any) {
    return jerr(`could not decode contentBase64: ${e?.message || e}`, 400);
  }
  if (bytes.length === 0) return jerr('uploaded file is empty', 400);

  let parsed;
  try {
    parsed = parseNotebookFile(new Uint8Array(bytes), filename);
  } catch (e: any) {
    return jerr(`could not parse notebook: ${e?.message || e}`, 422);
  }

  try {
    const r = await createOwnedItem(session, ITEM_TYPE, {
      workspaceId,
      displayName: nameFromFilename(filename),
      description: `Imported from ${String(filename).split(/[\\/]/).pop()}`,
      state: {
        cells: parsed.cells,
        defaultLang: parsed.defaultLang,
      },
    });
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json(
      { ok: true, id: r.item.id, cellCount: parsed.cells.length, defaultLang: parsed.defaultLang },
      { status: 201 },
    );
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
