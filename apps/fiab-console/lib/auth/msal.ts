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
import { getPbiScope } from '@/lib/azure/cloud-endpoints';

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
 * downstream scope. The user's session token (a raw user assertion) is
 * exchanged for a new token scoped to (for example) Databricks SQL Warehouse /
 * Synapse / Power BI XMLA / ADX.
 *
 * POWER BI REMOTE MCP — which path mints the token:
 *   - DEFAULT Console path: it does NOT call this OBO exchange. The signed-in
 *     user's Power BI token is minted at login via
 *     `acquireTokenSilent({ account, scopes: pbiOboScopes() })` and cached
 *     (encrypted at rest) in the Cosmos pbi-user-token-store — the exact mirror
 *     of the SQL user-token store. The chat orchestrator / MCP client then reads
 *     that cached token back per-call (the session cookie holds claims only, not
 *     a raw assertion, so silent-then-cache is the only workable path there).
 *   - FALLBACK path: `acquireOboToken(userAssertion, pbiOboScopes())` — used
 *     only where a RAW user assertion is actually available (e.g. the
 *     internal-token MAF callback path), exchanging it on_behalf_of for the same
 *     Power BI delegated scopes.
 * Both are OPT-IN only (gated on LOOM_POWERBI_MCP_CLIENT_ID + the Power BI
 * tenant setting) and never run on a default code path — Loom's Azure-native
 * semantic-model / report authoring stays the default (no-fabric-dependency).
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

// ---------------------------------------------------------------------------
// Power BI remote-MCP delegated (OBO) scopes — opt-in only
// ---------------------------------------------------------------------------

/**
 * The three READ-ONLY Power BI delegated permissions the opt-in Power BI remote
 * MCP server (https://api.fabric.microsoft.com/v1/mcp/powerbi) requests
 * on-behalf-of the signed-in user: schema-aware QUERY of semantic models +
 * Copilot-powered DAX generation, all under the user's own RBAC. These are the
 * UNPREFIXED scope names; `pbiOboScopes()` prepends the sovereign-cloud-aware
 * resource audience. Kept in lock-step with `REMOTE_BUILTIN_MCP.delegatedScopes`
 * (lib/mcp/catalog.ts) — change both together.
 */
const PBI_DELEGATED_SCOPES = [
  'Dataset.Read.All',
  'MLModel.Execute.All',
  'Workspace.Read.All',
] as const;

/**
 * Resource-prefixed, sovereign-cloud-aware delegated scopes for the Power BI
 * remote MCP OBO exchange. On Commercial this is, e.g.:
 *   ['https://analysis.windows.net/powerbi/api/Dataset.Read.All',
 *    'https://analysis.windows.net/powerbi/api/MLModel.Execute.All',
 *    'https://analysis.windows.net/powerbi/api/Workspace.Read.All']
 * and on GCC / GCC-High / DoD the audience shifts to the matching
 * `analysis.usgovcloudapi.net` / `high.…` / `mil.…` host. The audience is
 * derived from the canonical gov-aware `getPbiScope()` (its `/.default` suffix
 * stripped) so the `analysis.* powerbi/api` host literal lives in exactly ONE
 * place (cloud-endpoints.ts) and every sovereign boundary resolves correctly.
 *
 * Single source of truth for the Power BI OBO scope strings so callers
 * (app/auth/callback's `acquireTokenSilent`, and the `acquireOboToken`
 * assertion-fallback above) don't duplicate them. OPT-IN only — invoked solely
 * when the Power BI remote MCP has been opted into (LOOM_POWERBI_MCP_CLIENT_ID +
 * the Power BI tenant setting); never on a default code path
 * (no-fabric-dependency).
 */
export function pbiOboScopes(): string[] {
  // getPbiScope() → 'https://<analysis-host>/powerbi/api/.default'; strip the
  // trailing '/.default' to recover the bare resource audience to prefix.
  const resource = getPbiScope().replace(/\/\.default$/i, '');
  return PBI_DELEGATED_SCOPES.map((scope) => `${resource}/${scope}`);
}
