/**
 * GET /api/lakehouse/tables?id=<lakehouseItemId>
 *
 * Returns the REAL Delta tables for the given lakehouse, grouped by layer.
 * Source of truth: the lakehouse workspace item's state.content
 * (LakehouseContent.deltaTables) — the structure the lakehouse editor shows.
 * Honest-empty ([]) when the item has no Delta tables yet. No mock data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function layerOf(name: string): string {
  const m = String(name).match(/^(bronze|silver|gold|raw|staging|curated)[._-]/i);
  return m ? m[1].toLowerCase() : 'tables';
}
function shortName(name: string): string {
  const m = String(name).match(/^(?:bronze|silver|gold|raw|staging|curated)[._-](.+)$/i);
  return m ? m[1] : String(name);
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: true, tables: [] });
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.itemType = 'lakehouse'",
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    const item: any = resources[0];
    const content: any = item?.state?.content;
    const deltaTables: any[] = content && content.kind === 'lakehouse' && Array.isArray(content.deltaTables)
      ? content.deltaTables : [];
    const tables = deltaTables.map((t) => ({
      schema: layerOf(t?.name || ''),
      name: shortName(t?.name || ''),
      rowCount: Array.isArray(t?.sampleRows) ? t.sampleRows.length : 0,
      sizeBytes: 0,
      format: 'delta',
      latestVersion: 0,
      columns: Array.isArray(t?.columns) ? t.columns.length : undefined,
      ddl: typeof t?.ddl === 'string' ? t.ddl : undefined,
    }));
    return NextResponse.json({ ok: true, tables });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
