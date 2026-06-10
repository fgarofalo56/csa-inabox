/**
 * Database / table RBAC principal management on the ADX/KQL database bound to a
 * kql-database item.
 *
 *   GET  /api/adx/principals?id=ITEM&scope=database
 *        → { ok, database, scope:'database', principals: [...] }
 *   GET  /api/adx/principals?id=ITEM&scope=table&table=T
 *        → { ok, database, scope:'table', table, principals: [...] }
 *
 *   POST /api/adx/principals?id=ITEM
 *        body { scope:'database'|'table', table?, role, principalType, principalValue, action:'add'|'drop' }
 *        → builds the FQN server-side (buildKustoPrincipalFqn) and issues
 *          .add/.drop database|table <role> ('<fqn>')  → { ok, principals: [...] }
 *
 * Every command is a real Kusto control command against /v1/rest/mgmt (the
 * Console UAMI holds AllDatabasesAdmin). Roles are allow-listed server-side
 * (database: admins|users|viewers|unrestrictedviewers|ingestors|monitors;
 * table: admins|ingestors). The UI submits structured params only — it never
 * assembles raw KQL or FQNs (loom-no-freeform-config). Honest 503 via the
 * shared guard when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  showDatabasePrincipals, showTablePrincipals,
  addDatabasePrincipal, dropDatabasePrincipal,
  addTablePrincipal, dropTablePrincipal,
  buildKustoPrincipalFqn,
  type KustoPrincipalType,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readScope(req: NextRequest): { scope: 'database' | 'table'; table: string } {
  const scope = (req.nextUrl.searchParams.get('scope') || 'database').toLowerCase() === 'table'
    ? 'table' : 'database';
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  return { scope, table };
}

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const { scope, table } = readScope(req);
  try {
    if (scope === 'table') {
      if (!validName(table)) {
        return NextResponse.json({ ok: false, error: 'table is required for scope=table' }, { status: 400 });
      }
      const principals = await showTablePrincipals(g.ctx.database, table);
      return NextResponse.json({ ok: true, database: g.ctx.database, scope, table, principals });
    }
    const principals = await showDatabasePrincipals(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, scope, principals });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const scope: 'database' | 'table' = body?.scope === 'table' ? 'table' : 'database';
  const table = typeof body?.table === 'string' ? body.table.trim() : '';
  const role = typeof body?.role === 'string' ? body.role.trim() : '';
  const principalType = body?.principalType as KustoPrincipalType;
  const principalValue = typeof body?.principalValue === 'string' ? body.principalValue.trim() : '';
  const action: 'add' | 'drop' = body?.action === 'drop' ? 'drop' : 'add';

  if (!['User', 'App', 'Group'].includes(principalType)) {
    return NextResponse.json({ ok: false, error: "principalType must be 'User' | 'App' | 'Group'" }, { status: 400 });
  }
  if (!principalValue) {
    return NextResponse.json({ ok: false, error: 'principalValue is required (email, group email/object id, or "appId;tenantId")' }, { status: 400 });
  }
  if (scope === 'table' && !validName(table)) {
    return NextResponse.json({ ok: false, error: 'table is required for scope=table' }, { status: 400 });
  }
  try {
    const fqn = buildKustoPrincipalFqn(principalType, principalValue);
    if (scope === 'table') {
      action === 'add'
        ? await addTablePrincipal(g.ctx.database, table, role, fqn)
        : await dropTablePrincipal(g.ctx.database, table, role, fqn);
      const principals = await showTablePrincipals(g.ctx.database, table);
      return NextResponse.json({ ok: true, database: g.ctx.database, scope, table, principals });
    }
    action === 'add'
      ? await addDatabasePrincipal(g.ctx.database, role, fqn)
      : await dropDatabasePrincipal(g.ctx.database, role, fqn);
    const principals = await showDatabasePrincipals(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, scope, principals });
  } catch (e: any) {
    return adxError(e);
  }
}
