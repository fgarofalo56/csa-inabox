/**
 * Item-level Share — per-Azure-SQL-database ARM role assignments.
 *
 * GET    /api/items/azure-sql-database/[id]/share?server=<name>&database=<name>
 *        — list the role assignments declared at the database scope.
 * POST   /api/items/azure-sql-database/[id]/share
 *        body: { server, database, principalId, principalType?, roleNameOrGuid }
 *        — PUT a new role assignment at the database scope; returns the new
 *          assignment incl. its ARM id (the receipt).
 * DELETE /api/items/azure-sql-database/[id]/share?assignmentId=<full ARM id>
 *        — revoke one role assignment by its full ARM id.
 *
 * Real backend: ARM REST (Microsoft.Authorization/roleAssignments) at the
 * Microsoft.Sql/servers/databases/{db} scope, mirroring the Azure portal
 * "Access control (IAM)" blade. The Console UAMI must hold "Role Based Access
 * Control Administrator" (constrained via ABAC to Reader / Contributor /
 * SQL DB Contributor) on the SQL server's resource group — granted by
 * platform/fiab/bicep/modules/admin-plane/sql-database-share-rbac.bicep.
 *
 * 403 semantics: when the caller (Console UAMI) lacks the RBAC-Admin grant ARM
 * returns 403; armRequest throws AzureSqlError(msg, 403) and handleErr surfaces
 * the verbatim ARM message with HTTP 403. No fake success (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDatabaseRoleAssignments,
  grantDatabaseRole,
  revokeDatabaseRoleAssignment,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), body: (e as any)?.body, status },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const server = req.nextUrl.searchParams.get('server');
  const database = req.nextUrl.searchParams.get('database');
  if (!server || !database) {
    return NextResponse.json({ ok: false, error: 'server and database query params required' }, { status: 400 });
  }
  try {
    const assignments = await listDatabaseRoleAssignments(server, database);
    return NextResponse.json({ ok: true, assignments });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { server, database, principalId, principalType, roleNameOrGuid } = body || {};
  if (!server || !database || !principalId || !roleNameOrGuid) {
    return NextResponse.json(
      { ok: false, error: 'server, database, principalId, roleNameOrGuid required' },
      { status: 400 },
    );
  }
  try {
    const assignment = await grantDatabaseRole(
      server,
      database,
      principalId,
      roleNameOrGuid,
      principalType === 'Group' || principalType === 'ServicePrincipal' ? principalType : 'User',
    );
    return NextResponse.json({ ok: true, assignment });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const assignmentId = req.nextUrl.searchParams.get('assignmentId');
  if (!assignmentId) {
    return NextResponse.json({ ok: false, error: 'assignmentId query param required' }, { status: 400 });
  }
  try {
    await revokeDatabaseRoleAssignment(assignmentId);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
