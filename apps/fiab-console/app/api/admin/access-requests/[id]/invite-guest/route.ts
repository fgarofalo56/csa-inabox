/**
 * POST /api/admin/access-requests/[id]/invite-guest  (#2758)
 *
 * Onboard an access requester as an Entra B2B GUEST and approve the request in
 * ONE action — the workflow that was missing (the base route only printed an
 * instruction telling the admin to do this by hand in Entra).
 *
 *   1. Microsoft Graph POST /invitations (inviteExternalGuest) — idempotent via
 *      findGuestByEmail, so re-inviting an existing guest reuses them.
 *   2. best-effort add to the onboarding group (LOOM_ONBOARDING_ENTRA_GROUP_ID /
 *      LOOM_TENANT_ADMIN_GROUP_ID) so they inherit its access.
 *   3. mark the request approved + write the audit trail.
 *
 * Admin-only (requireTenantAdmin). Real tenant writes — honest 403 with the
 * exact consent step when User.Invite.All is not granted (no-vaporware.md).
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  inviteExternalGuest, findGuestByEmail, addPrincipalToGroup,
  GraphIdentityError, LIFECYCLE_APP_ROLES, INVITE_APP_ROLE,
} from '@/lib/azure/graph-identity-client';
import { loadPendingRequest, finalizeApproval, onboardingGroupId, loomRedirectUrl } from '../../_lib/provision';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withTenantAdmin<{ id: string }>(async (req, { session, params }) => {
  const { id } = params;
  if (!id) return apiError('id required', 400);

  try {
    const loaded = await loadPendingRequest(id);
    if (!loaded.ok) return apiError(loaded.error, loaded.status);
    const { doc, tenantId } = loaded.value;

    const redirectUrl = loomRedirectUrl(req.headers.get('origin'));

    // 1. Invite (or reuse an existing guest) — the primary tenant write.
    let invitedUserId: string | undefined;
    let inviteRedeemUrl: string | undefined;
    let reused = false;
    try {
      const existing = await findGuestByEmail(doc.email);
      if (existing) {
        invitedUserId = existing.id;
        reused = true;
      } else {
        const inv = await inviteExternalGuest({ email: doc.email, redirectUrl, displayName: doc.displayName });
        invitedUserId = inv.invitedUserId;
        inviteRedeemUrl = inv.inviteRedeemUrl;
      }
    } catch (e) {
      if (e instanceof GraphIdentityError && e.status === 403) {
        return apiError(
          `Cannot invite guests: the Console identity lacks the ${INVITE_APP_ROLE.name} Graph permission ` +
          `(appRole ${INVITE_APP_ROLE.appRoleId}). Grant it + admin-consent, then retry.`,
          403,
        );
      }
      throw e;
    }

    // 2. Best-effort group add (they still get access via workspace roles if this
    //    is unset). A missing GroupMember.ReadWrite.All is surfaced, not fatal.
    const groupId = onboardingGroupId();
    let groupAdded: boolean | undefined;
    let groupWarning: string | undefined;
    if (groupId && invitedUserId) {
      try {
        await addPrincipalToGroup(groupId, invitedUserId);
        groupAdded = true;
      } catch (e) {
        groupAdded = false;
        const role = LIFECYCLE_APP_ROLES.find((r) => r.name === 'GroupMember.ReadWrite.All');
        groupWarning = (e instanceof GraphIdentityError && e.status === 403)
          ? `Guest invited, but adding them to the onboarding group needs the ${role?.name} Graph permission — grant + consent, then add them manually.`
          : `Guest invited, but the onboarding-group add failed: ${(e as any)?.message || String(e)}.`;
      }
    }

    // 3. Approve + audit.
    const provisioned = `invited as B2B guest${reused ? ' (existing guest reused)' : ''}${groupAdded ? ' + added to onboarding group' : ''}`;
    const updated = await finalizeApproval({
      doc, tenantId,
      actorUpn: session.claims.upn || session.claims.oid,
      actorOid: session.claims.oid,
      provisioned,
    });

    return apiOk({
      request: updated,
      guest: { invitedUserId, inviteRedeemUrl, reused, groupId, groupAdded },
      ...(groupWarning ? { warning: groupWarning } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
});
