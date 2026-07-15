/**
 * POST /api/items/synthetic-data/[id]/preview   (W12)
 *   body { specs: ColumnGenSpec[], rowCount?: number, seed?: number }
 *
 * Generate a SAMPLE of synthetic rows from the per-column strategies and return
 * them — pure, deterministic, no backend write, so preview always works (it
 * shows exactly what the full run will produce for the same seed). Owner-scoped
 * via loadOwnedItem (route-guards): the [id] is authorized to the caller.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';
import { generateRows, type ColumnGenSpec } from '@/lib/azure/synthetic-data-gen';
import { sanitizeSpecs } from '../../_lib/specs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'synthetic-data';
const MAX_PREVIEW = 50;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;
  const item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('synthetic-data item not found', 404);

  const body = await req.json().catch(() => ({}));
  const specs: ColumnGenSpec[] = sanitizeSpecs(body?.specs);
  if (specs.length === 0) return NextResponse.json({ ok: false, error: 'At least one valid column spec is required.' }, { status: 400 });

  const rowCount = Math.max(1, Math.min(MAX_PREVIEW, Number(body?.rowCount) || 10));
  const seed = Number.isFinite(body?.seed) ? Math.floor(body.seed) : 1;
  const rows = generateRows(specs, rowCount, seed);
  return NextResponse.json({ ok: true, rows, columns: specs.map((s) => s.name), rowCount: rows.length, seed });
}
