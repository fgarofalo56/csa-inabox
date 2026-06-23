/**
 * POST /api/data-products/[id]/preview
 *
 * "Try it" data preview for a data-product item. Resolves the product's ADX
 * coordinates (database + table) and runs a bracketed `take 25` KQL query,
 * returning columns + rows so the consumer view can show real sample data.
 *
 * Item load: cross-partition Cosmos query (NOT ownership-gated) — data
 * products are discoverable by any authenticated catalog reader, matching
 * the GET /api/data-products/[id] pattern.
 *
 * ADX coordinate resolution (mirrors observability route):
 *   database  = state.databaseName  || defaultDatabase()
 *   tableName = state.databaseTable || datasets[0].name
 *
 * KQL issued (read-only):
 *   ["<tableName>"] | take 25
 *
 * Honest gates (no fake data, no Fabric dependency):
 *   - No session               → 401
 *   - Item not found           → 404
 *   - No backing table         → 400  { ok:false, error }
 *   - LOOM_KUSTO_CLUSTER_URI unset → 501  { ok:false, gate, error }
 *   - ADX executeQuery throws  → 502  { ok:false, error }
 *
 * Success: { ok:true, database, table, kql, columns, columnTypes, rows (<=25) }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { executeQuery, defaultDatabase } from '@/lib/azure/kusto-client';
import { adxConfigGate } from '@/lib/azure/data-quality-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const PREVIEW_ROWS = 25;

interface Dataset { name?: string; guid?: string; qualifiedName?: string }

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;

  // Load the item cross-partition (NOT ownership-gated) — data products are
  // discoverable by any authenticated catalog reader, matching the GET
  // /api/data-products/[id] pattern (see findItem in that route).
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: id },
        { name: '@t', value: ITEM_TYPE },
      ],
    })
    .fetchAll();
  const item = resources[0] ?? null;
  if (!item) return NextResponse.json({ ok: false, error: 'data-product item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];

  const tableName = (state.databaseTable as string) || datasets[0]?.name || '';
  const database = (state.databaseName as string) || defaultDatabase();

  if (!tableName) {
    return NextResponse.json(
      { ok: false, error: 'This data product has no backing table to preview yet.' },
      { status: 400 },
    );
  }

  // ADX honest gate — if LOOM_KUSTO_CLUSTER_URI is unset the UI shows a
  // precise MessageBar naming the env var rather than querying a phantom cluster.
  const gate = adxConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        gate,
        error: `ADX is not configured on this deployment. Set the ${gate.missing} environment variable to enable data preview.`,
      },
      { status: 501 },
    );
  }

  // Build a safe, read-only KQL: bracket-quote the table name to handle
  // hyphens and special characters; `take` is a read-only operator with no
  // side effects. We do NOT interpolate any user-supplied input — only the
  // server-resolved tableName from Cosmos state is used.
  const kql = `["${tableName.replace(/"/g, '\\"')}"] | take ${PREVIEW_ROWS}`;

  try {
    const result = await executeQuery(database, kql);
    // Cap rows defensively — kusto-client already caps at MAX_ROWS (5000) but
    // we want the preview to stay at 25 regardless of that constant.
    const rows = result.rows.slice(0, PREVIEW_ROWS);
    return NextResponse.json({
      ok: true,
      database,
      table: tableName,
      kql,
      columns: result.columns,
      columnTypes: result.columnTypes,
      rows,
      executionMs: result.executionMs,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
