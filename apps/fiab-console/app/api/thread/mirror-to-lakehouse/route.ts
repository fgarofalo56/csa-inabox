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
 *
 * ── THE MIRROR FOLDER IS ONE PATH SEGMENT ──────────────────────────────────
 * Every shortcut hangs under `Files/mirrors/<folder>`, where `<folder>` is
 * derived from the mirror's name (`from.name`, else the item's display name).
 * The Weave UI always sends the display name, and display names legitimately
 * contain spaces, dots and slashes, so the folder is DERIVED rather than the
 * request refused: `mirrorFolderSegment` maps every character outside
 * `[A-Za-z0-9_.-]` to `_` (which includes "/" and "\", so the result is always
 * one segment) and maps the two names that are not folder names, "." and "..",
 * to "_" and "__". For a name with no "/" other than "." and "..", this is
 * exactly the folder the route derived before. The shortcut registry's row id
 * flattens separators, so a name whose "/" are single and interior or trailing
 * keeps its row id and a re-weave moves the existing rows to the flat folder; a
 * leading or doubled "/" (and "." / "..") yields a new row id, so a re-weave
 * writes new rows beside the old ones. A non-string `from.name` falls back to
 * the display name.
 * The mapping is recorded, not guessed: each shortcut row stores the derived
 * `parentPath` and a `statusDetail` naming the source mirror, and the response
 * returns it as `path` (`mirrors/<folder>`).
 *
 * Route-toolkit: withSession (R3), behind a 1-arg `POST` adapter — this route
 * is a Weave bridge that `app/api/estate/execute/route.ts` dynamic-imports as
 * `(req: NextRequest) => Promise<Response>` (same shape as mirror-to-notebook).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { httpsToAbfss } from '@/lib/azure/mirror-engine';
import { createShortcut } from '@/lib/azure/lakehouse-shortcuts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Characters kept in a mirror folder name; everything else becomes `_`. */
const MIRROR_FOLDER_UNSAFE_RE = /[^A-Za-z0-9_.-]/g;

/**
 * The single `Files/mirrors/<folder>` segment for a mirror name, or '' when the
 * name is empty. Deterministic: the same name always yields the same folder.
 */
function mirrorFolderSegment(name: string): string {
  const seg = String(name ?? '').replace(MIRROR_FOLDER_UNSAFE_RE, '_');
  if (seg === '.') return '_';
  if (seg === '..') return '__';
  return seg;
}

async function mirrorToLakehouse(req: NextRequest, session: SessionPayload): Promise<NextResponse> {
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

  const name = (typeof from.name === 'string' && from.name) || src.displayName || '';
  // An unnamed mirror still gets a stable folder: its item id, through the same mapping.
  const folder = mirrorFolderSegment(name) || mirrorFolderSegment(String(src.id || from.id));
  const parentPath = `mirrors/${folder}`;
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
        statusDetail: `Mirrored from ${name || folder} (${t.schema}.${t.table})`,
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
    fromItemId: from.id, fromType: from.type, fromName: name || folder,
    toItemId: lake.id, toType: 'lakehouse', toName: lake.displayName,
    action: 'mirror-to-lakehouse',
  });

  const failNote = failed.length ? ` (${failed.length} failed: ${failed.map((f) => f.table).join(', ')})` : '';
  return NextResponse.json({
    ok: true,
    path: parentPath,
    message: `Added ${created.length} shortcut(s) to lakehouse "${lake.displayName}" under Files/${parentPath}${failNote}. Open the lakehouse to work with the mirrored data.`,
    link: `/items/lakehouse/${lake.id}`,
    linkLabel: 'Open the Lakehouse',
  });
}

/**
 * 1-arg adapter: keeps the Weave bridge contract (see the header); this route
 * has no `[param]` segment. The handler is a named function CALLED from here,
 * not a `const x = withSession(...)` binding, so the route-inventory analyzer
 * (scripts/ci/_route-auth-scope.mjs), which follows call sites from the
 * exported verb, still reaches the item loads and backend calls in its body.
 * An unexpected throw becomes the toolkit's generic 500 (`apiServerError`,
 * logged server-side) rather than propagating to the caller.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return withSession((r: NextRequest, { session }) => mirrorToLakehouse(r, session))(req, {
    params: Promise.resolve({}),
  });
}
