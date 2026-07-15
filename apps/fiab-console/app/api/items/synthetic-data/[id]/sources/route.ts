/**
 * GET /api/items/synthetic-data/[id]/sources   (W12 — schema source picker)
 *
 * Lists the data-contract items in the same workspace whose schema can seed the
 * generator's columns (source schema = a data-contract). Returns each contract's
 * typed columns (name/type/classification) so the editor can infer per-column
 * strategies. Owner-scoped via loadOwnedItem / listOwnedItems (route-guards) —
 * only the caller's own workspace items are returned.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, listOwnedItems, jerr } from '../../../_lib/item-crud';
import type { DataContract } from '@/lib/dataproducts/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'synthetic-data';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('synthetic-data item not found', 404);

  try {
    const contracts = await listOwnedItems('data-contract', session.claims.oid, { workspaceId: item.workspaceId });
    const out = contracts.map((c) => {
      const contract = ((c.state || {}) as Record<string, unknown>).contract as DataContract | undefined;
      const schema = Array.isArray(contract?.schema) ? contract!.schema! : [];
      return {
        id: c.id,
        name: c.displayName,
        columns: schema.map((col) => ({ name: col.name, type: col.type, classification: col.classification })),
      };
    }).filter((c) => c.columns.length > 0);
    return NextResponse.json({ ok: true, contracts: out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
