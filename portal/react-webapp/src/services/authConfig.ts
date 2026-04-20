/**
 * MSAL (Microsoft Authentication Library) configuration.
 * Supports both Azure Commercial and Azure Government.
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
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
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
