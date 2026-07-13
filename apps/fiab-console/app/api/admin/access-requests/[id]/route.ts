/**
 * PATCH /api/admin/access-requests/[id] — action a sign-in-boundary onboarding
 * request. Admin-only (requireTenantAdmin).
 *
 * Body: { decision: 'approved' | 'denied', note?: string }
 *   - approved → status='approved'. Onboarding the user in Entra is a manual
 *     admin step (Loom can't add a member to the tenant admin Entra group on the
 *     admin's behalf); the response returns the EXACT onboarding instruction so
 *     the admin knows precisely what to do next (per no-vaporware — honest about
 *     what is and isn't automated).
 *   - denied → status='denied'. A note is REQUIRED so the decision is auditable.
 *
 * Every decision writes an audit-log entry (itemId = requestId). No Fabric
 * dependency — Cosmos only.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { signinAccessRequestsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { deploymentTenantBucket } from '@/lib/access/signin-access-request';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import type { SigninAccessRequest } from '@/lib/types/signin-access-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The honest, exact next step for the admin after approving. Names the real
 * deploy param the tenant admin bootstrap uses (LOOM_TENANT_ADMIN_GROUP_ID /
 * LOOM_TENANT_ADMIN_OID on the loom-console container app) so onboarding is not
 * a mystery. If a shared onboarding group name is configured we name it too.
 */
function onboardingInstruction(req: SigninAccessRequest): string {
  const group = process.env.LOOM_ONBOARDING_ENTRA_GROUP_NAME || process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  const target = group
    ? `Add ${req.email} to the Entra group "${group}"`
    : `Add ${req.email} to the Entra group set on LOOM_TENANT_ADMIN_GROUP_ID (or grant them a workspace role)`;
  return (
    `${target}, then have them sign in at the Loom URL. ` +
    `Group membership is the authorization source — Loom reads it from the user's token on next sign-in. ` +
    (req.aadObjectId ? `Their stated Entra object id: ${req.aadObjectId}. ` : '') +
    `This step is performed in Entra / your IdP; Loom does not modify tenant group membership on your behalf.`
  );
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const { id } = await ctx.params;
  if (!id) return apiError('id required', 400);

  const body = await req.json().catch(() => ({} as any));
  const decision = body?.decision === 'denied' ? 'denied' : body?.decision === 'approved' ? 'approved' : null;
  if (!decision) return apiError('decision must be "approved" or "denied"', 400);
  const note = String(body?.note || '').trim().slice(0, 500);
  if (decision === 'denied' && !note) {
    return apiError('a note is required to deny a request', 400);
  }

  const tenantId = deploymentTenantBucket();
  const now = new Date().toISOString();

  try {
    const c = await signinAccessRequestsContainer();
    let doc: SigninAccessRequest;
    try {
      const { resource } = await c.item(id, tenantId).read<SigninAccessRequest>();
      if (!resource) return apiError('not found', 404);
      doc = resource;
    } catch (e: any) {
      if (e?.code === 404) return apiError('not found', 404);
      throw e;
    }

    if (doc.status !== 'pending') {
      return apiError(`request is already ${doc.status} and can no longer be actioned`, 409);
    }

    doc.status = decision === 'approved' ? 'approved' : 'denied';
    doc.reviewedBy = s!.claims.upn || s!.claims.oid;
    doc.reviewedByOid = s!.claims.oid;
    doc.reviewedAt = now;
    doc.updatedAt = now;
    if (note) doc.decisionNote = note;

    await c.item(id, tenantId).replace(doc);

    // Audit trail — one entry per decision (itemId = requestId).
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      itemId: id,
      itemType: 'signin-access-request',
      action: `access-request-${decision}`,
      summary:
        `${s!.claims.upn || s!.claims.oid} ${decision} the onboarding request from ` +
        `${doc.displayName} <${doc.email}>${note ? ` — "${note}"` : ''}`,
      upn: s!.claims.upn || s!.claims.oid,
      at: now,
    });

    return apiOk({
      request: doc,
      ...(decision === 'approved' ? { onboarding: onboardingInstruction(doc) } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
}
