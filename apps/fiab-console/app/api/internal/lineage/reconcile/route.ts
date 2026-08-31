/**
 * POST /api/internal/lineage/reconcile — the SCHEDULED half of lineage GC.
 *
 * LIN-GC-2. Delete-time cleanup (LIN-GC-1) already runs: `lib/azure/lineage-gc.ts`
 * is wired into the per-item DELETE, the workspace cascade and bulk-delete, so
 * an item removed through Loom reconciles its Purview entity and Thread edges on
 * the way out. What has never existed is the SWEEP — the periodic reconciliation
 * that catches debris delete-time cleanup could not:
 *
 *   · items deleted BEFORE LIN-GC-1 shipped (the 2026-07-08 UAT purge left
 *     orphaned Thread edges that nothing has ever cleaned),
 *   · items deleted out-of-band — straight from the Azure portal, or by a failed
 *     provision that registered a Purview entity and then rolled back,
 *   · a delete whose cleanup half failed. `cleanupItemMetadata` is deliberately
 *     FIRE-AND-FORGET best-effort: a Purview outage during a delete loses that
 *     reconciliation silently and permanently, because nothing ever retries it.
 *
 * The operator reported this gap on 2026-08-30 while asking where "the cleanup
 * engine" was: the manual reconcile dialog exists (mounted on
 * /governance/lineage) and the delete-time path exists, but nothing scheduled
 * either, so orphans accumulate until someone opens that page and clicks.
 *
 * ── DRY-RUN BY DEFAULT, AND THAT IS A DELIBERATE ASYMMETRY ───────────────────
 *
 * The admin route (POST /api/admin/lineage/reconcile) accepts `dryRun:false` and
 * purges. This one does NOT: a scheduled, unattended purge is a destructive
 * action nobody watched, and the failure mode is deleting metadata for an item
 * whose absence was a READ failure rather than a real deletion — exactly the
 * unknown-spent-as-a-negative shape deploy-integrity R7 forbids, but with
 * permanent consequences.
 *
 * So this endpoint SCANS and REPORTS. It makes orphans visible on a cadence; a
 * human still authorises the purge from the dialog. `LOOM_LINEAGE_GC_PURGE=true`
 * exists as an explicit opt-in for an operator who wants the sweep to act, and
 * it is OFF unless deliberately set — the narrow cost/destructive exception
 * auto-bind-by-default.md §5 allows, rather than the default.
 *
 * Auth: the shared, bicep-wired internal trust token (LOOM_INTERNAL_TOKEN),
 * accepted as `Authorization: Bearer <token>` or `x-loom-internal-token`. NOT
 * cookie-authenticated (a timer has no MSAL session) and FAILS CLOSED when the
 * token env var is unset, so it is inert until a deployment opts in.
 *
 * Idempotency: a scan mutates nothing, so a duplicated or missed tick costs
 * nothing. That is the other reason the default is scan-only.
 */
import { NextRequest } from 'next/server';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  findLineageOrphans,
  findThreadEdgeOrphans,
  findAccessArtifactOrphans,
  purgeLineageOrphans,
  purgeThreadEdgeOrphans,
  purgeAccessArtifactOrphans,
} from '@/lib/azure/lineage-gc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

/**
 * Purging on a schedule is OPT-IN and off by default. Read affirmatively —
 * anything that is not an explicit yes is a no, so a typo or an empty string
 * cannot arm an unattended delete.
 */
function purgeArmed(): boolean {
  const v = (process.env.LOOM_LINEAGE_GC_PURGE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });

  const body = await req.json().catch(() => ({} as { trigger?: string }));
  const trigger = String((body as { trigger?: string })?.trigger || 'scheduled');

  try {
    // Three independent orphan planes, scanned together because they share the
    // item-existence read and a partial answer is worse than a slower one.
    const [scan, threadScan, accessScan] = await Promise.all([
      findLineageOrphans(),
      findThreadEdgeOrphans(),
      findAccessArtifactOrphans(),
    ]);

    const found =
      scan.orphans.length
      + threadScan.orphans.length
      + accessScan.notifications.orphans.length
      + accessScan.requests.orphans.length;

    if (!purgeArmed()) {
      return apiOk({
        trigger,
        purged: false,
        // Named so a reader cannot mistake "nothing was deleted" for "nothing
        // was found" — the two are different facts and only one is good news.
        reason: 'scan-only: LOOM_LINEAGE_GC_PURGE is not set. Orphans are REPORTED, never deleted, on the scheduled path. Purge from Governance → Lineage → Reconcile, where a human authorises it.',
        purviewConfigured: scan.purviewConfigured,
        found,
        scanned: scan.scanned,
        orphans: scan.orphans,
        threadEdges: { scanned: threadScan.scanned, orphans: threadScan.orphans },
        accessArtifacts: accessScan,
      });
    }

    const purged = await purgeLineageOrphans(scan.orphans);
    const threadPurged = await purgeThreadEdgeOrphans(threadScan.orphans);
    const accessPurged = await purgeAccessArtifactOrphans(accessScan);
    return apiOk({
      trigger,
      purged: true,
      purviewConfigured: scan.purviewConfigured,
      found,
      scanned: scan.scanned,
      orphans: scan.orphans,
      purgeOutcomes: purged,
      threadEdges: { scanned: threadScan.scanned, orphans: threadScan.orphans, purged: threadPurged },
      accessArtifacts: { ...accessScan, purged: accessPurged },
    });
  } catch (e) {
    return apiServerError(e);
  }
}
