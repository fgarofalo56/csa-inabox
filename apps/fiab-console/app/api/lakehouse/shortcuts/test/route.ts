/**
 * POST /api/lakehouse/shortcuts/test
 *
 * Re-validate that a shortcut's target is reachable and update its registry
 * status. For ADLS/internal shortcuts this is a real listPaths on the Console
 * UAMI; for Tables shortcuts it additionally proves the engine object exists
 * via a SELECT TOP 1. Powers the list's Status chip + the Test action.
 *
 * Body: { lakehouseId, id }
 * Auth: session-required. Design: docs/fiab/design/lakehouse-shortcuts.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import { getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { resolveAndTestAdls } from '@/lib/azure/shortcut-engines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const id = (body?.id || '').toString().trim();
  if (!lakehouseId || !id) {
    return NextResponse.json({ ok: false, error: 'lakehouseId and id are required' }, { status: 400 });
  }

  const sc = await getShortcut(lakehouseId, id);
  if (!sc) return NextResponse.json({ ok: false, error: 'shortcut not found', code: 'not_found' }, { status: 404 });

  // External cloud sources are honest-gated until credential wiring lands.
  if (sc.targetType === 's3' || sc.targetType === 'gcs' || sc.targetType === 'dataverse') {
    const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
      `${sc.targetType.toUpperCase()} read-through is gated on Key Vault credential wiring (follow-up build).`);
    return NextResponse.json({ ok: true, data: updated });
  }

  try {
    await resolveAndTestAdls(sc.targetType, sc.targetUri, getAccountName);
    const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e: any) {
    const msg = sanitize(e);
    const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
    return NextResponse.json({ ok: false, error: msg, code: e?.code || 'unreachable', data: updated }, { status: 502 });
  }
}
