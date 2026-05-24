/**
 * MSAL redirect target. Exchanges the auth code for an id_token +
 * access_token, decodes claims, and stores them in the encrypted
 * loom_session cookie. On error, bounces to /?auth_error=<reason>.
 *
 * v1.16: Azure Front Door was confirmed via live network inspection to
 * strip the Set-Cookie header from 307 redirect responses (the cookie
 * was set correctly on the origin response, present in container logs,
 * but absent from the browser-received response headers). Workaround:
 * return a 200 HTML page with the Set-Cookie header AND a meta-refresh
 * / inline-script redirect to '/'. FD preserves Set-Cookie on 2xx.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { setSession } from '@/lib/auth/session';
import type { UserClaims } from '@/lib/auth/msal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Return a 200 HTML response that redirects to the given URL via meta-refresh + JS.
 *  Front Door strips Set-Cookie from 3xx responses, so we use 200 to keep the cookie. */
function htmlRedirect(url: string): NextResponse {
  const body = `<!DOCTYPE html>
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
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const aadError = url.searchParams.get('error');
  if (aadError) {
    console.error('[auth/callback] AAD returned error', aadError, url.searchParams.get('error_description'));
    return htmlRedirect(`/?auth_error=aad_${aadError}`);
  }
  if (!code) {
    return htmlRedirect(`/?auth_error=missing_code`);
  }
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
    return htmlRedirect(`/?auth_error=not_configured`);
  }
  if (!process.env.AZURE_CLIENT_SECRET) {
    console.error('[auth/callback] AZURE_CLIENT_SECRET missing');
    return htmlRedirect(`/?auth_error=no_client_secret`);
  }
  if (!process.env.SESSION_SECRET) {
    console.error('[auth/callback] SESSION_SECRET missing');
    return htmlRedirect(`/?auth_error=no_session_secret`);
  }
  try {
    const client = getMsalClient();
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: `${origin(req)}/auth/callback`,
    });
    if (!result?.account || !result.accessToken) {
      console.error('[auth/callback] no account or accessToken in MSAL response');
      return htmlRedirect(`/?auth_error=no_token`);
    }
    const account = result.account;
    const claims: UserClaims = {
      oid: account.homeAccountId.split('.')[0],
      name: account.name ?? account.username,
      email: account.username,
      upn: account.username,
    };
    const response = htmlRedirect('/');
    setSession(
      {
        oboAssertion: result.accessToken,
        claims,
        exp: Math.floor((result.expiresOn?.getTime() ?? Date.now() + 3600_000) / 1000),
      },
      response,
    );
    console.log('[auth/callback] session set for', claims.upn, 'via 200-HTML-redirect');
    return response;
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown';
    console.error('[auth/callback] exception during token exchange:', msg);
    return htmlRedirect(`/?auth_error=exchange_failed&detail=${encodeURIComponent(msg.slice(0, 80))}`);
  }
}
