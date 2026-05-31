/**
 * GET /api/items/sql-databases
 *   Unified tenant inventory of Azure database services across the
 *   subscription. Queries three real ARM providers in parallel:
 *     - Microsoft.Sql/servers                        (Azure SQL DB logical servers)
 *     - Microsoft.Sql/managedInstances               (SQL Managed Instance)
 *     - Microsoft.DBforPostgreSQL/flexibleServers    (PostgreSQL Flexible Server)
 *
 *   Each family is fetched independently so a missing role / provider on one
 *   does not blank the others — the editor renders an honest per-family gate.
 *   Response: { ok, sql: { servers, error? }, mi: { instances, error? },
 *               postgres: { servers, error? } }
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listServers as listSqlServers, listManagedInstances } from '@/lib/azure/azure-sql-client';
import { listServers as listPgServers } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const [sqlRes, miRes, pgRes] = await Promise.allSettled([
    listSqlServers(),
    listManagedInstances(),
    listPgServers(),
  ]);

  const sql = sqlRes.status === 'fulfilled'
    ? { servers: sqlRes.value }
    : { servers: [], error: errMsg(sqlRes.reason) };
  const mi = miRes.status === 'fulfilled'
    ? { instances: miRes.value }
    : { instances: [], error: errMsg(miRes.reason) };
  const postgres = pgRes.status === 'fulfilled'
    ? { servers: pgRes.value }
    : { servers: [], error: errMsg(pgRes.reason) };

  return NextResponse.json({ ok: true, sql, mi, postgres });
}

function errMsg(reason: unknown): string {
  const e = reason as any;
  return e?.message || String(e);
}
