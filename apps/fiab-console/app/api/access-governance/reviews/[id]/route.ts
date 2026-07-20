/**
 * A single access-review campaign (access-governance W4).
 *
 *   GET    /api/access-governance/reviews/[id]  → campaign + items + stats
 *                                                 (reviewer/delegate/admin only)
 *   PATCH  /api/access-governance/reviews/[id]  → tenant-admin manage:
 *                                                 { action: 'close' | 'delegate' | 'reopen',
 *                                                   delegatedTo?: ApproverBinding[] }
 *                                                 'close' auto-revokes undecided
 *                                                 items when autoRevokeOnExpiry.
 *   DELETE /api/access-governance/reviews/[id]  → delete the campaign (admin).
 *
 * Backed by `access-reviews` (PK /tenantId). Closing a campaign runs the same real
 * revoke path as the reviewer inbox for any still-pending items (auto-revoke).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import type { ApproverBinding } from '@/lib/types/approval-policy';
import { canReview, computeStats } from '@/lib/access/access-reviews';
import { closeCampaign } from '@/lib/access/close-campaign';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readById(id: string): Promise<AccessReview | null> {
  const c = await accessReviewsContainer();
  const { resources } = await c.items
    .query<AccessReview>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  return resources[0] || null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const review = await readById(id);
    if (!review) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    if (!canReview(review, s.claims.oid, s.claims.groups || [], isTenantAdmin(s))) {
      return NextResponse.json({ ok: false, error: 'You are not a reviewer for this campaign.' }, { status: 403 });
    }
    return NextResponse.json({ ok: true, review: { ...review, stats: computeStats(review.items || []) } });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const review = await readById(id);
    if (!review) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    const action = body?.action;
    const c = await accessReviewsContainer();
    const by = s!.claims.upn || s!.claims.oid;

    if (action === 'close') {
      if (review.status !== 'active') return NextResponse.json({ ok: false, error: `campaign is already ${review.status}` }, { status: 409 });
      const { review: closed, revoked, warnings } = await closeCampaign(review, by);
      await c.item(closed.id, closed.tenantId).replace(closed);
      const al = await auditLogContainer();
      await al.items.create({ id: crypto.randomUUID(), itemId: closed.id, itemType: 'access-review', action: 'review-closed', summary: `${by} closed review "${closed.name}" — ${revoked} undecided grant${revoked === 1 ? '' : 's'} auto-revoked.`, upn: by, at: closed.updatedAt });
      return NextResponse.json({ ok: true, review: { ...closed, stats: computeStats(closed.items) }, autoRevoked: revoked, ...(warnings.length ? { revokeWarnings: warnings.slice(0, 20) } : {}) });
    }

    if (action === 'reopen') {
      review.status = 'active';
      review.closedAt = undefined;
      review.closedBy = undefined;
      review.updatedAt = new Date().toISOString();
      await c.item(review.id, review.tenantId).replace(review);
      return NextResponse.json({ ok: true, review: { ...review, stats: computeStats(review.items) } });
    }

    if (action === 'delegate') {
      const delegatedTo: ApproverBinding[] = (Array.isArray(body?.delegatedTo) ? body.delegatedTo : [])
        .map((r: any) => ({ type: r?.type === 'group' ? 'group' : 'user', id: String(r?.id || '').trim(), name: r?.name ? String(r.name).trim().slice(0, 200) : undefined }))
        .filter((r: ApproverBinding) => r.id);
      review.delegatedTo = delegatedTo;
      review.updatedAt = new Date().toISOString();
      await c.item(review.id, review.tenantId).replace(review);
      const al = await auditLogContainer();
      await al.items.create({ id: crypto.randomUUID(), itemId: review.id, itemType: 'access-review', action: 'review-delegated', summary: `${by} delegated review "${review.name}" to ${delegatedTo.length} reviewer${delegatedTo.length === 1 ? '' : 's'}.`, upn: by, at: review.updatedAt });
      return NextResponse.json({ ok: true, review: { ...review, stats: computeStats(review.items) } });
    }

    return NextResponse.json({ ok: false, error: 'action must be "close", "reopen", or "delegate"' }, { status: 400 });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const { id } = await ctx.params;
  try {
    const review = await readById(id);
    if (!review) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const c = await accessReviewsContainer();
    await c.item(review.id, review.tenantId).delete();
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: any) {
    return apiServerError(e);
  }
}
