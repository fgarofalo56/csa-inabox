/**
 * GET /api/admin/workspaces — TENANT-WIDE workspace inventory with live item
 * counts, last activity, capacity assignment, state, and resolved owners.
 * Cosmos-backed (cross-partition scan; see lib/clients/workspaces-client.ts).
 *
 * Admin-only: every workspace in the tenant is visible regardless of owner, so
 * the route is gated by isTenantAdmin (LOOM_TENANT_ADMIN_OID / _GROUP_ID). A
 * non-admin caller gets a structured 403 rather than another user's workspaces.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listAllWorkspacesAdmin } from '@/lib/clients/workspaces-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason:
          'Tenant-wide workspace inventory is admin-only. Become a tenant admin by ' +
          'setting LOOM_TENANT_ADMIN_OID to your user OID (or LOOM_TENANT_ADMIN_GROUP_ID ' +
          'to an Entra group you belong to) on the loom-console container app.',
      },
      { status: 403 },
    );
  }
  try {
    const workspaces = await listAllWorkspacesAdmin();
    return NextResponse.json({ ok: true, total: workspaces.length, workspaces });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
