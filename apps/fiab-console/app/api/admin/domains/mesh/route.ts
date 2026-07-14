/**
 * GET /api/admin/domains/mesh — the federated data-mesh footprint (issue #1483
 * Wave 4). For every Loom domain, the rolled-up presence across the mesh:
 * catalog (workspaces + items in the domain's subtree), Purview collection,
 * Unity Catalog catalog/schema, and DLZ landing-zone binding. Read-only.
 *
 * Tenant-admin only. Every surface is honest-gated — an unconfigured back-end
 * returns `configured:false` + the exact remediation, never a fabricated count
 * (no-vaporware.md). No Fabric dependency — every surface is Azure-native.
 *
 * The tenant scope is the caller `oid`, matching GET /api/admin/domains so the
 * mesh reads the SAME authoritative `domains:<oid>` Cosmos doc the list shows.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiServerError } from '@/lib/api/respond';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { getDomainMesh } from '@/lib/azure/domain-mesh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  try {
    const mesh = await getDomainMesh(tenantId, s.claims.upn || tenantId);
    return NextResponse.json({ ok: true, mesh });
  } catch (e: any) {
    return apiServerError(e, 'Domain mesh read failed');
  }
}
