/**
 * POST /api/access-governance/reviews/sweep — close past-deadline review
 * campaigns (access-governance W4, AG-7). Finds ACTIVE campaigns whose `dueAt`
 * has passed and CLOSES them; when a campaign opted into auto-revoke, every
 * still-undecided grant is revoked through the shared real revoke path
 * (closeCampaign → revokeAssignment), and each close is sealed into the tenant's
 * hash-chained evidence record (B-N19c'). Idempotent (a closed campaign is never
 * re-processed) and audited. ?dryRun=1 reports what WOULD close, revokes nothing.
 *
 * Auth mirrors the W3 expiry sweep: the timer Function presents the shared system
 * token (LOOM_SWEEPER_TOKEN) and runs WITHOUT a browser session; a human admin is
 * gated through the shared route-toolkit (`withTenantAdmin`, which supplies the
 * canonical 401/403 envelopes + the try/catch→apiServerError wrapper). Runs
 * day-one via the admin "Run review sweep" button and on a schedule from
 * azure-functions/access-governance-sweeper.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { accessReviewsContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import { isOverdue, selectAutoRevoke } from '@/lib/access/access-reviews';
import { closeCampaign } from '@/lib/access/close-campaign';
import { apiServerError } from '@/lib/api/respond';
import type { EvidenceActor } from '@/lib/access/evidence-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The sweep itself — identical work for the system caller and a human admin. */
async function runSweep(req: NextRequest, by: string, actor: EvidenceActor): Promise<Response> {
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const now = new Date();
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

  let closed = 0, revoked = 0, sealed = 0; const warnings: string[] = [];
  for (const r of due) {
    // closeCampaign persists the closed campaign AND seals its hash-chained
    // evidence record (B-N19c'); no separate replace here.
    const res = await closeCampaign(r, by, actor);
    closed++; revoked += res.revoked; if (res.evidence) sealed++; warnings.push(...res.warnings);
  }
  return NextResponse.json({ ok: true, dryRun: false, candidates: due.length, closed, autoRevoked: revoked, evidenceSealed: sealed, ...(warnings.length ? { revokeWarnings: warnings.slice(0, 20) } : {}), by });
}

/** Human-admin path — session (401) + tenant-admin (403) through the toolkit. */
const adminSweep = withTenantAdmin(async (req: NextRequest, { session }) =>
  runSweep(req, session.claims.upn || session.claims.oid, {
    oid: session.claims.oid, upn: session.claims.upn, tid: session.claims.tid,
  }),
);

export async function POST(req: NextRequest) {
  const sysToken = req.headers.get('x-loom-system-token');
  const sysOk = !!sysToken && !!process.env.LOOM_SWEEPER_TOKEN && sysToken === process.env.LOOM_SWEEPER_TOKEN;
  if (!sysOk) return adminSweep(req, { params: Promise.resolve({}) });
  try {
    return await runSweep(req, 'system:review-sweeper', { upn: 'system:review-sweeper' });
  } catch (e) {
    return apiServerError(e);
  }
}
