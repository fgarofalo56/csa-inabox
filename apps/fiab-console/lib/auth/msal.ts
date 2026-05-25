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

import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';

function getAuthority(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  const tenantId = process.env.AZURE_TENANT_ID || 'common';
  if (cloud === 'azureusgovernment') {
    return `https://login.microsoftonline.us/${tenantId}`;
  }
  return `https://login.microsoftonline.com/${tenantId}`;
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
