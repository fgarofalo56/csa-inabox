/**
 * Database security roles (RBAC principal management) for the ADX/KQL database
 * bound to a kql-database item.
 *
 *   GET  /api/adx/roles?id=ITEM
 *     → { ok, database, principals: [{ role, principalType, principalDisplayName, principalFQN, notes }] }
 *     → .show database ["<db>"] principals
 *
 *   POST /api/adx/roles?id=ITEM
 *     body { action: 'add'|'drop', role, principalFQN, description? }
 *     → .add|.drop database ["<db>"] <role> ('<fqn>') ['desc']
 *     → { ok, database, role, principalFQN, action, principals }   (refreshed list)
 *
 * Real Kusto control commands to /v1/rest/mgmt. Database Admin required.
 * Honest 503 gate when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 * No Fabric / OneLake dependency — targets the stand-alone ADX cluster.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listDatabasePrincipals, addDatabasePrincipal, dropDatabasePrincipal,
  KUSTO_DATABASE_ROLES, type KustoDatabaseRole,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FQN_RE = /^(aaduser|aadgroup|aadapp)=.+/i;

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const principals = await listDatabasePrincipals(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, principals });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const action: string = typeof body?.action === 'string' ? body.action.trim() : '';
  const role: string = typeof body?.role === 'string' ? body.role.trim() : '';
  const principalFQN: string = typeof body?.principalFQN === 'string' ? body.principalFQN.trim() : '';
  const description: string | undefined =
    typeof body?.description === 'string' && body.description.trim() ? body.description.trim() : undefined;

  if (action !== 'add' && action !== 'drop') {
    return NextResponse.json({ ok: false, error: "action must be 'add' or 'drop'" }, { status: 400 });
  }
  if (!KUSTO_DATABASE_ROLES.includes(role as KustoDatabaseRole)) {
    return NextResponse.json({ ok: false, error: `role must be one of ${KUSTO_DATABASE_ROLES.join(', ')}` }, { status: 400 });
  }
  if (!FQN_RE.test(principalFQN)) {
    return NextResponse.json({ ok: false, error: 'principalFQN must start with aaduser= / aadgroup= / aadapp=' }, { status: 400 });
  }

  try {
    if (action === 'add') {
      await addDatabasePrincipal(g.ctx.database, role as KustoDatabaseRole, principalFQN, description);
    } else {
      await dropDatabasePrincipal(g.ctx.database, role as KustoDatabaseRole, principalFQN);
    }
    const principals = await listDatabasePrincipals(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, action, role, principalFQN, principals });
  } catch (e: any) {
    return adxError(e);
  }
}
