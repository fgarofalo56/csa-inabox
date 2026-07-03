/**
 * POST /api/auth/cli-session
 *
 * Mints a real Loom session for the `loom` CLI (npm @csa-loom/cli) so it can
 * call the exact same BFF routes the browser uses, authenticating with the
 * same encrypted `loom_session` cookie value. There is NO separate API-key /
 * bearer auth scheme on the Loom API — every route reads the session cookie —
 * so the CLI obtains that cookie here and replays it as the `Cookie` header.
 *
 * Two flows, matching `fab auth login`:
 *
 *  1. Device code (default, interactive).  Streams NDJSON:
 *       {"type":"device_code", userCode, verificationUri, message, expiresIn}
 *       ... (server polls Entra) ...
 *       {"type":"session", ok:true, cookie, expiresAt, claims}
 *     The first line carries the code the human types at the verification URL;
 *     the final line carries the minted cookie. MSAL handles the polling
 *     server-side via the device-authorization grant (RFC 8628). The Entra app
 *     must allow public-client flows — see docs/fiab/MSAL-handoff.md.
 *
 *  2. Service principal (non-interactive / CI).  Single JSON response:
 *       { ok:true, cookie, expiresAt, claims }
 *     Body: { flow:"service-principal", clientId, clientSecret, tenantId }.
 *     A client-credentials token is acquired and its `oid` (the SP object id)
 *     becomes the tenant partition key — identical model to a user sign-in.
 *
 * Security: this only re-uses the existing session crypto + Entra app; it adds
 * no new secret and no new Azure resource. The cookie is returned in the body
 * (the CLI stores it 0600 at ~/.loom/credentials.json) AND set as a normal
 * Set-Cookie so the same response works from a browser fetch.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getMsalPublicClient,
  getSpConfidentialClient,
  graphBase,
  type UserClaims,
} from '@/lib/auth/msal';
import { encodeSessionCookie, COOKIE_NAME, MAX_AGE_SECS } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOGIN_SCOPES = ['openid', 'profile', 'email', 'User.Read'];

function configured(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!(process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID)) missing.push('LOOM_MSAL_CLIENT_ID');
  if (!process.env.AZURE_TENANT_ID) missing.push('AZURE_TENANT_ID');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  return { ok: missing.length === 0, missing };
}

/** Decode a JWT payload (no signature verification — we only read claims of a
 * token Entra just issued to us over TLS). Returns {} on any parse failure. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sessionExp(): number {
  return Math.floor(Date.now() / 1000) + MAX_AGE_SECS;
}

function setCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SECS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function POST(req: NextRequest) {
  const cfg = configured();
  if (!cfg.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Loom sign-in is not configured on this deployment (missing: ${cfg.missing.join(', ')}).`,
        code: 'not_configured',
        hint: 'See docs/fiab/MSAL-handoff.md for the az ad app + Container App env steps.',
      },
      { status: 503 },
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* device-code default needs no body */
  }
  const flow: string = body?.flow || 'device-code';

  // ---- Service-principal (non-interactive / CI) --------------------------
  if (flow === 'service-principal') {
    const clientId = body?.clientId as string | undefined;
    const clientSecret = body?.clientSecret as string | undefined;
    const tenantId = (body?.tenantId as string | undefined) || process.env.AZURE_TENANT_ID!;
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { ok: false, error: 'clientId and clientSecret are required for service-principal login', code: 'missing_sp_creds' },
        { status: 400 },
      );
    }
    try {
      const cca = getSpConfidentialClient(clientId, clientSecret, tenantId);
      const result = await cca.acquireTokenByClientCredential({ scopes: [`${graphBase()}/.default`] });
      if (!result?.accessToken) {
        return NextResponse.json({ ok: false, error: 'Client-credentials token acquisition returned no token', code: 'no_token' }, { status: 401 });
      }
      const p = decodeJwtPayload(result.accessToken);
      const oid = (p.oid as string) || (p.sub as string) || clientId;
      const name = (p.app_displayname as string) || `service-principal:${clientId}`;
      const claims: UserClaims = { oid, name, upn: clientId, email: undefined };
      const exp = sessionExp();
      const cookie = encodeSessionCookie({ claims, exp });
      return NextResponse.json(
        { ok: true, cookie, expiresAt: exp, claims },
        { status: 200, headers: { 'set-cookie': setCookieHeader(cookie) } },
      );
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || 'service-principal login failed', code: 'sp_login_failed' }, { status: 401 });
    }
  }

  // ---- Device code (default, interactive) --------------------------------
  if (flow !== 'device-code') {
    return NextResponse.json({ ok: false, error: `unknown flow "${flow}"`, code: 'bad_flow' }, { status: 400 });
  }

  const tenantOverride = body?.tenantId as string | undefined;
  const enc = new TextEncoder();
  let capturedCookie: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      try {
        const pca = getMsalPublicClient(tenantOverride);
        const result = await pca.acquireTokenByDeviceCode({
          scopes: LOGIN_SCOPES,
          deviceCodeCallback: (resp) => {
            send({
              type: 'device_code',
              userCode: resp.userCode,
              verificationUri: resp.verificationUri,
              message: resp.message,
              expiresIn: resp.expiresIn,
            });
          },
        });
        if (!result?.account || !result.accessToken) {
          send({ type: 'error', ok: false, error: 'Device-code flow returned no account/token', code: 'no_token' });
          return;
        }
        const account = result.account;
        const claims: UserClaims = {
          oid: account.homeAccountId.split('.')[0],
          // Entra TENANT id (rel-T11) — kept in lock-step with app/auth/callback.
          tid:
            ((account.idTokenClaims as Record<string, unknown> | undefined)?.tid as string) ||
            account.tenantId ||
            account.homeAccountId.split('.')[1] ||
            undefined,
          name: account.name ?? account.username,
          email: account.username,
          upn: account.username,
        };
        const exp = sessionExp();
        capturedCookie = encodeSessionCookie({ claims, exp });
        send({ type: 'session', ok: true, cookie: capturedCookie, expiresAt: exp, claims });
      } catch (e: any) {
        send({ type: 'error', ok: false, error: e?.message || 'device-code login failed', code: 'device_login_failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
