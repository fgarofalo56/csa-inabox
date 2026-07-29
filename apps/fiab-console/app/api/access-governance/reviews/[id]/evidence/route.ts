/**
 * Signed evidence pack for an access-review campaign (loom-apex B-N19c').
 *
 *   GET /api/access-governance/reviews/[id]/evidence
 *     → { ok, records, verification, summary, campaign } — the inline view the
 *       admin surface renders (chain-integrity badge + readable summary).
 *
 *   GET /api/access-governance/reviews/[id]/evidence?download=json
 *     → application/json attachment `access-review-evidence-<slug>.json`
 *       (the machine-verifiable pack: every record with its prevHash/contentHash).
 *
 *   GET /api/access-governance/reviews/[id]/evidence?download=txt
 *     → text/plain attachment `access-review-evidence-<slug>.txt`
 *       (the readable auditor summary).
 *
 *   `?scope=tenant` verifies/exports the WHOLE tenant chain instead of just this
 *   campaign's records — the continuity proof an auditor asks for.
 *
 * Tenant-admin only, via the shared route-toolkit (`withTenantAdmin`). Azure-native
 * (Cosmos `access-review-evidence`) — no Fabric dependency.
 */
import { slugify as sharedSlugify } from '@/lib/util/trim';
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { accessReviewsContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import { listCampaignEvidence, listTenantEvidence } from '@/lib/access/evidence-store';
import { buildEvidencePack } from '@/lib/access/evidence-record';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slugify(s: string): string {
  return sharedSlugify(s || 'campaign', { allow: /[^a-z0-9]+/g, max: 60, fallback: 'campaign' });
}

export const GET = withTenantAdmin<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id } = params;
  const c = await accessReviewsContainer();
  const { resources } = await c.items
    .query<AccessReview>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  const review = resources[0];
  if (!review) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const tenantScope = req.nextUrl.searchParams.get('scope') === 'tenant';
  const records = tenantScope
    ? await listTenantEvidence(review.tenantId)
    : await listCampaignEvidence(review.tenantId, review.id);

  const { pack, summary } = buildEvidencePack(records, {
    ...(tenantScope ? {} : { campaignId: review.id }),
    // A single campaign's records are a SUBSET of the tenant chain, so genesis /
    // gap checks would false-positive; the full-tenant scope verifies those.
    partial: !tenantScope,
  });

  const download = req.nextUrl.searchParams.get('download');
  const stamp = tenantScope ? `tenant-${slugify(review.tenantId)}` : slugify(review.name);
  if (download === 'json') {
    return new NextResponse(JSON.stringify(pack, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="access-review-evidence-${stamp}.json"`,
        'cache-control': 'no-store',
      },
    });
  }
  if (download === 'txt') {
    return new NextResponse(summary, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="access-review-evidence-${stamp}.txt"`,
        'cache-control': 'no-store',
      },
    });
  }

  return NextResponse.json({
    ok: true,
    campaign: { id: review.id, name: review.name, status: review.status, closedAt: review.closedAt || null },
    scope: tenantScope ? 'tenant' : 'campaign',
    records: pack.records,
    verification: pack.verification,
    summary,
  });
});
