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
import { resolveAndTestAdls, testEngineObject } from '@/lib/azure/shortcut-engines';

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

  // S3 / GCS: the read-through binding is the engine object (UC external table /
  // Synapse external view). Prove it with a real SELECT TOP 1 against the engine.
  if (sc.targetType === 's3' || sc.targetType === 'gcs') {
    if (!sc.engineObject || !sc.engine || sc.engine === 'none') {
      const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
        `${sc.targetType.toUpperCase()} shortcut has no engine binding yet — re-create it with a Key Vault credentialRef.`);
      return NextResponse.json({ ok: true, data: updated });
    }
    try {
      await testEngineObject(sc.engine, sc.engineObject);
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'engine_unreachable', data: updated }, { status: 502 });
    }
  }

  // ADLS / internal / Dataverse all resolve to an abfss path read on the UAMI.
  // For Dataverse the abfssUri was set at create time from the Synapse-Link
  // linked storage; re-test reachability of that path.
  try {
    if (sc.targetType === 'dataverse') {
      if (!sc.abfssUri) {
        const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
          'Dataverse shortcut has no resolved storage path yet — re-create it with a Key Vault credentialRef.');
        return NextResponse.json({ ok: true, data: updated });
      }
      await resolveAndTestAdls('adls', sc.abfssUri, getAccountName);
    } else {
      await resolveAndTestAdls(sc.targetType, sc.targetUri, getAccountName);
    }
    const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e: any) {
    const msg = sanitize(e);
    const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
    return NextResponse.json({ ok: false, error: msg, code: e?.code || 'unreachable', data: updated }, { status: 502 });
  }
}
