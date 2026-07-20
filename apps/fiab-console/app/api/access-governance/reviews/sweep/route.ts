/**
 * POST /api/access-governance/reviews/sweep — close past-deadline review
 * campaigns (access-governance W4, AG-7). Finds ACTIVE campaigns whose `dueAt`
 * has passed and CLOSES them; when a campaign opted into auto-revoke, every
 * still-undecided grant is revoked through the shared real revoke path
 * (closeCampaign → revokeAssignment). Idempotent (a closed campaign is never
 * re-processed) and audited. ?dryRun=1 reports what WOULD close, revokes nothing.
 *
 * Auth mirrors the W3 expiry sweep: the timer Function presents the shared system
 * token (LOOM_SWEEPER_TOKEN); a human admin uses their session. Runs day-one via
 * the admin "Run review sweep" button and on a schedule from
 * azure-functions/access-governance-sweeper.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import { isOverdue, selectAutoRevoke } from '@/lib/access/access-reviews';
import { closeCampaign } from '@/lib/access/close-campaign';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const sysToken = req.headers.get('x-loom-system-token');
  const sysOk = !!sysToken && !!process.env.LOOM_SWEEPER_TOKEN && sysToken === process.env.LOOM_SWEEPER_TOKEN;
  const session = getSession();
  if (!sysOk) {
    const gate = requireTenantAdmin(session);
    if (gate) return gate;
  }
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const now = new Date();

  try {
    const c = await accessReviewsContainer();
    const { resources } = await c.items
      .query<AccessReview>({
        query: "SELECT * FROM c WHERE c.status = 'active' AND IS_DEFINED(c.dueAt) AND c.dueAt != null AND c.dueAt <= @now",
        parameters: [{ name: '@now', value: now.toISOString() }],
      })
      .fetchAll();
    const due = (resources || []).filter((r) => isOverdue(r, now));

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, candidates: due.length,
        campaigns: due.map((r) => ({ id: r.id, name: r.name, dueAt: r.dueAt, wouldRevoke: selectAutoRevoke(r).length })),
      });
    }

    const by = sysOk ? 'system:review-sweeper' : (session?.claims.upn || session?.claims.oid || 'admin');
    let closed = 0, revoked = 0; const warnings: string[] = [];
    for (const r of due) {
      const res = await closeCampaign(r, by);
      await c.item(res.review.id, res.review.tenantId).replace(res.review);
      closed++; revoked += res.revoked; warnings.push(...res.warnings);
    }
    return NextResponse.json({ ok: true, dryRun: false, candidates: due.length, closed, autoRevoked: revoked, ...(warnings.length ? { revokeWarnings: warnings.slice(0, 20) } : {}), by });
  } catch (e: any) {
    return apiServerError(e);
  }
}
