/**
 * MSAL redirect target. v1.17: dropped NextResponse entirely — returns
 * a raw Web Response so the Set-Cookie header passes through every
 * layer without Next.js cookie-jar abstraction interference.
 */

import { NextRequest } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { encodeSessionCookie, COOKIE_NAME, MAX_AGE_SECS } from '@/lib/auth/session';
import { saveUserToken } from '@/lib/azure/user-token-store';
import { saveUserSqlToken } from '@/lib/azure/sql-user-token-store';
import { savePbiUserToken } from '@/lib/azure/pbi-user-token-store';
import { armBase, getSqlSuffix, getPbiScope } from '@/lib/azure/cloud-endpoints';
import type { UserClaims } from '@/lib/auth/msal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];
// Delegated Azure Resource Manager scope — used to obtain an ARM-audience token
// for the user so the cross-subscription resource picker can query with the
// user's own RBAC. Captured best-effort after the session token exchange. The
// ARM host is sovereign-cloud aware via armBase() so the scope matches the
// deployment's cloud (Commercial vs Gov).
const ARM_SCOPE = `${armBase()}/user_impersonation`;

/**
 * Best-effort capture of the user's ARM access token. Wrapped so that ANY
 * failure (scope not consented, silent-acquire fails, Cosmos unavailable) is
 * swallowed — login MUST proceed unchanged. The token is never logged and is
 * encrypted at rest by the store.
 */
async function captureUserArmToken(
  client: ReturnType<typeof getMsalClient>,
  account: import('@azure/msal-node').AccountInfo,
  oid: string,
): Promise<void> {
  try {
    const arm = await client.acquireTokenSilent({ account, scopes: [ARM_SCOPE] });
    if (arm?.accessToken) {
      await saveUserToken(oid, arm.accessToken, arm.expiresOn ?? null);
    }
  } catch {
    // ARM scope not consented / not available — picker falls back to UAMI.
  }
}

/**
 * Best-effort capture of the user's Azure SQL access token (F10 — "user's
 * identity" data-access mode for SQL analytics endpoints). Same swallow-all
 * pattern as the ARM capture: login MUST proceed unchanged whether or not the
 * SQL scope was consented. The token is never logged and is encrypted at rest
 * by sql-user-token-store. The SQL audience host is cloud-portable via
 * LOOM_SYNAPSE_SQL_TOKEN_SCOPE (Commercial/GCC vs GCC-High/IL5).
 */
async function captureUserSqlToken(
  client: ReturnType<typeof getMsalClient>,
  account: import('@azure/msal-node').AccountInfo,
  oid: string,
): Promise<void> {
  try {
    const sqlHost = process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || getSqlSuffix();
    const tok = await client.acquireTokenSilent({
      account,
      scopes: [`https://${sqlHost}/user_impersonation`],
    });
    if (tok?.accessToken) {
      await saveUserSqlToken(oid, tok.accessToken, tok.expiresOn ?? null);
    }
  } catch {
    // SQL scope not consented / not available — query routes set to "user's
    // identity" mode surface an honest gate instead of a silent failure.
  }
}

/**
 * Best-effort capture of the user's Power BI delegated access token for the
 * remote Power BI Model Context Protocol server (preview). This is the OBO
 * audience the PBI remote MCP runs under — every call into
 * `https://api.fabric.microsoft.com/v1/mcp/powerbi` is authorized On-Behalf-Of
 * the signed-in user with their own Power BI RBAC.
 *
 * OPT-IN ONLY (no-fabric-dependency.md): this runs SOLELY when
 * `LOOM_POWERBI_MCP_CLIENT_ID` is set — i.e. an operator has explicitly opted
 * into the Power BI remote MCP and registered the Entra app. With the var
 * unset (the day-one default), this is a no-op and Loom's Azure-native
 * semantic-model / report authoring path is unaffected. No Fabric / Power BI
 * host is ever reached on the default path.
 *
 * The three delegated scopes (Dataset.Read.All, MLModel.Execute.All,
 * Workspace.Read.All) are requested on the Power BI audience resource, whose
 * sovereign-correct host comes from `getPbiScope()` (Commercial
 * `analysis.windows.net/powerbi/api`; the GCC / GCC-High / DoD analysis hosts
 * otherwise) — never a hard-coded Commercial literal.
 *
 * Same swallow-all contract as the ARM / SQL captures: ANY failure (var unset,
 * scope not consented, silent-acquire fails, Cosmos unavailable) is swallowed so
 * login proceeds unchanged. When no token is cached, the PBI MCP client surfaces
 * an honest "sign in again / consent Power BI scopes" gate rather than failing
 * mid-call. The token is never logged and is encrypted at rest by the store.
 */
