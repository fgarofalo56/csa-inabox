/**
 * GET /api/items/warehouse/[id]/schema
 *
 * Mirrors the Dedicated SQL pool schema endpoint — Warehouse is backed by
 * the same compute. Returns 409 with state info when Paused.
 *
 * ?table=<schema.table> → { ok, columns } (INFORMATION_SCHEMA.COLUMNS) for
 * editor IntelliSense. Otherwise returns { schemas, databases }.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. `GET(req)` took no `ctx` and ran
 * `getSession()` alone, then enumerated every schema, table and row count in
 * the shared dedicated pool, every view/procedure/function in it, and every
 * database on the Synapse SQL server.
 *
 * Layer 1 now authorizes the caller against the warehouse item
 * (`allowReadRoles: true` — this handler issues no write).
 *
 * Layer 2 is applied to the `databases` list ONLY, and that is deliberate: the
 * picker it feeds drives `[id]/query`'s `body.database`, and #3614's own round-2
 * finding was that narrowing a CONSUMER while leaving its PICKER wide produces a
 * control that 403s on its own documented use. Picker and consumer now admit the
 * same set by construction — both call `workspaceSynapseScope`.
 *
 * HOW MUCH THAT NARROWS, stated at full strength because an earlier revision of
 * the ledger understated it as "out-of-band databases disappear". For the COMMON
 * item — `state: {}`, no provisioning record — `workspaceSynapseScope` is a
 * SINGLE entry: the env-pinned shared pool. Nothing in the platform writes a
 * second Synapse database onto an item today, so in practice **this dropdown
 * collapses to one option in every workspace**, which removes the cross-database
 * picker's documented purpose rather than merely trimming it.
 *
 * It does NOT become an error state — `workspaceSynapseScope` always contains at
 * least the item's own database, so the list is never empty and the editor's
 * `disabled={… || databases.length === 0}` never trips. That is read from
 * `lib/editors/synapse-sql-editors.tsx`, NOT observed in a browser: per
 * `ux-baseline.md` G1 a one-option dropdown still needs a live pass, and this PR
 * does not have one. Recorded as unverified.
 *
 * The schema/table enumeration inside the one shared pool database is NOT
 * narrowed, because nothing in the estate records which schema belongs to which
 * item. See `_lib/synapse-item-scope.ts` and the PR ledger — stated, not implied
 * fixed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { enumerateSqlObjects } from '@/lib/azure/sql-object-scripting';
import { escapeSqlLiteral } from '@/lib/sql/quoting';
import { guardSynapseItemRequest, workspaceSynapseScope } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_NOT_FOUND = 'warehouse not found';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  // Distinguish a genuine non-Online pool (Paused/Resuming → 409, honest gate)
  // from a probe failure (ARM unreachable / scope wrong → 502, surfaced as an
  // error, NOT a false "paused" banner that discourages running queries).
  let state: Awaited<ReturnType<typeof getPoolState>> | null = null;
  let probeError: string | null = null;
  try {
    state = await getPoolState();
  } catch (e: any) {
    probeError = e?.message || String(e);
  }

  if (probeError) {
    return NextResponse.json(
      {
        ok: false,
        state: 'Unknown',
        sku: 'unknown',
        warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
        error: `Could not read the Synapse Dedicated SQL pool state from ARM: ${probeError}`,
        message: 'Warehouse compute status is unavailable — the pool-state probe failed. Verify the Console identity has Reader on the Synapse workspace and that LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL are correct.',
      },
      { status: 502 },
    );
  }

  if (!state || state.state !== 'Online') {
    return NextResponse.json(
      {
        ok: false,
        state: state?.state || 'Unknown',
        sku: state?.sku || 'unknown',
        warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
        message: 'Warehouse compute not Online — resume on the Dedicated SQL pool editor.',
      },
      { status: 409 },
    );
  }

  const tableParam = req.nextUrl.searchParams.get('table') || '';

  try {
    if (tableParam) {
      const [schemaName, tableName] = tableParam.includes('.')
        ? tableParam.split('.', 2)
        : ['dbo', tableParam];
      const cols = await executeQuery(
        dedicatedTarget(),
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${escapeSqlLiteral(schemaName)}'
           AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
         ORDER BY ORDINAL_POSITION`,
      );
      return NextResponse.json({ ok: true, state: 'Online', columns: cols.rows.map((r) => String(r[0])) });
    }

    const tablesP = executeQuery(
      dedicatedTarget(),
      `SELECT TOP 200 s.name + '.' + t.name AS qualified, t.name AS table_name, s.name AS schema_name,
              CAST(p.rows AS bigint) AS row_count
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
       ORDER BY s.name, t.name`,
    );
    const objectsP = enumerateSqlObjects(dedicatedTarget());
    const [tables, objects] = await Promise.all([tablesP, objectsP]);

    const schemas: Record<string, { table: string; rows: number }[]> = {};
    for (const row of tables.rows) {
      const [, tableName, schemaName, rowCount] = row as [string, string, string, number];
      (schemas[schemaName] ||= []).push({ table: tableName, rows: Number(rowCount || 0) });
    }

    let databases: string[] = [];
    try {
      const scope = await workspaceSynapseScope(item);
      const dbs = await executeQuery(dedicatedTarget(), `SELECT name FROM sys.databases WHERE state = 0 ORDER BY name`);
      // LAYER 2 — the picker offers exactly what `[id]/query` will admit.
      databases = dbs.rows.map((r) => String(r[0])).filter((n) => scope.has(n));
    } catch { databases = []; }

    return NextResponse.json({
      ok: true,
      state: 'Online',
      sku: state.sku,
      warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      schemas,
      databases,
      views: objects.views,
      procedures: objects.procedures,
      functions: objects.functions,
      ...(objects.warnings.length ? { warnings: objects.warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, state: 'Online', error: e?.message || String(e) }, { status: 502 });
  }
}
