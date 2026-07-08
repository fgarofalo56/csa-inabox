/**
 * POST /api/admin/lineage/reconcile   — admin-only lineage orphan reconciliation.
 *
 * Diffs Loom-provisioned Microsoft Purview entities (qualifiedName scheme
 * `loom://<tenantId>/<workspaceId>/<itemType>/<itemId>`, registered at
 * provision/scan time by purview-autoonboard.ts) against live Cosmos items,
 * and reports — or, when {dryRun:false}, purges — the orphans: Atlas entities
 * whose backing Loom item was deleted (per-item / workspace cascade / bulk
 * delete). This is the one-time cleanup of the 2026-07-08 UAT purge debris that
 * still renders on Analyze → Lineage, plus an on-demand sweep going forward.
 *
 * Contract:
 *   Request : { dryRun?: boolean }   (default TRUE — never purge unless asked)
 *   Response (dry-run) : { ok, dryRun:true, purviewConfigured, scanned, orphans:[…] }
 *   Response (purge)   : { ok, dryRun:false, purviewConfigured, scanned,
 *                          orphans:[…], purged:[…] }
 *   401 : no session.  403 : caller is not a tenant admin.
 *
 * Admin gate: requireTenantAdmin() (LOOM_TENANT_ADMIN_GROUP_ID membership OR
 * LOOM_TENANT_ADMIN_OID) — the same gate every admin surface uses; satisfies the
 * route-guards guardrail. Honest gate: when Purview is unconfigured the sweep
 * returns purviewConfigured:false with zero orphans (nothing to reconcile).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { findLineageOrphans, purgeLineageOrphans } from '@/lib/azure/lineage-gc';
import { isPurviewConfigured } from '@/lib/azure/purview-client';
import { apiOk, apiUnauthorized, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — lightweight probe for the UI: is the caller a tenant admin, and is
 * Purview configured (so the "Reconcile lineage" action is meaningful). No
 * network beyond the session; safe for non-admins (returns isAdmin:false).
 */
export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  return apiOk({ isAdmin: isTenantAdmin(s), purviewConfigured: isPurviewConfigured() });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  // Default DRY-RUN: a purge must be explicitly requested (dryRun:false).
  const dryRun = body?.dryRun !== false;

  try {
    const scan = await findLineageOrphans();
    if (dryRun) {
      return apiOk({
        dryRun: true,
        purviewConfigured: scan.purviewConfigured,
        scanned: scan.scanned,
        orphans: scan.orphans,
      });
    }
    const purged = await purgeLineageOrphans(scan.orphans);
    return apiOk({
      dryRun: false,
      purviewConfigured: scan.purviewConfigured,
      scanned: scan.scanned,
      orphans: scan.orphans,
      purged,
    });
  } catch (e) {
    return apiServerError(e);
  }
}
