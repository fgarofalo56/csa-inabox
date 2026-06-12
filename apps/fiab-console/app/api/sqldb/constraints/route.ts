/**
 * GET    /api/sqldb/constraints?workspaceId&id&objectId      — list a table's PK/UQ/FK/CHECK constraints
 * POST   /api/sqldb/constraints  body: { tableObjectId, spec } — ALTER TABLE … ADD CONSTRAINT (catalog-verified)
 * DELETE /api/sqldb/constraints?objectId=&constraintId=       — ALTER TABLE … DROP CONSTRAINT
 * PATCH  /api/sqldb/constraints?objectId=&constraintId=  body:{ enable } — enable/disable a FK/CHECK
 *
 * The connection is item-scoped (Fabric SqlDatabase id) or Azure-SQL override,
 * resolved by {@link guardSqlDbRequest}. Every authored statement is built from
 * catalog-verified, bracket-quoted identifiers (table + columns resolved by
 * integer object_id / column_id). The CHECK expression is the only free-text
 * field and is placed only inside `CHECK(…)`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import {
  listConstraints, addConstraint, dropConstraint, toggleConstraint,
  detectSqlBackendKind,
  type ConstraintSpec,
} from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  try {
    const constraints = await listConstraints(g.ctx.server, g.ctx.database, objectId);
    // Surface the backend dialect so the inline designer can honestly disable
    // the controls a Fabric Warehouse / Synapse dedicated pool does not accept
    // (CHECK, CLUSTERED, WITH NOCHECK; FK on dedicated pools).
    const backendKind = detectSqlBackendKind(g.ctx.server);
    return NextResponse.json({ ok: true, objectId, constraints, backendKind });
  } catch (e: any) { return sqlDbError(e); }
}

export async function POST(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const tableObjectId = Number(body?.tableObjectId);
  const spec = body?.spec as ConstraintSpec | undefined;
  if (!Number.isInteger(tableObjectId)) return NextResponse.json({ ok: false, error: 'tableObjectId is required' }, { status: 400 });
  if (!spec || typeof spec !== 'object' || !['PK', 'UQ', 'FK', 'CK'].includes((spec as any).type)) {
    return NextResponse.json({ ok: false, error: 'a valid constraint spec (type PK|UQ|FK|CK) is required' }, { status: 400 });
  }
  // Pick the DDL dialect from the bound connection: full-engine Azure SQL /
  // Fabric SQL database vs metadata-only Fabric Warehouse / Synapse pool.
  const backendKind = detectSqlBackendKind(g.ctx.server);
  const r = await addConstraint(g.ctx.server, g.ctx.database, tableObjectId, spec, backendKind);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, added: r.added, ddl: r.ddl });
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  const constraintId = Number(req.nextUrl.searchParams.get('constraintId'));
  if (!Number.isInteger(objectId) || !Number.isInteger(constraintId)) {
    return NextResponse.json({ ok: false, error: 'objectId and constraintId are required' }, { status: 400 });
  }
  const r = await dropConstraint(g.ctx.server, g.ctx.database, objectId, constraintId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}

export async function PATCH(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  const constraintId = Number(req.nextUrl.searchParams.get('constraintId'));
  if (!Number.isInteger(objectId) || !Number.isInteger(constraintId)) {
    return NextResponse.json({ ok: false, error: 'objectId and constraintId are required' }, { status: 400 });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  if (typeof body?.enable !== 'boolean') return NextResponse.json({ ok: false, error: 'enable (boolean) is required' }, { status: 400 });
  const r = await toggleConstraint(g.ctx.server, g.ctx.database, objectId, constraintId, body.enable);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, state: r.state, constraint: r.constraint });
}
