/**
 * GET /api/items/databricks-sql-warehouse/[id]/script-out
 *   ?warehouseId=<w>&catalog=<c>&schema=<s>&name=<n>
 *   &type=view|function|table&mode=create|drop
 *
 * Returns a runnable Databricks SQL script for the object:
 *   - create → real DDL via SHOW CREATE TABLE (views/tables) or
 *              SHOW CREATE FUNCTION (Unity Catalog UDFs)
 *   - drop   → DROP VIEW|FUNCTION|TABLE IF EXISTS `c`.`s`.`n`;
 *
 * Identifiers come from the Explorer's SHOW enumeration; each is
 * backtick-escaped before it is interpolated. Returns 409 when the warehouse
 * is not RUNNING (no compute to read DDL from).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DbxObjectType = 'view' | 'function' | 'table';

function backtick(id: string): string {
  return `\`${id.replace(/`/g, '``')}\``;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const warehouseId = sp.get('warehouseId');
  const catalog = sp.get('catalog');
  const schema = sp.get('schema');
  const name = sp.get('name');
  const typeRaw = sp.get('type');
  const mode = sp.get('mode');

  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  if (!catalog || !schema || !name) {
    return NextResponse.json({ ok: false, error: 'catalog, schema and name are required' }, { status: 400 });
  }
  const type: DbxObjectType = typeRaw === 'function' ? 'function' : typeRaw === 'table' ? 'table' : 'view';
  if (mode !== 'create' && mode !== 'drop') {
    return NextResponse.json({ ok: false, error: 'mode must be create|drop' }, { status: 400 });
  }

  const fqn = `${backtick(catalog)}.${backtick(schema)}.${backtick(name)}`;

  if (mode === 'drop') {
    const keyword = type === 'function' ? 'FUNCTION' : type === 'table' ? 'TABLE' : 'VIEW';
    return NextResponse.json({ ok: true, script: `DROP ${keyword} IF EXISTS ${fqn};` });
  }

  // create — needs a running warehouse to execute SHOW CREATE …
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, state: w?.state || 'UNKNOWN', error: 'Warehouse not RUNNING — start it to script CREATE.' },
      { status: 409 },
    );
  }

  try {
    const stmt = type === 'function'
      ? `SHOW CREATE FUNCTION ${fqn}`
      : `SHOW CREATE TABLE ${fqn}`;
    const res = await executeStatement(warehouseId, stmt, catalog, schema);
    const script = String(res.rows?.[0]?.[0] ?? '').trim();
    if (!script) {
      return NextResponse.json({ ok: false, error: `No definition returned for ${fqn}.` }, { status: 404 });
    }
    // SHOW CREATE TABLE/FUNCTION omits the trailing semicolon — add it so the
    // script is directly runnable in the editor.
    return NextResponse.json({ ok: true, script: script.endsWith(';') ? script : `${script};` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
