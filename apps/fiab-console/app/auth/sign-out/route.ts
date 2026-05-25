/**
 * Sign-out: clears the loom_session cookie and bounces home.
 * Also kicks off AAD federated sign-out. v1.17: raw Web Response.
 */

import { NextRequest } from 'next/server';
import { clearSessionCookieHeader } from '@/lib/auth/session';

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
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': clearSessionCookieHeader(),
    },
  });
}

export const POST = GET;
