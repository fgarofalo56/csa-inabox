/**
 * POST /api/admin/access-requests/[id]/create-user  (#2758)
 *
 * Create a NEW MEMBER user in the tenant for an access requester and approve the
 * request in ONE action — for a requester who should be a full member, not a
 * guest. The other half of the onboarding workflow the base route lacked.
 *
 *   1. Microsoft Graph POST /users (createTenantUser) with a generated one-time
 *      password (forceChangePasswordNextSignIn).
 *   2. best-effort add to the onboarding group.
 *   3. mark the request approved + write the audit trail.
 *
 * The temporary password is returned ONCE (never stored / logged) so the admin
 * can hand it over. Admin-only. Honest 403 with the exact consent step when
 * User.ReadWrite.All is not granted (no-vaporware.md).
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  createTenantUser, addPrincipalToGroup,
  GraphIdentityError, LIFECYCLE_APP_ROLES,
} from '@/lib/azure/graph-identity-client';
import { loadPendingRequest, finalizeApproval, onboardingGroupId } from '../../_lib/provision';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A strong, standards-compliant one-time password: mixed classes, no ambiguity. */
function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const sym = '!@#$%^&*-_=+';
  const all = upper + lower + digit + sym;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  // Guarantee one of each class, then fill to 20 chars from the full set.
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < 20) chars.push(pick(all));
  // Fisher-Yates shuffle with crypto randomness.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Derive a mailNickname from an email local part (Graph requires it, letters/
 *  digits only, non-empty). */
function mailNicknameFrom(email: string): string {
  const local = (email.split('@')[0] || 'user').replace(/[^A-Za-z0-9]/g, '');
  return local || `user${crypto.randomInt(100000)}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const { id } = await ctx.params;
  if (!id) return apiError('id required', 400);

  const body = await req.json().catch(() => ({} as any));
  // Optional admin override for the UPN domain (else derived from the request email
  // when it is already an in-tenant address; a foreign email needs a UPN domain).
  const upnDomain = String(body?.upnDomain || '').trim().replace(/^@/, '');

  try {
    const loaded = await loadPendingRequest(id);
    if (!loaded.ok) return apiError(loaded.error, loaded.status);
    const { doc, tenantId } = loaded.value;

    const nickname = mailNicknameFrom(doc.email);
    // A member UPN must live in a verified tenant domain. If the request email is
    // already in-tenant, use it; otherwise require the admin to name the domain.
    const emailDomain = doc.email.split('@')[1] || '';
    const domain = upnDomain || emailDomain;
    if (!domain) return apiError('upnDomain is required (the verified tenant domain for the new member UPN)', 400);
    const userPrincipalName = `${nickname}@${domain}`;

    const tempPassword = generateTempPassword();
    let created;
    try {
      created = await createTenantUser({
        displayName: doc.displayName,
        userPrincipalName,
        mailNickname: nickname,
        temporaryPassword: tempPassword,
      });
    } catch (e) {
      if (e instanceof GraphIdentityError && e.status === 403) {
        const role = LIFECYCLE_APP_ROLES.find((r) => r.name === 'User.ReadWrite.All');
        return apiError(
          `Cannot create tenant users: the Console identity lacks the ${role?.name} Graph permission ` +
          `(appRole ${role?.appRoleId}). Grant it + admin-consent, then retry.`,
          403,
        );
      }
      if (e instanceof GraphIdentityError && e.status === 400) {
        return apiError(`Graph rejected the new user (UPN ${userPrincipalName} — is the domain verified?): ${(e.body as any)?.error?.message || e.message}`, 400);
      }
      throw e;
    }

    // Best-effort group add.
    const groupId = onboardingGroupId();
    let groupAdded: boolean | undefined;
    let groupWarning: string | undefined;
    if (groupId && created.id) {
      try {
        await addPrincipalToGroup(groupId, created.id);
        groupAdded = true;
      } catch (e) {
        groupAdded = false;
        const role = LIFECYCLE_APP_ROLES.find((r) => r.name === 'GroupMember.ReadWrite.All');
        groupWarning = (e instanceof GraphIdentityError && e.status === 403)
          ? `User created, but adding them to the onboarding group needs the ${role?.name} Graph permission — grant + consent, then add them manually.`
          : `User created, but the onboarding-group add failed: ${(e as any)?.message || String(e)}.`;
      }
    }

    const provisioned = `created tenant member ${userPrincipalName}${groupAdded ? ' + added to onboarding group' : ''}`;
    const updated = await finalizeApproval({
      doc, tenantId,
      actorUpn: s!.claims.upn || s!.claims.oid,
      actorOid: s!.claims.oid,
      provisioned,
    });

    // temporaryPassword is returned ONCE — the admin hands it over; Loom never stores it.
    return apiOk({
      request: updated,
      user: { id: created.id, userPrincipalName: created.userPrincipalName, displayName: created.displayName, groupId, groupAdded },
      temporaryPassword: created.temporaryPassword,
      ...(groupWarning ? { warning: groupWarning } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
}
