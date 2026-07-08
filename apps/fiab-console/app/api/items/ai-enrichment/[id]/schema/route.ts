/**
 * GET /api/items/ai-enrichment/[id]/schema
 *   ?probe=1                                   → { ok, engine, govPath, dbxAvailable, gated, hint }
 *   (no params)                                → { ok, warehouses:[{id,name,state}] }
 *   ?warehouseId=                              → { ok, catalogs }
 *   ?warehouseId=&catalog=                     → { ok, schemas }
 *   ?warehouseId=&catalog=&schema=             → { ok, tables, views }
 *   ?warehouseId=&catalog=&schema=&table=      → { ok, columns }
 *
 * The live Unity-Catalog source picker for the AI-enrichment editor. Each level
 * runs one SHOW … / DESCRIBE against the warehouse (same statements as the
 * databricks-sql-warehouse schema route). Owner-scoped via loadOwnedItem so the
 * caller must own the enrichment item (route-guard compliant); the warehouse is
 * the shared deployment-default Databricks workspace resolved by env.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  databricksConfigGate, executeStatement, getWarehouse, listWarehouses,
} from '@/lib/azure/databricks-client';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ai-enrichment';

const GATE_HINT =
  'Set LOOM_DATABRICKS_HOSTNAME (+ the workspace SQL warehouse) for the in-database enrichment path, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT for the Azure OpenAI per-row path.';

function firstColumn(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[0])).filter(Boolean);
}
function tableNames(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[1] ?? r[0])).filter(Boolean);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('not found', 404);

  const sp = req.nextUrl.searchParams;

  // ── Boundary probe: which engine + honest gate does the editor show? ──
  if (sp.get('probe') === '1') {
    const govPath = isGovCloud();
    const dbxAvailable = databricksConfigGate() === null;
    const aoaiAvailable = !!process.env.LOOM_AOAI_ENDPOINT;
    const gated = !dbxAvailable && !aoaiAvailable;
    return NextResponse.json({
      ok: !gated,
      govPath,
      dbxAvailable,
      aoaiAvailable,
      gated,
      hint: gated ? GATE_HINT : undefined,
    });
  }

  const dbxGate = databricksConfigGate();
  if (dbxGate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${dbxGate.missing}.`, missing: dbxGate.missing, hint: GATE_HINT },
      { status: 503 },
    );
  }

  const warehouseId = sp.get('warehouseId') || undefined;
  const catalog = sp.get('catalog') || undefined;
  const schema = sp.get('schema') || undefined;
  const table = sp.get('table') || undefined;

  try {
    // Level 0 — list warehouses.
    if (!warehouseId) {
      const warehouses = (await listWarehouses()).map((w) => ({ id: w.id, name: w.name, state: w.state }));
      return NextResponse.json({ ok: true, warehouses });
    }

    const w = await getWarehouse(warehouseId).catch(() => null);
    if (!w || w.state !== 'RUNNING') {
      return NextResponse.json(
        { ok: false, state: w?.state || 'UNKNOWN', message: 'Warehouse not RUNNING — start it to browse schema.' },
        { status: 409 },
      );
    }

    // Leaf — columns for a table.
    if (catalog && schema && table) {
      const descRes = await executeStatement(warehouseId, `DESCRIBE TABLE \`${catalog}\`.\`${schema}\`.\`${table}\``);
      const columns: string[] = [];
      for (const r of descRes.rows) {
        const name = String(r[0] ?? '').trim();
        if (!name || name.startsWith('#')) break;
        columns.push(name);
      }
      return NextResponse.json({ ok: true, state: 'RUNNING', columns });
    }

    const catalogsRes = await executeStatement(warehouseId, 'SHOW CATALOGS');
    const catalogs = firstColumn(catalogsRes.rows);
    let schemas: string[] | undefined;
    let tables: string[] | undefined;
    let views: string[] | undefined;

    if (catalog) {
      const schemasRes = await executeStatement(warehouseId, `SHOW SCHEMAS IN \`${catalog}\``);
      schemas = firstColumn(schemasRes.rows);
      if (schema) {
        const ns = `\`${catalog}\`.\`${schema}\``;
        const [tablesRes, viewsRes] = await Promise.all([
          executeStatement(warehouseId, `SHOW TABLES IN ${ns}`),
          executeStatement(warehouseId, `SHOW VIEWS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
        ]);
        views = tableNames(viewsRes.rows);
        const viewSet = new Set(views);
        tables = tableNames(tablesRes.rows).filter((t) => !viewSet.has(t));
      }
    }
    return NextResponse.json({ ok: true, state: 'RUNNING', catalogs, schemas, tables, views });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
