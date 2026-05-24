/**
 * MSAL redirect target. v1.17: dropped NextResponse entirely — returns
 * a raw Web Response so the Set-Cookie header passes through every
 * layer without Next.js cookie-jar abstraction interference.
 */

import { NextRequest } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { encodeSessionCookie, COOKIE_NAME, MAX_AGE_SECS } from '@/lib/auth/session';
import type { UserClaims } from '@/lib/auth/msal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

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
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) return htmlRedirect(`/?auth_error=not_configured`);
  if (!process.env.AZURE_CLIENT_SECRET) return htmlRedirect(`/?auth_error=no_client_secret`);
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
    return htmlRedirect('/', cookieValue);
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown';
    console.error('[auth/callback] exception:', msg);
    return htmlRedirect(`/?auth_error=exchange_failed&detail=${encodeURIComponent(msg.slice(0, 80))}`);
  }
}
