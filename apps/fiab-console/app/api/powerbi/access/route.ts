/**
 * /api/powerbi/access — Manage access on the REAL Power BI workspace ACL.
 *
 * This is the canonical "Manage access" surface (Admin / Member / Contributor /
 * Viewer) on a Power BI workspace via the Groups - *GroupUser* REST family —
 * distinct from the Loom-native Cosmos roles at /api/workspaces/[id]/permissions.
 *
 *   GET    /api/powerbi/access?workspaceId=W
 *            → { ok, users: [{ identifier, displayName, groupUserAccessRight, principalType }] }
 *   POST   /api/powerbi/access  { workspaceId, identifier, role, principalType }  (add)
 *   PUT    /api/powerbi/access  { workspaceId, identifier, role, principalType }  (update role)
 *   DELETE /api/powerbi/access?workspaceId=W&identifier=user@x  (remove)
 *
 * Every call hits the real Power BI REST via powerbi-client.ts (no mocks). The
 * honest config-gate (LOOM_UAMI_CLIENT_ID) returns 503; tenant 401/403 (SP not
 * authorized / not a workspace Admin) is surfaced verbatim with the SP hint.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/groups/add-group-user
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  PowerBiError,
  powerbiConfigGate,
  POWERBI_SP_HINT,
  listGroupUsers,
  addGroupUser,
  updateGroupUser,
  deleteGroupUser,
  type GroupUserAccessRight,
  type PbiPrincipalType,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES: GroupUserAccessRight[] = ['Admin', 'Member', 'Contributor', 'Viewer'];
const PRINCIPALS: PbiPrincipalType[] = ['User', 'Group', 'App'];

function gate(): NextResponse | null {
  const g = powerbiConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: g.detail, missing: g.missing }, { status: 503 });
  return null;
}
function fail(e: unknown): NextResponse {
  const status = e instanceof PowerBiError ? e.status : 502;
  const message = e instanceof Error ? e.message : String(e);
  const hint = status === 401 || status === 403 ? POWERBI_SP_HINT : undefined;
  return NextResponse.json({ ok: false, error: message, hint }, { status: status >= 400 ? status : 502 });
}
function requireAuth(): NextResponse | null {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return null;
}

export async function GET(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId query param is required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, users: await listGroupUsers(workspaceId) });
  } catch (e) { return fail(e); }
}

async function upsert(req: NextRequest, mode: 'add' | 'update') {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({} as any));
  const workspaceId: string = (body?.workspaceId || '').trim();
  const identifier: string = (body?.identifier || '').trim();
  const role: string = (body?.role || '').trim();
  const principalType: string = (body?.principalType || 'User').trim();
  if (!workspaceId || !identifier) {
    return NextResponse.json({ ok: false, error: 'workspaceId and identifier are required' }, { status: 400 });
  }
  if (!ROLES.includes(role as GroupUserAccessRight)) {
    return NextResponse.json({ ok: false, error: `role must be one of ${ROLES.join(', ')}` }, { status: 400 });
  }
  if (!PRINCIPALS.includes(principalType as PbiPrincipalType)) {
    return NextResponse.json({ ok: false, error: `principalType must be one of ${PRINCIPALS.join(', ')}` }, { status: 400 });
  }
  try {
    const args = { identifier, groupUserAccessRight: role as GroupUserAccessRight, principalType: principalType as PbiPrincipalType };
    if (mode === 'add') await addGroupUser(workspaceId, args);
    else await updateGroupUser(workspaceId, args);
    return NextResponse.json({ ok: true, users: await listGroupUsers(workspaceId) });
  } catch (e) { return fail(e); }
}

export async function POST(req: NextRequest) { return upsert(req, 'add'); }
export async function PUT(req: NextRequest) { return upsert(req, 'update'); }

export async function DELETE(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  const identifier = req.nextUrl.searchParams.get('identifier')?.trim();
  if (!workspaceId || !identifier) {
    return NextResponse.json({ ok: false, error: 'workspaceId and identifier query params are required' }, { status: 400 });
  }
  try {
    await deleteGroupUser(workspaceId, identifier);
    return NextResponse.json({ ok: true, users: await listGroupUsers(workspaceId) });
  } catch (e) { return fail(e); }
}
