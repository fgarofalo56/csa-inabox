/**
 * GET /api/thread/warehouse-tables?fromType=&fromId=
 *
 * Shared discovery route for Loom Thread edges that act on a warehouse table
 * (e.g. "Build a Power BI model", "Publish as an API"). Lists the tables of the
 * Azure-native warehouse backend (Synapse dedicated SQL pool, per
 * no-fabric-dependency) so the wizard's table picker is a real dropdown — never
 * a typed name (loom-no-freeform-config).
 *
 * Each option's value encodes `objectId|schema|name` so the executor route can
 * read the column schema by object_id and build a bracketed FROM clause from
 * catalog-verified identifiers (no string injection).
 *
 * Returns { ok, options:[{value,label}] } or an honest { ok:false, gate, error }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { listTables } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Source slugs whose Azure-native warehouse backend is the Synapse dedicated pool. */
const WAREHOUSE_TYPES = new Set(['warehouse', 'synapse-dedicated-sql-pool']);

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const fromType = req.nextUrl.searchParams.get('fromType') || '';
  if (!WAREHOUSE_TYPES.has(fromType)) {
    return NextResponse.json(
      { ok: false, error: `This edge isn't wired for "${fromType}" yet — supported sources: warehouse.` },
      { status: 400 },
    );
  }

  let target;
  try {
    target = dedicatedTarget();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: 'LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL' },
        error:
          'The Azure-native warehouse (Synapse dedicated SQL pool) is not configured. Set ' +
          'LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to list its tables.',
      },
      { status: 503 },
    );
  }

  try {
    const tables = await listTables(target.server, target.database);
    const options = tables.map((t) => ({
      value: `${t.objectId}|${t.schema}|${t.name}`,
      label: t.rowCount != null ? `${t.fullName} · ${t.rowCount.toLocaleString()} rows` : t.fullName,
    }));
    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    // The dedicated pool may be paused or have no catalog tables visible to the
    // Console identity. Surface that honestly AND point at the escape hatch:
    // both edges that use this route also accept a custom SQL query as source.
    return NextResponse.json(
      {
        ok: false,
        error:
          `${e?.message || String(e)} — the Azure-native warehouse (Synapse dedicated SQL pool) may be paused or have ` +
          `no tables visible to the Console identity. Tip: switch the source to "A custom SQL query" to build directly from a SELECT.`,
      },
      { status: 500 },
    );
  }
}
