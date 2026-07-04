/**
 * GET  /api/data-products/[id]/access-policy
 * PUT  /api/data-products/[id]/access-policy
 *
 * F8 — "Manage policies" for a data product. The access policy (allowed
 * purposes, manager-approval + privacy-review tiers, named approvers, access
 * provider) is persisted as `state.accessPolicy` on the `data-product`
 * WorkspaceItem in the Cosmos `items` container. No separate container, no
 * Fabric / Purview dependency — this is Cosmos-only and works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Published guard: Purview only permits managing access policies while the
 * data product is UNPUBLISHED. We mirror that — when `state.apimPublished` is
 * true the PUT returns HTTP 409 { code:'published_locked' } and the editor
 * blocks the dialog with a MessageBar.
 *
 * Enforcement (granting the real Storage/Synapse/ADX RBAC) happens later at
 * access-request APPROVAL time via lib/azure/access-policy-client.ts — this
 * route only records the policy.
 *
 * Status semantics:
 *   200 — policy returned / persisted. Body: { ok, policy }.
 *   401 — unauthenticated.
 *   404 — data-product item not found (or not owned by caller's tenant).
 *   409 — product is Published; unpublish to edit. Body: { ok:false, code:'published_locked' }.
 *   422 — malformed policy body.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../items/_lib/item-crud';
import {
  defaultAccessPolicy,
  normalizeAccessPolicy,
  type DataProductAccessPolicy,
  type PolicyPrincipal,
} from '@/lib/types/access-policy';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, extra: Record<string, unknown> = {}) {
  return apiError(error, status, extra);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;
  const policy = state.accessPolicy
    ? normalizeAccessPolicy(state.accessPolicy)
    : defaultAccessPolicy();

  return NextResponse.json({
    ok: true,
    policy,
    productPublished: state.apimPublished === true,
  });
}

function sanitizePrincipal(x: any): PolicyPrincipal | null {
  if (!x || typeof x !== 'object' || !x.id) return null;
  return {
    id: String(x.id),
    upn: String(x.upn || x.mail || x.displayName || x.id),
    displayName: String(x.displayName || x.upn || x.id),
    type: x.type === 'Group' ? 'Group' : 'User',
  };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;

  // Published guard — Purview requires an unpublished product to manage policies.
  if (state.apimPublished === true) {
    return err(
      'Cannot update the access policy while the product is Published. Unpublish the data product first.',
      409,
      { code: 'published_locked' },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Request body must be valid JSON.', 422);
  }
  if (!body || typeof body !== 'object') return err('Request body must be an object.', 422);

  const purposes = Array.isArray(body.allowedPurposes) ? body.allowedPurposes : [];
  const approvers = Array.isArray(body.approvers) ? body.approvers : [];

  const policy: DataProductAccessPolicy = {
    allowedPurposes: purposes
      .filter((p: any) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
      .map((p: any) => ({ name: String(p.name).trim(), description: String(p.description || '').trim() })),
    requireManagerApproval: !!body.requireManagerApproval,
    requirePrivacyReview: !!body.requirePrivacyReview,
    approvers: approvers.map(sanitizePrincipal).filter((x: PolicyPrincipal | null): x is PolicyPrincipal => x !== null),
    accessProvider: sanitizePrincipal(body.accessProvider),
    updatedAt: new Date().toISOString(),
    updatedBy: session.claims.upn || session.claims.email || session.claims.oid,
  };

  const nextState = { ...state, accessPolicy: policy };
  const updated = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, { state: nextState });
  if (!updated) return err('Failed to persist the access policy to Cosmos.', 500);

  return NextResponse.json({ ok: true, policy });
}
