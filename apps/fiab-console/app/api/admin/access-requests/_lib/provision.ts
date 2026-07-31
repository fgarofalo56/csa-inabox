/**
 * Shared provisioning helpers for the access-request onboarding wizards (#2758).
 *
 * The base PATCH /api/admin/access-requests/[id] route only flips a Cosmos
 * status field and returns an INSTRUCTION STRING telling the admin to add the
 * user in Entra by hand. These helpers close that gap: the two sibling routes
 * (invite-guest, create-user) actually provision the requester in the tenant
 * directory via Microsoft Graph, then reuse `finalizeApproval` here to mark the
 * request approved + write the audit trail — exactly what the base route does on
 * approve, minus the instruction string.
 */
import crypto from 'node:crypto';
import { signinAccessRequestsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { deploymentTenantBucket } from '@/lib/access/signin-access-request';
import type { SigninAccessRequest } from '@/lib/types/signin-access-request';

export interface LoadedRequest {
  doc: SigninAccessRequest;
  tenantId: string;
}

/** Load a PENDING request or return a typed error the route can surface. */
export async function loadPendingRequest(id: string): Promise<
  | { ok: true; value: LoadedRequest }
  | { ok: false; status: number; error: string }
> {
  const tenantId = deploymentTenantBucket();
  const c = await signinAccessRequestsContainer();
  let doc: SigninAccessRequest;
  try {
    const { resource } = await c.item(id, tenantId).read<SigninAccessRequest>();
    if (!resource) return { ok: false, status: 404, error: 'not found' };
    doc = resource;
  } catch (e: any) {
    if (e?.code === 404) return { ok: false, status: 404, error: 'not found' };
    throw e;
  }
  if (doc.status !== 'pending') {
    return { ok: false, status: 409, error: `request is already ${doc.status} and can no longer be actioned` };
  }
  return { ok: true, value: { doc, tenantId } };
}

/**
 * Mark the request approved and write the audit entry. `provisioned` describes
 * what was actually done in the tenant (guest invited / member created) so the
 * audit trail is precise, not a generic "approved".
 */
export async function finalizeApproval(opts: {
  doc: SigninAccessRequest;
  tenantId: string;
  actorUpn: string;
  actorOid: string;
  provisioned: string;
}): Promise<SigninAccessRequest> {
  const now = new Date().toISOString();
  const { doc, tenantId } = opts;
  const c = await signinAccessRequestsContainer();
  doc.status = 'approved';
  doc.reviewedBy = opts.actorUpn;
  doc.reviewedByOid = opts.actorOid;
  doc.reviewedAt = now;
  doc.updatedAt = now;
  doc.decisionNote = opts.provisioned;
  await c.item(doc.id, tenantId).replace(doc);

  const al = await auditLogContainer();
  await al.items.create({
    id: crypto.randomUUID(),
    itemId: doc.id,
    itemType: 'signin-access-request',
    action: 'access-request-provisioned',
    summary: `${opts.actorUpn} approved + provisioned ${doc.displayName} <${doc.email}> — ${opts.provisioned}`,
    upn: opts.actorUpn,
    at: now,
  });
  return doc;
}

/** The onboarding group object id an approved principal is added to, if set. */
export function onboardingGroupId(): string | undefined {
  const g = (process.env.LOOM_ONBOARDING_ENTRA_GROUP_ID || process.env.LOOM_TENANT_ADMIN_GROUP_ID || '').trim();
  return g || undefined;
}

/** The Loom URL a redeemed guest lands on. Prefer the request's own origin (the
 *  admin is on the live Loom host), fall back to the configured public URL. */
export function loomRedirectUrl(originHeader: string | null): string {
  const origin = (originHeader || '').trim();
  if (origin.startsWith('https://')) return origin;
  const configured = (process.env.LOOM_PUBLIC_URL || process.env.LOOM_APP_URL || '').trim();
  return configured || 'https://portal.azure.com';
}
