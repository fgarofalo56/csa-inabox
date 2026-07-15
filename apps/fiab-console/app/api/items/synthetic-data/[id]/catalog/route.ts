/**
 * GET /api/items/synthetic-data/[id]/catalog   (W12 — write-target picker)
 *
 * Cascading Databricks Unity Catalog browse for the generate target (all typed
 * dropdowns — no free-typed identifiers, per loom_no_freeform_config):
 *   (no level)                         → { warehouses }
 *   ?level=catalogs                    → { catalogs }
 *   ?level=schemas&catalog=            → { schemas }
 *   ?level=volumes&catalog=&schema=    → { volumes }  (staging volumes)
 *
 * Honest gate: Databricks unset → { gate:{ missing } }. Owner-scoped via
 * loadOwnedItem (route-guards): the [id] is authorized to the caller.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listWarehouses, listUcCatalogs, listUcSchemas, listUcVolumes,
} from '@/lib/azure/databricks-client';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'synthetic-data';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('synthetic-data item not found', 404);

  const gate = databricksConfigGate();
  if (gate) return NextResponse.json({ ok: true, gate: { missing: gate.missing } });

  const sp = req.nextUrl.searchParams;
  const level = sp.get('level');
  try {
    if (level === 'catalogs') {
      const catalogs = await listUcCatalogs();
      return NextResponse.json({ ok: true, catalogs: catalogs.map((c) => c.name) });
    }
    if (level === 'schemas') {
      const catalog = String(sp.get('catalog') || '').trim();
      if (!catalog) return NextResponse.json({ ok: false, error: 'catalog is required' }, { status: 400 });
      const schemas = await listUcSchemas(catalog);
      return NextResponse.json({ ok: true, schemas: schemas.map((s) => s.name) });
    }
    if (level === 'volumes') {
      const catalog = String(sp.get('catalog') || '').trim();
      const schema = String(sp.get('schema') || '').trim();
      if (!catalog || !schema) return NextResponse.json({ ok: false, error: 'catalog and schema are required' }, { status: 400 });
      const volumes = await listUcVolumes(catalog, schema);
      return NextResponse.json({ ok: true, volumes: volumes.map((v) => `${catalog}.${schema}.${v.name}`) });
    }
    // default: warehouses
    const warehouses = await listWarehouses();
    return NextResponse.json({ ok: true, warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, state: w.state })) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
