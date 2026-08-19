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
 * SCOPES (#3747 / #3753). This route hands `getDomainMesh` TWO different scopes
 * because they address two containers with two partitioning schemes:
 *
 *   • the domains document lives in `tenant-settings` under `domains:<scope>`
 *     and is per-TENANT, so it is keyed with `tenantScopeId(s)` — the same scope
 *     `GET /api/admin/domains` moved to in #3282. This route used to key it with
 *     the raw `s.claims.oid`, under a comment that CLAIMED parity with that
 *     route; the claim was false from the moment #3282 landed, and the effect
 *     was that the mesh read a private, auto-seeded copy of the domain list
 *     instead of the tenant's authoritative one.
 *   • the workspace rollup reads the `workspaces` container, which is
 *     partitioned by the CREATOR's oid (`lib/auth/session.ts` documents that
 *     `tenantScopeId()` is NOT valid for it), so it keeps `s.claims.oid`.
 *
 * NOTE: that second scope is why this panel and the Domains list still disagree
 * on workspace counts. Both enumerate `workspaces` by a single partition key, so
 * neither is a tenant-wide count. That is a SEPARATE defect from the domain-doc
 * scope fixed here and it is NOT fixed by this change — see the PR for #3753.
 */
import { NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { apiServerError } from '@/lib/api/respond';
import { getDomainMesh } from '@/lib/azure/domain-mesh';
import { withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (_req, { session: s }) => {
  try {
    const mesh = await getDomainMesh(tenantScopeId(s), s.claims.oid, s.claims.upn || s.claims.oid);
    return NextResponse.json({ ok: true, mesh });
  } catch (e: any) {
    return apiServerError(e, 'Domain mesh read failed');
  }
});
