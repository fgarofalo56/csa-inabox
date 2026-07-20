/**
 * POST /api/access-governance/reviews/[id]/decision — attest or revoke reviewed
 * grants (access-governance W4, AG-7/AG-14). Reviewer inbox action.
 *
 * Body: { decision: 'attest' | 'revoke', itemIds?: string[], all?: boolean, note?: string }
 *   - itemIds: the review items to decide (BULK — any length).
 *   - all:true: apply to every still-pending item (bulk attest/revoke-all).
 *
 * A 'revoke' decision runs the REAL backend revoke for each affected item's
 * ledger assignment (revokeAssignment → ARM + data-plane + ledger), then records
 * the decision on the campaign. 'attest' just records the decision. Only a named
 * reviewer / delegate (or a tenant admin) may act (canReview). Every call audits.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer, accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { canReview, applyDecision, computeStats } from '@/lib/access/access-reviews';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { normalizeIds } from '@/lib/access/leaver';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({} as any));
  const decision = body?.decision === 'revoke' ? 'revoke' : body?.decision === 'attest' ? 'attest' : null;
  if (!decision) return NextResponse.json({ ok: false, error: 'decision must be "attest" or "revoke"' }, { status: 400 });
  const note = body?.note ? String(body.note).trim().slice(0, 500) : undefined;

  try {
    const c = await accessReviewsContainer();
    // PK is /tenantId (creator oid); a reviewer may not know it → resolve by id.
    const { resources } = await c.items
      .query<AccessReview>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
      .fetchAll();
    const review = resources[0];
    if (!review) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    if (!canReview(review, s.claims.oid, s.claims.groups || [], isTenantAdmin(s))) {
      return NextResponse.json({ ok: false, error: 'You are not a reviewer for this campaign.' }, { status: 403 });
    }
    if (review.status !== 'active') {
      return NextResponse.json({ ok: false, error: `campaign is ${review.status} and can no longer be actioned` }, { status: 409 });
    }

    const targetIds = body?.all === true
      ? review.items.filter((it) => it.decision === 'pending').map((it) => it.id)
      : normalizeIds(body?.itemIds);
    if (targetIds.length === 0) return NextResponse.json({ ok: false, error: 'no items to decide' }, { status: 400 });

    const now = new Date().toISOString();
    const { items, newlyRevoked } = applyDecision(review.items, targetIds, decision, { upn: s.claims.upn, oid: s.claims.oid }, now, note);

    // Run the real backend revoke for each newly-revoked item (best-effort per item).
    const warnings: string[] = [];
    let revokedCount = 0;
    if (decision === 'revoke' && newlyRevoked.length) {
      const ledger = await accessAssignmentsContainer();
      for (const it of newlyRevoked) {
        if (!it.assignmentId) { continue; }
        try {
          const { resource: a } = await ledger.item(it.assignmentId, it.principalId).read<AccessAssignment>();
          if (a) {
            const r = await revokeAssignment(a, s.claims.upn || s.claims.oid);
            if (r.revoked) revokedCount++;
            warnings.push(...r.warnings);
            const idx = items.findIndex((x) => x.id === it.id);
            if (idx >= 0) items[idx] = { ...items[idx], revokedAt: now };
          }
        } catch (e: any) { warnings.push(`${it.id}: ${e?.message || e}`); }
      }
    }

    review.items = items;
    review.updatedAt = now;
    await c.item(review.id, review.tenantId).replace(review);

    // Audit — one entry per decision batch.
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      itemId: review.id,
      itemType: 'access-review',
      action: `review-${decision}`,
      summary: `${s.claims.upn || s.claims.oid} ${decision === 'revoke' ? 'revoked' : 'attested'} ${targetIds.length} grant${targetIds.length === 1 ? '' : 's'} in review "${review.name}"${decision === 'revoke' ? ` (${revokedCount} backend revoke${revokedCount === 1 ? '' : 's'})` : ''}.`,
      upn: s.claims.upn || s.claims.oid,
      at: now,
    });

    return NextResponse.json({
      ok: true,
      decided: targetIds.length,
      ...(decision === 'revoke' ? { revoked: revokedCount } : {}),
      stats: computeStats(items),
      ...(warnings.length ? { revokeWarnings: warnings.slice(0, 20) } : {}),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
