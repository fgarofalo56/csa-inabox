/**
 * POST /api/items/[type]/[id]/shortcuts/[name]/test
 *
 * Re-validate an internal lakehouse shortcut with a **live ADLS HEAD** against
 * its target path and update its registry status. This powers the list grid's
 * status pill + the per-row "Test" action.
 *
 *   - target reachable      → status='active'  → displayStatus 'OK'   (HTTP 200)
 *   - target missing (404)  → status='error'   → displayStatus 'Broken' (HTTP 502)
 *   - access denied (403)   → status='error'   → displayStatus 'Broken' (HTTP 502)
 *
 * `[id]` is the destination lakehouse; `[name]` is the shortcut's deterministic
 * registry id (URL-encoded). Auth: caller's tenant must own the item
 * (loadOwnedItem).
 *
 * Per no-vaporware.md — testInternalShortcut runs a real getMetadata/listPaths
 * call (+ a SELECT TOP 1 on the engine object for Tables). No mock.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { testInternalShortcut, displayStatus } from '@/lib/azure/shortcut-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, props: { params: Promise<{ type: string; id: string; name: string }> }) {
  const { type, id, name } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const scId = decodeURIComponent(name);
  const updated = await testInternalShortcut(id, scId);
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'shortcut not found', code: 'not_found' }, { status: 404 });
  }

  const pill = displayStatus(updated.status);
  if (updated.status === 'error') {
    return NextResponse.json(
      { ok: false, code: 'broken', error: updated.statusDetail || 'Shortcut target is broken.', displayStatus: pill, data: updated },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, displayStatus: pill, data: updated });
}
