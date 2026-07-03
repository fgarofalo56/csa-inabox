/**
 * MSAL sign-in initiator. When a real Entra app-registration credential is
 * configured (LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET + AZURE_TENANT_ID)
 * the confidential client builds an OAuth code URL and 302s the browser to AAD.
 * Until then we return 503 with a clear message so the unblock action is obvious
 * in the network tab.
 *
 * IMPORTANT — the honest gate keys on the MSAL app-registration vars, NOT on
 * AZURE_CLIENT_ID. AZURE_CLIENT_ID is always set to the Console UAMI client id
 * in a deploy (used by DefaultAzureCredential for data-plane calls); that
 * identity is a managed identity and CANNOT perform an interactive user login.
 * If the gate keyed on AZURE_CLIENT_ID it would pass even with no real app
 * registration, and getMsalClient() would fall back to the UAMI with no secret
 * → an opaque login 500 (PRP deploy-readiness gap #2). Keying on
 * LOOM_MSAL_CLIENT_ID + a non-empty LOOM_MSAL_CLIENT_SECRET surfaces the honest
 * 503 with the wire-up remediation instead.
 *
 * Wire-up steps live in docs/fiab/MSAL-handoff.md. The push-button deploy now
 * provisions the app registration + secret automatically — see
 * platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep and
 * scripts/csa-loom/bootstrap-msal-app-reg.sh.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { enforceRateLimitForKey, clientIp } from '@/lib/azure/rate-limiter';
import { armBase, getSqlSuffix } from '@/lib/azure/cloud-endpoints';
import {
  authCsrfEnabled,
  newAuthFlow,
  encodeAuthFlowCookie,
  setAuthFlowCookieHeader,
} from '@/lib/auth/authflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Base login scopes (Graph audience for the session) + the delegated Azure
// Service Management scope. Requesting ARM user_impersonation at consent time
// means that after callback we can silently obtain an ARM-audience token for
// the user and cache it (lib/azure/user-token-store) — enabling per-user RBAC
// in the cross-subscription resource picker. If this scope isn't admin-
// consented, AAD simply omits it and login still succeeds (MSAL won't fail the
// code exchange for the base scopes). The ARM host is sovereign-cloud aware via
// armBase() so the delegated scope matches the deployment's cloud (Commercial
// management.azure.com vs Gov management.usgovcloudapi.net).
const ARM_SCOPE = `${armBase()}/user_impersonation`;
// Delegated Azure SQL Database scope — used to obtain a SQL-audience token for
// the user so a SQL analytics endpoint set to "user's identity" data-access
// mode (F10) can run queries under the caller's own identity. The audience host
// is cloud-portable: LOOM_SYNAPSE_SQL_TOKEN_SCOPE overrides, else the default
// follows getSqlSuffix() so a single image serves every sovereign cloud without
// the operator having to set the env var:
//   Commercial/GCC:  https://database.windows.net/user_impersonation
//   GCC-High/IL5/DoD: https://database.usgovcloudapi.net/user_impersonation
// If this scope isn't admin-consented, AAD simply omits it and login still
// succeeds (MSAL won't fail the code exchange for the base scopes); the query
// route then surfaces an honest "sign in again / grant consent" gate.
const SQL_USER_SCOPE = `https://${process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || getSqlSuffix()}/user_impersonation`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read', ARM_SCOPE, SQL_USER_SCOPE];

function redirectUri(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/auth/callback`;
}

export async function GET(req: NextRequest) {
  // Per-IP anonymous rate limit (rel-T16) — a sign-in initiator is cheap to spam
  // (302 to AAD). Default ON; two-tier (in-memory burst + durable window).
  const limited = await enforceRateLimitForKey(clientIp(req.headers), 'auth');
  if (limited) return limited;

  // Honest gate (PRP deploy-readiness gap #2): require the MSAL app-registration
  // credential the confidential client actually uses for user login. Do NOT key
  // on AZURE_CLIENT_ID — that is the Console UAMI (a managed identity) which
  // cannot perform an interactive sign-in and has no usable client secret.
  const msalClientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  const msalSecret = (process.env.LOOM_MSAL_CLIENT_SECRET || '').trim();
  const tenantId = (process.env.AZURE_TENANT_ID || process.env.LOOM_MSAL_TENANT_ID || '').trim();
  if (!msalClientId || !msalSecret || !tenantId) {
    return NextResponse.json(
      {
        status: 'msal-not-configured',
        missing: [
          msalClientId ? null : 'LOOM_MSAL_CLIENT_ID',
          msalSecret ? null : 'LOOM_MSAL_CLIENT_SECRET',
          tenantId ? null : 'AZURE_TENANT_ID',
        ].filter(Boolean),
        unblock:
          'The push-button deploy provisions the Entra app registration + client ' +
          'secret automatically (loomMsalAppRegEnabled, default on). Re-run the ' +
          'post-deploy bootstrap (csa-loom-post-deploy-bootstrap.yml → "Provision ' +
          'MSAL app registration"), or follow docs/fiab/MSAL-handoff.md for the ' +
          'az ad app create / credential reset + Key Vault steps.',
      },
      { status: 503 },
    );
  }
  // Login-CSRF hardening (rel-T12): mint {state, PKCE verifier + S256 challenge,
  // nonce} and persist {state, verifier, nonce} in the short-lived, single-use
  // `loom_authflow` cookie BEFORE bolting the matching params onto the authorize
  // URL. This is purely ADDITIVE — the client-id, scopes, redirect-URI, authority
  // and prompt are untouched; the params below only extend the existing builder.
  //
  // Atomic + degradation-safe: only when the cookie value can actually be
  // encrypted (SESSION_SECRET present) AND the kill switch is on do we add the
  // params AND set the cookie together. If either is absent the flow falls back
  // byte-for-byte to the prior behavior (no params, no cookie), and the callback's
  // own no_session_secret gate still fires downstream unchanged.
  const flow = authCsrfEnabled() ? newAuthFlow() : null;
  const authFlowCookie = flow ? encodeAuthFlowCookie(flow) : null;
  const client = getMsalClient();
  const url = await client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(req),
    prompt: 'select_account',
    ...(flow && authFlowCookie
      ? { state: flow.state, codeChallenge: flow.challenge, codeChallengeMethod: 'S256' as const, nonce: flow.nonce }
      : {}),
  });
  const res = NextResponse.redirect(url);
  if (flow && authFlowCookie) {
    res.headers.set('set-cookie', setAuthFlowCookieHeader(authFlowCookie));
  }
  return res;
}
