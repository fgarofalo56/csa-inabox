/**
 * MSAL BFF (Backend-for-Frontend) configuration.
 *
 * Pattern: confidential client running server-side. Cookies stay
 * httpOnly + Secure + SameSite=Strict; access tokens never reach
 * the browser. Mirrors the ADR-0014 pattern from the parent csa-inabox
 * repo.
 *
 * Cloud detection: AAD authority differs per boundary.
 *   Commercial / GCC: login.microsoftonline.com
 *   GCC-High / IL5:   login.microsoftonline.us
 */

import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type Configuration,
} from '@azure/msal-node';

function authorityHost(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://login.microsoftonline.us'
    : 'https://login.microsoftonline.com';
}

function getAuthority(tenantId?: string): string {
  const tid = tenantId || process.env.AZURE_TENANT_ID || 'common';
  return `${authorityHost()}/${tid}`;
}

const config: Configuration = {
  auth: {
    // Prefer LOOM_MSAL_CLIENT_ID (separate from AZURE_CLIENT_ID which is
    // the UAMI client id for DefaultAzureCredential). Fall back to
    // AZURE_CLIENT_ID for v1.x compat.
    clientId: process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
    authority: getAuthority(),
    clientSecret: process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level <= 1) console.error('[msal]', message);
      },
      piiLoggingEnabled: false,
      logLevel: 2,
    },
  },
};

let _client: ConfidentialClientApplication | null = null;
export function getMsalClient(): ConfidentialClientApplication {
  if (!_client) _client = new ConfidentialClientApplication(config);
  return _client;
}

/**
 * Public-client application for the OAuth 2.0 device-authorization grant
 * (RFC 8628). Used by `POST /api/auth/cli-session` so the `loom` CLI can
 * sign a human in from a terminal without a browser redirect — the same
 * interactive method `fab auth login` offers.
 *
 * Reuses the SAME `LOOM_MSAL_CLIENT_ID` app registration and the SAME
 * sovereign-cloud authority switch as the confidential client. No client
 * secret is sent (device code is a public-client flow); the Entra app must
 * have "Allow public client flows" enabled — see docs/fiab/MSAL-handoff.md.
 *
 * `tenantId` overrides the env default so a single deployment can mint CLI
 * sessions for a guest's home tenant when needed.
 */
let _publicClient: PublicClientApplication | null = null;
let _publicClientTenant: string | null = null;
export function getMsalPublicClient(tenantId?: string): PublicClientApplication {
  const tid = tenantId || process.env.AZURE_TENANT_ID || 'common';
  if (_publicClient && _publicClientTenant === tid) return _publicClient;
  _publicClient = new PublicClientApplication({
    auth: {
      clientId: process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
      authority: getAuthority(tid),
    },
    system: config.system,
  });
  _publicClientTenant = tid;
  return _publicClient;
}

/**
 * Confidential client bound to an EXPLICIT service-principal credential
 * (client id + secret + tenant) supplied by the caller — used by the
 * non-interactive `loom auth login --service-principal` / CI path. This is
 * NOT the deployment's own app registration; it's whatever SP the operator
 * authenticates as, exactly like `fab auth login --service-principal`.
 */
export function getSpConfidentialClient(
  clientId: string,
  clientSecret: string,
  tenantId: string,
): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: getAuthority(tenantId),
    },
    system: config.system,
  });
}

/** Microsoft Graph base host for the active sovereign cloud (token audience). */
export function graphBase(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://graph.microsoft.us'
    : 'https://graph.microsoft.com';
}

export interface UserClaims {
  oid: string;
  name: string;
  email?: string;
  upn: string;
  groups?: string[];
}

/**
 * Acquire a token on-behalf-of the calling user for the requested
 * downstream scope. The user's session token is exchanged for a new
 * token scoped to (for example) Databricks SQL Warehouse / Synapse /
 * Power BI XMLA / ADX.
 */
export async function acquireOboToken(
  userAssertion: string,
  scopes: string[],
): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenOnBehalfOf({
    oboAssertion: userAssertion,
    scopes,
  });
  if (!result?.accessToken) {
    throw new Error('OBO token acquisition failed');
  }
  return result.accessToken;
}
