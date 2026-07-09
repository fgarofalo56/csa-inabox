/**
 * POST /api/admin/lineage/reconcile   — admin-only lineage orphan reconciliation.
 *
 * Reconciles TWO orphan planes and reports — or, when {dryRun:false}, purges —
 * both:
 *   • Purview: Loom-provisioned Microsoft Purview entities (qualifiedName scheme
 *     `loom://<tenantId>/<workspaceId>/<itemType>/<itemId>`, registered at
 *     provision/scan time by purview-autoonboard.ts) whose backing Loom item was
 *     deleted. No-op when Purview is unconfigured.
 *   • Thread edges: Loom-native Weave/Thread edges (Cosmos `thread-edges`,
 *     rendered on /thread) with a source or non-external target item that no
 *     longer exists. Runs even without Purview — the /thread graph has its own
 *     pre-existing debris (the 2026-07-08 UAT purge left orphaned edges that
 *     delete-time reconciliation, wired later, never cleaned).
 *
 * This is the one-time cleanup of the 2026-07-08 UAT purge debris still
 * rendering on Analyze → Lineage AND /thread, plus an on-demand sweep going
 * forward.
 *
 * Contract:
 *   Request : { dryRun?: boolean }   (default TRUE — never purge unless asked)
 *   Response (dry-run) : { ok, dryRun:true, purviewConfigured, scanned, orphans:[…],
 *                          threadEdges:{ scanned, orphans:[…] } }
 *   Response (purge)   : { ok, dryRun:false, purviewConfigured, scanned,
 *                          orphans:[…], purged:[…],
 *                          threadEdges:{ scanned, orphans:[…], purged:[…] } }
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
import {
  findLineageOrphans,
  purgeLineageOrphans,
  findThreadEdgeOrphans,
  purgeThreadEdgeOrphans,
} from '@/lib/azure/lineage-gc';
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
    // Two independent orphan planes: externally-registered Purview Atlas
    // entities, and Loom-native Weave/Thread edges (Cosmos). The Thread sweep
    // runs even when Purview is unconfigured — the /thread graph has its own
    // pre-existing debris.
    const [scan, threadScan] = await Promise.all([
      findLineageOrphans(),
      findThreadEdgeOrphans(),
    ]);
    if (dryRun) {
      return apiOk({
        dryRun: true,
        purviewConfigured: scan.purviewConfigured,
        scanned: scan.scanned,
        orphans: scan.orphans,
        threadEdges: { scanned: threadScan.scanned, orphans: threadScan.orphans },
      });
    }
    const purged = await purgeLineageOrphans(scan.orphans);
    const threadPurged = await purgeThreadEdgeOrphans(threadScan.orphans);
    return apiOk({
      dryRun: false,
      purviewConfigured: scan.purviewConfigured,
      scanned: scan.scanned,
      orphans: scan.orphans,
      purged,
      threadEdges: {
        scanned: threadScan.scanned,
        orphans: threadScan.orphans,
        purged: threadPurged,
      },
    });
  } catch (e) {
    return apiServerError(e);
  }
}
