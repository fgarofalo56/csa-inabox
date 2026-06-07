/**
 * POST /api/thread/mirror-to-lakehouse — Loom Thread edge (mirrored-database).
 *
 * Weaves a mirrored database's replicated tables (CSV in ADLS Bronze) into a
 * Lakehouse by creating a real **file shortcut** per table pointing at its
 * Bronze path. The lakehouse then shows the mirrored data under Files and the
 * shortcut engine binds it — the Azure-native equivalent of adding a mirror as
 * a lakehouse source. Real Cosmos upserts (createShortcut); no mocks.
 *
 * Body: { from:{id,type,name}, values:{ lakehouseId } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { httpsToAbfss } from '@/lib/azure/mirror-engine';
import { createShortcut } from '@/lib/azure/lakehouse-shortcuts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const lakehouseId = String(body?.values?.lakehouseId || '').trim();
  if (from.type !== 'mirrored-database' || !from.id) {
    return NextResponse.json({ ok: false, error: 'this edge is for mirrored databases' }, { status: 400 });
  }
  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'pick a lakehouse' }, { status: 400 });

  const src = await loadOwnedItem(from.id, from.type, oid);
  if (!src) return NextResponse.json({ ok: false, error: 'mirrored database not found' }, { status: 404 });
  const lake = await loadOwnedItem(lakehouseId, 'lakehouse', oid);
  if (!lake) return NextResponse.json({ ok: false, error: 'lakehouse not found' }, { status: 404 });

  const tablesStatus: any[] = Array.isArray((src.state as any)?.tablesStatus) ? (src.state as any).tablesStatus : [];
  const replicated = tablesStatus.filter((t) => t.status === 'replicated' && t.path);
  if (!replicated.length) {
    return NextResponse.json(
      { ok: false, error: 'This mirror has no replicated tables yet. Open the mirror and click Start to snapshot its tables, then weave again.' },
      { status: 400 },
    );
  }

  const name = from.name || src.displayName;
  const parentPath = `mirrors/${name}`.replace(/[^A-Za-z0-9_/.-]/g, '_');
  const created: string[] = [];
  const failed: { table: string; error: string }[] = [];
  for (const t of replicated) {
    const shortcutName = `${t.schema}.${t.table}`;
    try {
      await createShortcut({
        lakehouseId,
        tenantId: oid,
        name: shortcutName,
        kind: 'files',
        parentPath,
        targetType: 'adls',
        targetUri: String(t.path),
        abfssUri: httpsToAbfss(String(t.path)),
        engine: 'synapse',
        createdBy: session.claims.upn || session.claims.email || oid,
        statusDetail: `Mirrored from ${name} (${t.schema}.${t.table})`,
      });
      created.push(shortcutName);
    } catch (e: any) {
      failed.push({ table: shortcutName, error: e?.message || String(e) });
    }
  }

  if (!created.length) {
    return NextResponse.json({ ok: false, error: `No shortcuts could be created: ${failed.map((f) => `${f.table}: ${f.error}`).join('; ')}` }, { status: 500 });
  }

  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: name,
    toItemId: lake.id, toType: 'lakehouse', toName: lake.displayName,
    action: 'mirror-to-lakehouse',
  });

  const failNote = failed.length ? ` (${failed.length} failed: ${failed.map((f) => f.table).join(', ')})` : '';
  return NextResponse.json({
    ok: true,
    message: `Added ${created.length} shortcut(s) to lakehouse "${lake.displayName}" under Files/${parentPath}${failNote}. Open the lakehouse to work with the mirrored data.`,
    link: `/items/lakehouse/${lake.id}`,
    linkLabel: 'Open the Lakehouse',
  });
}
