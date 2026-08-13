/**
 * Sign-out: clears the loom_session cookie and bounces home.
 * Also kicks off AAD federated sign-out. v1.17: raw Web Response.
 */

import { NextRequest } from 'next/server';
import { clearSessionCookieHeader } from '@/lib/auth/session';
import { authBreakerEnabled, clearAttemptCookieHeader, requestIsHttps } from '@/lib/auth/auth-breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function logoutUrl(req: NextRequest): string {
  const tenantId = process.env.AZURE_TENANT_ID;
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  const base = cloud === 'azureusgovernment' ? 'https://login.microsoftonline.us' : 'https://login.microsoftonline.com';
  const post = encodeURIComponent(`${origin(req)}/`);
  if (!tenantId) return `${origin(req)}/`;
  return `${base}/${tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`;
}

export async function GET(req: NextRequest) {
  const target = logoutUrl(req);
  const body = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Signing out…</title></head><body><script>window.location.replace(${JSON.stringify(target)});</script></body></html>`;
  // A DELIBERATE sign-out is an unambiguous "this browser is not stuck in a
  // sign-in loop" signal (#3334), so clear the breaker's attempt counter too —
  // otherwise a sign-out/sign-in cycle inside the counting window would carry
  // stale attempts forward. Two Set-Cookie headers, so append rather than a
  // record literal (which would collapse them).
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  headers.append('set-cookie', clearSessionCookieHeader());
  if (authBreakerEnabled()) {
    headers.append('set-cookie', clearAttemptCookieHeader(requestIsHttps(req.headers)));
  }
  return new Response(body, { status: 200, headers });
}

export const POST = GET;
