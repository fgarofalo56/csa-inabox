/**
 * Item-level Lakehouse Shortcut — single-row operations.
 *
 *   DELETE /api/items/[type]/[id]/shortcuts/[name]  → drop engine obj + row
 *   PATCH  /api/items/[type]/[id]/shortcuts/[name]  → rename / move / re-format
 *
 * `[id]` is the destination lakehouse; `[name]` is the shortcut's deterministic
 * registry id (URL-encoded). Auth: caller's tenant must own the item's
 * workspace (loadOwnedItem). Standard envelope `{ ok, data?, error?, code? }`.
 *
 * DELETE never touches the underlying source bytes (UC/Fabric semantics) — it
 * drops the registry row + the engine object (external table) only.
 *
 * PATCH renames/moves by re-creating the shortcut at its new deterministic id
 * (a real ADLS reachability probe + engine re-registration) and dropping the
 * old engine object + row. `format` changes re-register the engine object too.
 *
 * Per no-vaporware.md — real Cosmos + ADLS/engine calls, no mock.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getShortcut,
  deleteShortcut,
  dropShortcutObject,
  createInternalShortcut,
  type ShortcutKind,
} from '@/lib/azure/shortcut-client';
import { shortcutId } from '@/lib/azure/lakehouse-shortcuts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: ShortcutKind[] = ['files', 'tables'];
const FORMATS = ['delta', 'parquet', 'csv', 'json'] as const;

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ type: string; id: string; name: string }> }) {
  const { type, id, name } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const scId = decodeURIComponent(name);
  try {
    const existing = await getShortcut(id, scId);
    if (existing) {
      // Drop the engine object (external table) — NEVER the underlying bytes.
      await dropShortcutObject({ engine: existing.engine, engineObject: existing.engineObject }).catch(() => {
        /* best-effort: a missing/already-dropped object must not block row delete */
      });
    }
    await deleteShortcut(id, scId);
    return NextResponse.json({ ok: true, data: { id: scId } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string; name: string }> }) {
  const { type, id, name } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const scId = decodeURIComponent(name);
  const existing = await getShortcut(id, scId);
  if (!existing) return NextResponse.json({ ok: false, error: 'shortcut not found', code: 'not_found' }, { status: 404 });

  // Internal-only route (matches the create endpoint's scope).
  if (existing.targetType !== 'internal') {
    return NextResponse.json(
      { ok: false, code: 'non_internal_use_flat_route', error: 'Edit external shortcuts via /api/lakehouse/shortcuts.' },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  // displayName is the user-facing alias for the shortcut's `name` (which is
  // also its id component). Accept either key.
  const newName = ((body?.name ?? body?.displayName) as string | undefined)?.toString().trim() ?? existing.name;
  const newKind = ((body?.kind as string | undefined)?.toString() as ShortcutKind) ?? existing.kind;
  const newParentPath =
    body?.parentPath !== undefined ? (body.parentPath as string).toString() : existing.parentPath;
  const newFormat = (body?.format as (typeof FORMATS)[number] | undefined) ?? existing.format;

  if (!/^[A-Za-z0-9 _.-]{1,128}$/.test(newName)) {
    return NextResponse.json(
      { ok: false, error: 'name must be 1-128 chars (letters, digits, space, _ . -)' },
      { status: 400 },
    );
  }
  if (!KINDS.includes(newKind)) {
    return NextResponse.json({ ok: false, error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 });
  }
  if (newFormat && !FORMATS.includes(newFormat)) {
    return NextResponse.json({ ok: false, error: `format must be one of ${FORMATS.join(', ')}` }, { status: 400 });
  }

  const cleanParent = (newParentPath || '').replace(/^\/+|\/+$/g, '');
  const newId = shortcutId(id, newKind, cleanParent, newName);

  try {
    // Re-create at the new id (real ADLS reachability probe + engine
    // re-registration for Tables). createInternalShortcut upserts the row.
    const result = await createInternalShortcut({
      lakehouseId: id,
      tenantId: existing.tenantId,
      name: newName,
      kind: newKind,
      parentPath: cleanParent,
      targetUri: existing.targetUri,
      format: newFormat,
      createdBy: existing.createdBy,
    });

    // If the deterministic id changed (rename / move / kind change), drop the
    // old engine object + delete the stale row. Best-effort — never bytes.
    if (newId !== scId) {
      await dropShortcutObject({ engine: existing.engine, engineObject: existing.engineObject }).catch(() => {});
      await deleteShortcut(id, scId).catch(() => {});
    }

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, code: result.gate.code, error: result.gate.hint, hint: result.gate.hint, data: result.shortcut },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, data: result.shortcut });
  } catch (e: any) {
    if (e?.code === 'bad_target') {
      return NextResponse.json({ ok: false, error: sanitize(e), code: 'bad_target' }, { status: 400 });
    }
    const msg = sanitize(e);
    const denied = e?.statusCode === 403 || /\b403\b|forbidden|denied/i.test(msg);
    return NextResponse.json(
      { ok: false, code: denied ? 'adls_access_denied' : 'adls_unreachable', error: msg },
      { status: 502 },
    );
  }
}
