/**
 * Item-level Lakehouse Shortcuts — internal (lakehouse-to-lakehouse) parity
 * with Microsoft Fabric OneLake **internal** shortcuts, NO Fabric dependency.
 *
 *   GET  /api/items/[type]/[id]/shortcuts        → list the item's registry rows
 *   POST /api/items/[type]/[id]/shortcuts        → create an internal shortcut
 *                                                   (real ADLS passthrough probe)
 *
 * `[id]` is the destination lakehouse (Cosmos item id, also the shortcut
 * registry partition key). Auth: caller's tenant must own the item's workspace
 * (loadOwnedItem). Standard envelope `{ ok, data?, error?, code?, hint? }`.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): internal shortcuts resolve to
 * the primary ADLS Gen2 account on the Console UAMI and work with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET. Non-internal target types (s3/gcs/
 * dataverse/delta_sharing/adls cross-account) are served by the flat route
 * `/api/lakehouse/shortcuts`, which carries the credential machinery.
 *
 * Per no-vaporware.md — real Cosmos + real ADLS calls, no mock arrays.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  listShortcuts,
  createInternalShortcut,
  type ShortcutKind,
} from '@/lib/azure/shortcut-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: ShortcutKind[] = ['files', 'tables'];
const FORMATS = ['delta', 'parquet', 'csv', 'json'] as const;

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function GET(_req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  try {
    const data = await listShortcuts(id);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const kind = (body?.kind || '').toString() as ShortcutKind;
  const targetType = (body?.targetType || 'internal').toString();
  const targetUri = (body?.targetUri || '').toString().trim();
  const parentPath = (body?.parentPath || '').toString();
  const format = body?.format as (typeof FORMATS)[number] | undefined;

  // --- Validation ---
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!/^[A-Za-z0-9 _.-]{1,128}$/.test(name)) {
    return NextResponse.json(
      { ok: false, error: 'name must be 1-128 chars (letters, digits, space, _ . -)' },
      { status: 400 },
    );
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ ok: false, error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 });
  }
  if (format && !FORMATS.includes(format)) {
    return NextResponse.json({ ok: false, error: `format must be one of ${FORMATS.join(', ')}` }, { status: 400 });
  }
  // This item-nested route is scoped to internal lakehouse-to-lakehouse parity.
  // External / cross-account sources carry credential machinery — route those
  // through the flat /api/lakehouse/shortcuts endpoint (honest redirect, not a
  // dead end).
  if (targetType !== 'internal') {
    return NextResponse.json(
      {
        ok: false,
        code: 'non_internal_use_flat_route',
        error:
          `This endpoint creates internal (lakehouse-to-lakehouse) shortcuts only. For ${targetType} ` +
          `sources use POST /api/lakehouse/shortcuts, which resolves the Key Vault credential and creates ` +
          `the external engine binding.`,
      },
      { status: 400 },
    );
  }
  if (!targetUri) return NextResponse.json({ ok: false, error: 'targetUri is required' }, { status: 400 });
  if (!/^internal:\/\/[^/]+/i.test(targetUri)) {
    return NextResponse.json(
      { ok: false, error: 'targetUri must be internal://<container>/<path>' },
      { status: 400 },
    );
  }

  const createdBy = session.claims.upn || session.claims.oid;
  const tenantId = session.claims.oid;

  try {
    const result = await createInternalShortcut({
      lakehouseId: id,
      tenantId,
      name,
      kind,
      parentPath,
      targetUri,
      format,
      createdBy,
    });
    if (!result.ok) {
      // Tables shortcut where no query engine is configured — persisted
      // 'pending' with an honest gate. 503 (the row exists; surface the hint).
      return NextResponse.json(
        { ok: false, code: result.gate.code, error: result.gate.hint, hint: result.gate.hint, data: result.shortcut },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, data: result.shortcut }, { status: 201 });
  } catch (e: any) {
    if (e?.code === 'bad_target') {
      return NextResponse.json({ ok: false, error: sanitize(e), code: 'bad_target' }, { status: 400 });
    }
    const msg = sanitize(e);
    const denied = e?.statusCode === 403 || /\b403\b|forbidden|denied|not allowed/i.test(msg);
    const missing = e?.statusCode === 404 || /\b404\b|not found|does not exist/i.test(msg);
    return NextResponse.json(
      {
        ok: false,
        code: denied ? 'adls_access_denied' : missing ? 'target_not_found' : 'adls_unreachable',
        error: denied
          ? `The Console UAMI cannot read the target lakehouse path. Grant it "Storage Blob Data Reader" ` +
            `on the storage account, then retry. (${msg})`
          : missing
          ? `Target lakehouse path not found: ${msg}`
          : `Target path not reachable: ${msg}`,
      },
      { status: denied ? 502 : missing ? 404 : 502 },
    );
  }
}
