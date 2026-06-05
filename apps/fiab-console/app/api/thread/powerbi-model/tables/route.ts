/**
 * GET /api/thread/powerbi-model/tables?fromType=&fromId=
 *
 * Discovery route for the Loom Thread "Build a Power BI model" edge wizard.
 * Lists the tables of the source warehouse (Azure-native default = Synapse
 * dedicated SQL pool, per no-fabric-dependency) so the wizard's table picker is
 * a real dropdown — never a typed name (loom-no-freeform-config).
 *
 * Each option's value encodes `objectId|schema|name` so the build route can
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
      { ok: false, error: `Building a Power BI model from "${fromType}" is not wired yet — supported sources: warehouse.` },
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
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
