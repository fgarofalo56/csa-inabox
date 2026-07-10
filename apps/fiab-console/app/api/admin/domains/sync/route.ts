/**
 * Domain governance sync — reconcile the full Loom domain hierarchy to Microsoft
 * Purview (Data Map collections) + Databricks Unity Catalog (catalogs/schemas).
 *
 *   GET  /api/admin/domains/sync   → the LAST persisted reconcile result (or a
 *        fresh dry run when none has ever run) so the Domains page can show
 *        per-target status + drift on load without mutating anything.
 *   POST /api/admin/domains/sync   → run the reconciler. Body `{ apply?: bool }`:
 *        apply:false (default) is a dry run; apply:true upserts every domain into
 *        each configured target (idempotent, roots before subdomains, NEVER
 *        deletes remote). The result is persisted to Cosmos as last-status.
 *
 * Tenant-admin only. Both targets are optional + Azure-native — an unconfigured
 * target returns an honest hint, never an error, and the sweep still reconciles
 * whichever target IS configured. No Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiServerError } from '@/lib/api/respond';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { runDomainSync, saveDomainSyncStatus, loadDomainSyncStatus } from '@/lib/azure/domain-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tenant scope id — the tid claim (multi-tenant) or the caller oid fallback. */
function tenantScope(claims: { tid?: string; oid: string }): string {
  return claims.tid || claims.oid;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tenantId = tenantScope(s.claims);
  try {
    const last = await loadDomainSyncStatus(tenantId);
    if (last) return NextResponse.json({ ok: true, result: last, fromCache: true });
    // Never run before — return a non-mutating dry run so the UI has real status.
    const result = await runDomainSync(tenantId, s.claims.upn || s.claims.oid, { apply: false });
    return NextResponse.json({ ok: true, result, fromCache: false });
  } catch (e: any) {
    return apiServerError(e, 'Domain sync failed');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const tenantId = tenantScope(s.claims);
  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;

  try {
    const result = await runDomainSync(tenantId, s.claims.upn || s.claims.oid, { apply });
    // Persist both dry-run and apply results so the page reflects the latest state.
    await saveDomainSyncStatus(tenantId, result);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return apiServerError(e, 'Domain sync failed');
  }
}
