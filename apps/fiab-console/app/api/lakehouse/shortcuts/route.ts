/**
 * BFF for Lakehouse "Shortcuts" — Azure-native parity with Fabric OneLake
 * shortcuts, NO Fabric dependency. Standard envelope { ok, data?, error?, code?, hint? }.
 *
 *   GET    /api/lakehouse/shortcuts?lakehouseId=<id>     → list registry rows
 *   POST   /api/lakehouse/shortcuts                      → create (registry + engine)
 *   DELETE /api/lakehouse/shortcuts?lakehouseId=<id>&id=<id> → drop engine obj + row
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Design: docs/fiab/design/lakehouse-shortcuts.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import {
  listShortcuts,
  createShortcut,
  deleteShortcut,
  getShortcut,
  type ShortcutTargetType,
  type ShortcutKind,
  type ShortcutCredentialRef,
} from '@/lib/azure/lakehouse-shortcuts';
import {
  resolveAndTestAdls,
  createTablesShortcut,
  dropShortcutObject,
  externalSourceGate,
  type EngineGate,
} from '@/lib/azure/shortcut-engines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_TYPES: ShortcutTargetType[] = ['adls', 'internal', 's3', 'gcs', 'dataverse'];
const KINDS: ShortcutKind[] = ['files', 'tables'];

function isGate(x: unknown): x is EngineGate {
  return !!x && typeof x === 'object' && (x as EngineGate).gated === true;
}

/** Strip any HTML and collapse whitespace so a firewall/gateway page never leaks raw. */
function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });

  try {
    const data = await listShortcuts(lakehouseId);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const name = (body?.name || '').toString().trim();
  const kind = (body?.kind || '').toString() as ShortcutKind;
  const targetType = (body?.targetType || '').toString() as ShortcutTargetType;
  const targetUri = (body?.targetUri || '').toString().trim();
  const parentPath = (body?.parentPath || '').toString();
  const format = body?.format as ('delta' | 'parquet' | 'csv' | 'json' | undefined);
  const credentialRef = body?.credentialRef as ShortcutCredentialRef | undefined;

  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!/^[A-Za-z0-9 _.-]{1,128}$/.test(name)) {
    return NextResponse.json({ ok: false, error: 'name must be 1-128 chars (letters, digits, space, _ . -)' }, { status: 400 });
  }
  if (!KINDS.includes(kind)) return NextResponse.json({ ok: false, error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 });
  if (!TARGET_TYPES.includes(targetType)) {
    return NextResponse.json({ ok: false, error: `targetType must be one of ${TARGET_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!targetUri) return NextResponse.json({ ok: false, error: 'targetUri is required' }, { status: 400 });

  const createdBy = session.claims.upn;
  const tenantId = (session.claims as any).tid || (session.claims as any).tenantId;

  // --- External cloud sources (S3/GCS/Dataverse): honest-gate. ---
  const extGate = externalSourceGate(targetType, !!credentialRef?.keyVaultSecret);
  if (extGate) {
    return NextResponse.json({ ok: false, code: extGate.code, error: extGate.hint, hint: extGate.hint }, { status: 503 });
  }

  // --- ADLS Gen2 / internal Loom lakehouse: real UAMI resolve + reachability test. ---
  let abfssUri: string;
  try {
    const resolved = await resolveAndTestAdls(targetType, targetUri, getAccountName);
    abfssUri = resolved.abfssUri!;
  } catch (e: any) {
    if (e?.code === 'bad_target') {
      return NextResponse.json({ ok: false, error: sanitize(e), code: 'bad_target' }, { status: 400 });
    }
    const msg = sanitize(e);
    const denied = /\b403\b|forbidden|denied|not allowed/i.test(msg);
    return NextResponse.json(
      {
        ok: false,
        code: denied ? 'adls_access_denied' : 'adls_unreachable',
        error: denied
          ? `The Console UAMI cannot read the target. Grant it Storage Blob Data Reader on the target ` +
            `storage account, then retry. (${msg})`
          : `Target path not reachable: ${msg}`,
      },
      { status: 502 },
    );
  }

  // --- Tables shortcut: register a real external table. ---
  let engine: 'synapse' | 'databricks' | 'none' = 'none';
  let engineObject: string | undefined;
  if (kind === 'tables') {
    try {
      const reg = await createTablesShortcut({ lakehouseId, name, abfssUri, format });
      if (isGate(reg)) {
        // Persist as pending so the row exists with an honest status, then 503.
        const pending = await createShortcut({
          lakehouseId, tenantId, name, kind, parentPath, targetType, targetUri,
          abfssUri, credentialRef, engine: 'none', format,
          status: 'pending', statusDetail: reg.hint, createdBy,
        });
        return NextResponse.json({ ok: false, code: reg.code, error: reg.hint, hint: reg.hint, data: pending }, { status: 503 });
      }
      engine = reg.engine as 'synapse' | 'databricks';
      engineObject = reg.engineObject;
    } catch (e: any) {
      const msg = sanitize(e);
      // Persist as error so the operator can see + Test/Delete it.
      const errRow = await createShortcut({
        lakehouseId, tenantId, name, kind, parentPath, targetType, targetUri,
        abfssUri, credentialRef, engine: 'none', format,
        status: 'error', statusDetail: msg, createdBy,
      });
      return NextResponse.json({ ok: false, code: 'engine_error', error: msg, data: errRow }, { status: 502 });
    }
  }

  const row = await createShortcut({
    lakehouseId, tenantId, name, kind, parentPath, targetType, targetUri,
    abfssUri, credentialRef, engine, engineObject, format,
    status: 'active', createdBy,
  });
  return NextResponse.json({ ok: true, data: row });
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim();
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!lakehouseId || !id) {
    return NextResponse.json({ ok: false, error: 'lakehouseId and id are required' }, { status: 400 });
  }

  try {
    const existing = await getShortcut(lakehouseId, id);
    if (existing) {
      // Drop the engine object (external table) — NEVER the underlying bytes.
      await dropShortcutObject({ engine: existing.engine, engineObject: existing.engineObject }).catch(() => {
        /* best-effort: a missing/already-dropped object must not block row delete */
      });
    }
    await deleteShortcut(lakehouseId, id);
    return NextResponse.json({ ok: true, data: { id } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }
}
