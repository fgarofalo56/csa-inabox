/**
 * MSAL (Microsoft Authentication Library) configuration.
 * Supports both Azure Commercial and Azure Government.
 *
 * CSA-0020 (HIGH, audit AQ-0012): MSAL tokens in sessionStorage are
 * exfiltratable by XSS. The long-term remediation is a Backend-for-Frontend
 * (BFF) pattern where tokens never reach the browser (see ADR-0014 and the
 * `auth_bff` router + `NEXT_PUBLIC_AUTH_MODE=bff` feature flag below).
 *
 * Interim hardening (this file + surrounding surface area):
 *   - Auth-state cookie on the redirect flow: the audit recommendation
 *     (AQ-0012) called for `storeAuthStateInCookie: true`. In
 *     `@azure/msal-browser` v5.x that legacy top-level flag was
 *     **removed** because the library now writes auth request state
 *     (nonce, state, PKCE verifier) to a first-party cookie by default
 *     on every redirect flow — the mitigation the flag used to opt
 *     into is now the MSAL v5 default. Concretely: MSAL 5 sets a
 *     short-lived `msal.<clientId>.<requestId>` cookie during
 *     `loginRedirect` / `acquireTokenRedirect` so Safari ITP and
 *     cross-tab bootstraps do not lose state. No explicit config is
 *     required and no `cache.storeAuthStateInCookie` key exists on
 *     `CacheOptions` anymore. We document this explicitly below so
 *     auditors tracing AQ-0012 land on the right control.
 *   - Strict CSP with per-request nonces + Trusted Types (see
 *     `src/middleware.ts`, `src/services/csp.ts`, `src/pages/_document.tsx`).
 *
 * sessionStorage is retained intentionally while Phase 2 (BFF) is rolled
 * out env-by-env; it narrows the blast radius vs. localStorage (scoped to
 * the tab lifetime) but does NOT eliminate the XSS-exfiltration class.
 * The authoritative mitigation is the BFF flip (ADR-0014 migration plan).
 */

import { Configuration, LogLevel } from '@azure/msal-browser';

const isGov = process.env.NEXT_PUBLIC_AZURE_CLOUD === 'usgovernment';

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID || '',
    authority: isGov
      ? `https://login.microsoftonline.us/${process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID}`
      : `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID}`,
    redirectUri: process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI || 'http://localhost:3000',
    postLogoutRedirectUri: '/',
    knownAuthorities: isGov
      ? ['login.microsoftonline.us']
      : ['login.microsoftonline.com'],
  },
  cache: {
    // CSA-0020: sessionStorage is the interim store while Phase 2 (BFF)
    // rolls out per-environment. See ADR-0014 for the migration plan.
    //
    // NOTE on `storeAuthStateInCookie`: AQ-0012 asked for this flag set
    // to `true`. It was removed from `CacheOptions` in msal-browser v4+
    // because the library now cookies auth request state by default.
    // See the file header above for the full explanation.
    cacheLocation: 'sessionStorage',
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error(message);
            break;
          case LogLevel.Warning:
            console.warn(message);
            break;
          default:
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
  },
};

export const loginRequest = {
  scopes: ['User.Read', 'openid', 'profile', 'email'],
};

export const apiRequest = {
  scopes: [
    `api://${process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID}/access_as_user`,
  ],
};

/**
 * Resolve whether MSAL auth gating should be active.
 *
 * CSA-0122 (HIGH): Previously, the frontend only engaged auth when
 * `NODE_ENV === 'production'`. Every pre-prod environment (staging, preview,
 * PR deploys) therefore shipped unauthenticated and the real MSAL code path
 * was first exercised against production traffic. We now gate on an explicit
 * `NEXT_PUBLIC_AUTH_ENABLED` flag, mirroring the backend `ENVIRONMENT`
 * allow-list enforced by CSA-0001 / CSA-0019.
 *
 * Precedence:
 *   1. Explicit `NEXT_PUBLIC_AUTH_ENABLED` always wins ("true" | "false").
 *   2. If unset, fail closed in production (auth on) and open in dev/test.
 *
 * Note: Next.js inlines `NEXT_PUBLIC_*` values at build time, so this must
 * be evaluated once per process — it does not react to runtime env mutation
 * outside tests that pass an explicit `env` argument.
 */
export function resolveAuthEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = env.NEXT_PUBLIC_AUTH_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV === 'production';
}

/**
 * MSAL auth-mode selector — CSA-0020 BFF migration (ADR-0014).
 *
 * Two supported modes:
 *   - `spa`  (default, Phase 1): The browser talks to Entra ID directly via
 *            `@azure/msal-browser`; tokens land in `sessionStorage`
 *            behind strict CSP + Trusted Types as the interim mitigation.
 *   - `bff`  (Phase 2, opt-in): The browser never holds tokens. The
 *            FastAPI `auth_bff` router (`/auth/login`, `/auth/callback`,
 *            `/auth/me`, `/auth/logout`, `/auth/token`) performs the
 *            Authorization Code + PKCE flow server-side and issues an
 *            httpOnly `csa_sid` session cookie.
 *
 * Precedence:
 *   1. Explicit `NEXT_PUBLIC_AUTH_MODE=spa|bff` always wins.
 *   2. Any other value (typo, empty string) falls back to `spa` so a
 *      misconfiguration does not silently disable SPA auth.
 *   3. Unset → `spa` (matches today's shipped behaviour).
 *
 * This mirrors the backend `AUTH_MODE` setting in `portal.shared.api.config`
 * so frontend and backend stay in lock-step during the staged rollout.
 */
export type AuthMode = 'spa' | 'bff';

export function resolveAuthMode(
  env: NodeJS.ProcessEnv = process.env
): AuthMode {
  const raw = env.NEXT_PUBLIC_AUTH_MODE;
  if (raw === 'bff') return 'bff';
  return 'spa';
}
