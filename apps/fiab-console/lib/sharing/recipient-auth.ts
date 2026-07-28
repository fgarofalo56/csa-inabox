/**
 * Loom Sharing — recipient authentication + authorization (LU-9).
 *
 * This is the security boundary for data leaving the estate. Everything here
 * exists because of one upstream fact: the OSS Delta Sharing reference server
 * authenticates with a SINGLE global bearer token and has no concept of a
 * recipient. Whoever holds that token sees every share the server knows about.
 *
 * So Loom never gives that token out. A recipient authenticates to the Console
 * with a Microsoft Entra token; this module turns that token into a recipient
 * record and answers exactly one question per request — "may THIS recipient
 * touch THIS share?" — before the BFF proxies anything to the server.
 *
 * Three failure modes, kept distinct on purpose:
 *   401  the credential is missing/bad/expired/foreign-tenant  → caller's problem
 *   403  authenticated, but not a recipient, or not granted this share
 *   503  WE are not configured to check (no tenant / no audience / sharing off)
 *
 * Conflating 403 into 401 (or worse, into 200 with an empty list) is how a
 * cross-recipient read ships unnoticed, so `authorizeSharingRequest` returns a
 * discriminated union and the route maps it verbatim.
 */

import { verifyEntraBearer } from '@/lib/azure/entra-bearer-verify';
import {
  listRecipients,
  sharingRecipientAudiences,
  isLoomSharingConfigured,
} from './store';
import { matchRecipientByPrincipal, recipientCanAccessShare, type LoomRecipient } from './model';

export type SharingAuthResult =
  | { ok: true; recipient: LoomRecipient; principal: string }
  | { ok: false; status: 401 | 403 | 503; error: string; hint?: string };

/** Open Delta Sharing publishing is on by default (default-ON / opt-out); an
 *  admin turns it off with LOOM_SHARING_ENABLED=false. The real prerequisite —
 *  a deployed sharing server — is reported separately and honestly. */
export function loomSharingEnabled(): boolean {
  return process.env.LOOM_SHARING_ENABLED !== 'false';
}

/** The Loom tenant that owns the shares. Recipients are external, so the owning
 *  tenant cannot be read off the caller's token — it is the estate's own. */
export function sharingOwnerTenantId(): string {
  return (
    process.env.LOOM_ENTRA_TENANT_ID
    || process.env.LOOM_MSAL_TENANT_ID
    || process.env.AZURE_TENANT_ID
    || ''
  ).trim();
}

/**
 * Authenticate the caller and resolve it to a recipient. Does NOT decide share
 * access — see {@link assertShareAccess} — so that "who are you" and "what may
 * you see" stay separately reviewable.
 */
export async function authenticateRecipient(authorizationHeader: string | null | undefined): Promise<SharingAuthResult> {
  if (!loomSharingEnabled()) {
    return {
      ok: false, status: 503,
      error: 'Open Delta Sharing is disabled in this deployment.',
      hint: 'Sharing is on by default; an admin set LOOM_SHARING_ENABLED=false on the loom-console Container App. Remove the override to re-enable.',
    };
  }
  if (!isLoomSharingConfigured()) {
    return {
      ok: false, status: 503,
      error: 'The Loom Sharing server is not deployed in this estate.',
      hint: 'Deploy platform/fiab/bicep/modules/compute/loom-sharing-app.bicep and set LOOM_SHARING_URL on the Console app. See docs/fiab/delta-sharing-gov.md.',
    };
  }
  const tenantId = sharingOwnerTenantId();
  if (!tenantId) {
    return {
      ok: false, status: 503,
      error: 'Recipient authentication is not configured — the estate tenant is unknown.',
      hint: 'Set LOOM_ENTRA_TENANT_ID (or AZURE_TENANT_ID) on the Console app so recipient tokens can be pinned to this tenant.',
    };
  }

  const audiences = sharingRecipientAudiences();
  const verified = await verifyEntraBearer(authorizationHeader, { audiences, tenantId });
  if (!verified.ok) {
    return verified.status === 503
      ? {
        ok: false, status: 503,
        error: verified.error,
        hint: 'Set LOOM_SHARING_AUDIENCE (or LOOM_MSAL_CLIENT_ID) on the Console app so recipient tokens can be pinned to an audience.',
      }
      : { ok: false, status: 401, error: verified.error };
  }

  // A recipient is identified by the principal in the token — the object id of
  // a guest/B2B user, or the application id of a federated service principal.
  // Both are checked because Loom supports either shape of recipient.
  const principals = [verified.claims.objectId, verified.claims.appId];
  const recipients = await listRecipients(tenantId);
  const recipient = matchRecipientByPrincipal(recipients, principals);
  const principal = String(verified.claims.objectId || verified.claims.appId || '').toLowerCase();

  if (!recipient) {
    // Authenticated, but nobody. Deliberately does NOT say whether the principal
    // is unknown or merely disabled — that is a probing oracle for a caller who
    // already proved they are in (or federated with) the tenant.
    return {
      ok: false, status: 403,
      error: 'This identity is not a registered Delta Sharing recipient.',
      hint: 'The share owner registers the recipient in Loom Marketplace → Data shares → Recipients, with this exact Entra object id or application id.',
    };
  }
  return { ok: true, recipient, principal };
}

/**
 * THE cross-recipient check. Recipient A asking for recipient B's share lands
 * here and gets 403 — before any call reaches the sharing server, which would
 * have served it, because the server cannot tell the two apart.
 *
 * Returns null when access is allowed so callers read as a guard clause.
 */
export function assertShareAccess(recipient: LoomRecipient, share: string): SharingAuthResult | null {
  if (recipientCanAccessShare(recipient, share)) return null;
  return {
    ok: false, status: 403,
    // Same message whether the share does not exist or exists but is not
    // granted: a distinguishable answer lets a recipient enumerate the estate's
    // whole share namespace one 404-vs-403 at a time.
    error: `Share "${share}" is not shared with this recipient.`,
    hint: 'Ask the share owner to grant it in Loom Marketplace → Data shares → Recipients.',
  };
}