async function captureUserPbiToken(
  client: ReturnType<typeof getMsalClient>,
  account: import('@azure/msal-node').AccountInfo,
  oid: string,
): Promise<void> {
  // Opt-in gate: skip entirely unless the operator wired the PBI remote MCP.
  if (!process.env.LOOM_POWERBI_MCP_CLIENT_ID?.trim()) return;
  try {
    // Power BI audience resource (no `/.default` suffix), sovereign-cloud aware.
    const pbiResource = getPbiScope().replace(/\/\.default$/i, '');
    const tok = await client.acquireTokenSilent({
      account,
      scopes: [
        `${pbiResource}/Dataset.Read.All`,
        `${pbiResource}/MLModel.Execute.All`,
        `${pbiResource}/Workspace.Read.All`,
      ],
    });
    if (tok?.accessToken) {
      await savePbiUserToken(oid, tok.accessToken, tok.expiresOn ?? null);
    }
  } catch {
    // PBI scopes not consented / not available — the remote PBI MCP surfaces an
    // honest config gate. Loom's Azure-native authoring path is the default.
  }
}

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function htmlBody(url: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${url}">
<title>Signing you in…</title>
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0f2a4a;color:#fff;font-family:Segoe UI,system-ui,sans-serif}</style>
</head><body>
<noscript>Click <a href="${url}" style="color:#fff;">here</a> to continue.</noscript>
<div>Signing you in…</div>
<script>window.location.replace(${JSON.stringify(url)});</script>
</body></html>`;
}

function htmlRedirect(url: string, cookieValue?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
  if (cookieValue) {
    headers['set-cookie'] = `${COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${MAX_AGE_SECS}; HttpOnly; Secure; SameSite=Lax`;
  }
  return new Response(htmlBody(url), { status: 200, headers });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const aadError = url.searchParams.get('error');
  if (aadError) {
    console.error('[auth/callback] AAD error', aadError, url.searchParams.get('error_description'));
    return htmlRedirect(`/?auth_error=aad_${aadError}`);
  }
  if (!code) return htmlRedirect(`/?auth_error=missing_code`);
  const msalClientId = process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const msalClientSecret = process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
  if (!msalClientId || !process.env.AZURE_TENANT_ID) return htmlRedirect(`/?auth_error=not_configured`);
  if (!msalClientSecret) return htmlRedirect(`/?auth_error=no_client_secret`);
  if (!process.env.SESSION_SECRET) return htmlRedirect(`/?auth_error=no_session_secret`);
  try {
    const client = getMsalClient();
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: `${origin(req)}/auth/callback`,
    });
    if (!result?.account || !result.accessToken) return htmlRedirect(`/?auth_error=no_token`);
    const account = result.account;
    const claims: UserClaims = {
      oid: account.homeAccountId.split('.')[0],
      name: account.name ?? account.username,
      email: account.username,
      upn: account.username,
    };
    const cookieValue = encodeSessionCookie({
      claims,
      exp: Math.floor((result.expiresOn?.getTime() ?? Date.now() + 3600_000) / 1000),
    });
    console.log('[auth/callback] session encoded for', claims.upn, '— cookie length', cookieValue.length);
    // Additive + non-breaking: capture the user's ARM token for per-user RBAC.
    // Never await-throws into the login path (the helper swallows all errors).
    await captureUserArmToken(client, account, claims.oid);
    // Additive + non-breaking: capture the user's SQL token for "user's
    // identity" data-access mode on SQL analytics endpoints (F10). Same
    // best-effort contract — neither gate blocks the login flow.
    await captureUserSqlToken(client, account, claims.oid);
    // Additive + non-breaking + OPT-IN: capture the user's Power BI delegated
    // token ONLY when the operator has opted into the remote Power BI MCP
    // (LOOM_POWERBI_MCP_CLIENT_ID set). No-op otherwise — the Azure-native
    // semantic-model / report authoring path stays the day-one default. Same
    // best-effort contract — neither gate blocks the login flow.
    await captureUserPbiToken(client, account, claims.oid);
    return htmlRedirect('/', cookieValue);
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown';
    console.error('[auth/callback] exception:', msg);
    return htmlRedirect(`/?auth_error=exchange_failed&detail=${encodeURIComponent(msg.slice(0, 80))}`);
  }
}
