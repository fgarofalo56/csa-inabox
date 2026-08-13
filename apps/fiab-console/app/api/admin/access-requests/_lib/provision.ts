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

/**
 * The onboarding group object id an approved principal is added to, if set.
 *
 * SECURITY — this MUST NOT fall back to the tenant-admin group.
 *
 * It used to read:
 *
 *   LOOM_ONBOARDING_ENTRA_GROUP_ID || LOOM_TENANT_ADMIN_GROUP_ID
 *
 * `LOOM_ONBOARDING_ENTRA_GROUP_ID` is set by NO bicep module, param file or
 * workflow (measured 2026-08-13: `grep -rn … platform/fiab/bicep .github/workflows`
 * returns 0). So the first operand was always empty and the fallback was
 * UNCONDITIONAL: approving an access request added the requester to the group
 * `isTenantAdmin()` keys on — i.e. **approving a request made the requester a
 * Loom tenant admin**. Both `create-user` and `invite-guest` call this, and the
 * Console UAMI holds `GroupMember.ReadWrite.All`, so the write would have
 * succeeded. Blast radius was nil only because the path had not been used
 * successfully yet (the admin group had 3 members and 0 guests) — luck, not
 * design.
 *
 * Now it fails CLOSED: with no onboarding group configured this returns
 * undefined, and the caller provisions the principal WITHOUT a group grant
 * rather than granting the wrong one. A user who lands with no group is
 * inconvenienced; a guest who lands as tenant admin is an incident.
 *
 * The real fix is that the deploy should PROVISION a dedicated onboarding group
 * and set `LOOM_ONBOARDING_ENTRA_GROUP_ID` (auto-bind-by-default.md §5 — infra
 * prerequisites are DEPLOYED, not requested). Tracked separately; this change is
 * the security stop-gap, not the whole answer.
 */
export function onboardingGroupId(): string | undefined {
  const g = (process.env.LOOM_ONBOARDING_ENTRA_GROUP_ID || '').trim();
  if (g) return g;
  // Deliberately NOT falling through to LOOM_TENANT_ADMIN_GROUP_ID. Say so, so
  // an operator seeing "provisioned, no group" knows why and what to set.
  console.warn(
    '[access-requests] LOOM_ONBOARDING_ENTRA_GROUP_ID is not set — the approved',
    'principal will be provisioned WITHOUT an Entra group grant. Refusing to fall',
    'back to LOOM_TENANT_ADMIN_GROUP_ID: that would make the requester a Loom',
    'tenant admin. Set LOOM_ONBOARDING_ENTRA_GROUP_ID to a dedicated onboarding group.',
  );
  return undefined;
}

/** The Loom URL a redeemed guest lands on. Prefer the request's own origin (the
 *  admin is on the live Loom host), fall back to the configured public URL. */
export function loomRedirectUrl(originHeader: string | null): string {
  const origin = (originHeader || '').trim();
  if (origin.startsWith('https://')) return origin;
  const configured = (process.env.LOOM_PUBLIC_URL || process.env.LOOM_APP_URL || '').trim();
  return configured || 'https://portal.azure.com';
}
