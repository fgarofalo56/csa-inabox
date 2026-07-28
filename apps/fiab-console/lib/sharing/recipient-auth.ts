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
  sharingRequiredScopes,
  isLoomSharingConfigured,
} from './store';
import { matchRecipientByPrincipal, recipientCanAccessShare, type LoomRecipient } from './model';

export type SharingAuthResult =
  | { ok: true; recipient: LoomRecipient; principal: string }
  | {
    ok: false;
    status: 401 | 403 | 503;
    error: string;
    /**
     * Caller-safe remediation. Set ONLY for a caller that has already proved it
     * holds a valid token for this estate. An unauthenticated caller never gets
     * one — see {@link operatorHint}.
     */
    hint?: string;
    /**
     * Operator-facing remediation: env var names, bicep module paths, Key Vault
     * wiring. LOGGED, never returned in a response body. `/api/delta-sharing/*`
     * is reachable by anyone on the internet with zero credentials, so config
     * state is itself information an attacker should not be handed.
     */
    operatorHint?: string;
    /** Short machine reason for the audit row (never contains token material). */
    reason: string;
  };

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
 *
 * ORDER MATTERS: the credential is inspected FIRST. A caller that presents no
 * bearer at all is refused before any configuration is examined, and no
 * configuration-derived text ever reaches an unauthenticated response body —
 * `curl` with no credential must learn nothing about how this estate is wired.
 */
export async function authenticateRecipient(authorizationHeader: string | null | undefined): Promise<SharingAuthResult> {
  // 1. AUTHENTICATE FIRST — is a credential even being presented?
  const presented = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!presented) {
    return { ok: false, status: 401, error: 'missing bearer credential', reason: 'no-credential' };
  }

  // 2. Only now, configuration. Every message below is deliberately generic;
  //    the actionable text goes to `operatorHint`, which the route logs.
  if (!loomSharingEnabled()) {
    return {
      ok: false, status: 503, reason: 'sharing-disabled',
      error: 'Delta Sharing is unavailable in this deployment.',
      operatorHint: 'Sharing is on by default; an admin set LOOM_SHARING_ENABLED=false on the loom-console Container App. Remove the override to re-enable.',
    };
  }
  if (!isLoomSharingConfigured()) {
    return {
      ok: false, status: 503, reason: 'server-not-deployed',
      error: 'Delta Sharing is unavailable in this deployment.',
      operatorHint: 'Deploy platform/fiab/bicep/modules/compute/loom-sharing-app.bicep and set LOOM_SHARING_URL on the Console app. See docs/fiab/delta-sharing-gov.md.',
    };
  }
  const tenantId = sharingOwnerTenantId();
  if (!tenantId) {
    return {
      ok: false, status: 503, reason: 'tenant-unconfigured',
      error: 'Delta Sharing is unavailable in this deployment.',
      operatorHint: 'Set LOOM_ENTRA_TENANT_ID (or AZURE_TENANT_ID) on the Console app so recipient tokens can be pinned to this tenant.',
    };
  }

  const audiences = sharingRecipientAudiences();
  const verified = await verifyEntraBearer(authorizationHeader, {
    audiences,
    tenantId,
    // A recipient reads estate data. An ID token minted for the Console during
    // an ordinary interactive sign-in must never authorize that.
    allowIdTokens: false,
    requiredScopes: sharingRequiredScopes(),
  });
  if (!verified.ok) {
    return verified.status === 503
      ? {
        ok: false, status: 503, reason: 'audience-unconfigured',
        error: 'Delta Sharing is unavailable in this deployment.',
        operatorHint: `${verified.error} Set LOOM_SHARING_AUDIENCE (a dedicated recipient app registration) on the Console app.`,
      }
      : { ok: false, status: 401, error: verified.error, reason: 'invalid-credential' };
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
      ok: false, status: 403, reason: 'not-a-recipient',
      error: 'This identity is not a registered Delta Sharing recipient.',
      // Safe to return: the caller holds a valid token for THIS estate, and the
      // text is product guidance, not infrastructure state.
      hint: 'The share owner registers the recipient in Loom Marketplace → Data shares → Recipients, with this exact Entra object id or application id.',
      // Carried so the deny audit row can attribute the probe.
      operatorHint: `principal=${principal || '(none)'}`,
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
    ok: false, status: 403, reason: 'share-not-granted',
    // Same message whether the share does not exist or exists but is not
    // granted: a distinguishable answer lets a recipient enumerate the estate's
    // whole share namespace one 404-vs-403 at a time.
    error: `Share "${share}" is not shared with this recipient.`,
    hint: 'Ask the share owner to grant it in Loom Marketplace → Data shares → Recipients.',
  };
}
