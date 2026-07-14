/**
 * GET /api/thread/model-tables?fromId=<semantic-model id>
 *
 * Discovery route for the Weave "Analyze with DAX" edge — lists the tables of a
 * Loom-native semantic model so the wizard's table picker is a real dropdown
 * (never a typed name, loom-no-freeform-config.md). Read straight from the
 * model item's `state.content.tables` in Cosmos (owner-scoped) — no Azure call,
 * no Power BI / Fabric.
 *
 * Returns { ok, options:[{value,label}] } or an honest { ok:false, error }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const fromId = req.nextUrl.searchParams.get('fromId')?.trim() || '';
  if (!fromId) return NextResponse.json({ ok: false, error: 'fromId is required' }, { status: 400 });

  const model = await loadOwnedItem(fromId, 'semantic-model', session.claims.oid, { allowReadRoles: true });
  if (!model) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });

  const content = ((model.state as Record<string, any>)?.content ?? {}) as { tables?: Array<{ name?: string }> };
  const tables = Array.isArray(content.tables) ? content.tables : [];
  const options = tables
    .map((t) => String(t?.name || '').trim())
    .filter((n) => n.length > 0)
    .map((n) => ({ value: n, label: n }));

  if (!options.length) {
    return NextResponse.json({
      ok: false,
      error:
        'This semantic model has no tables yet. Open the model, add at least one table (bind it to a ' +
        'warehouse / lakehouse table), then weave again.',
    });
  }
  return NextResponse.json({ ok: true, options });
}
