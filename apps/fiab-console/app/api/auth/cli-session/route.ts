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
 *     the final line carries the minted cookie. The server runs the
 *     device-authorization grant (RFC 8628) as a CONFIDENTIAL client — it
 *     redeems the code with the Console app registration's client secret —
 *     via lib/auth/device-code-grant.ts. The app registration must NOT allow
 *     public-client flows (#4805: MSAL's public client sent no credential, so
 *     every redemption was refused AADSTS7000218; turning public flows on to
 *     "fix" that breaks browser sign-in with AADSTS700025).
 *     On failure the last line is
 *       {"type":"error", ok:false, error, code, aadsts?, correlationId?}
 *     where `error` is the classified, remediating message (it names the
 *     AADSTS code) — the CLI and the VS Code extension surface only `error`.
 *
 *  2. Service principal (non-interactive / CI).  Single JSON response:
 *       { ok:true, cookie, expiresAt, claims }
 *     Body: { flow:"service-principal", clientId, clientSecret, tenantId }.
 *     A client-credentials token is acquired and the session is stamped with
 *     BOTH the SP object id (`oid`) and the Entra tenant (`tid`) — the same
 *     shape a user sign-in produces.
 *
 * TENANCY, PER BRANCH — the two chains are DIFFERENT, and conflating them is
 * what hid #3845 for as long as it lived:
 *
 *   device code        `tid` = id_token `tid` → client_info `utid` (MSAL's homeAccountId[1])
 *   service principal  `tid` = access-token `tid` → the request's `tenantId`
 *
 * The SP branch has no id token and no MSAL account object, so it shares none of
 * the device-code fallbacks; it reads the claim off the access token Entra just
 * issued, and falls back to the tenant the client-credentials grant was made
 * against. Until #3845 it stamped no `tid` at all, and THIS DOCBLOCK SAID THE
 * SP `oid` "becomes the tenant partition key", which made the absence read as a
 * design rather than as the defect it was. It is not the partition key:
 * `tenantScopeId(session)` is `claims.tid ?? claims.oid`, so the `oid` is only
 * reached when `tid` is absent — a state this branch no longer produces, and one
 * every tenant-boundary consumer treats as `unconfirmed`, i.e. a refusal.
 *
 * Security: this only re-uses the existing session crypto + Entra app; it adds
 * no new secret and no new Azure resource. The cookie is returned in the body
 * (the CLI stores it 0600 at ~/.loom/credentials.json) AND set as a normal
 * Set-Cookie so the same response works from a browser fetch.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getSpConfidentialClient,
  graphBase,
  type UserClaims,
} from '@/lib/auth/msal';
import { encodeSessionCookie, COOKIE_NAME, MAX_AGE_SECS } from '@/lib/auth/session';
import {
  runDeviceCodeGrant,
  isValidTenantSegment,
  DeviceCodeGrantError,
  type DeviceCodeFailure,
} from '@/lib/auth/device-code-grant';
import { logSafe } from '@/lib/util/log-safe';

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
        hint: 'Run the post-deploy bootstrap (.github/workflows/csa-loom-post-deploy-bootstrap.yml), which registers the Console app and wires these onto the Console.',
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
      // #3845 — STAMP THE ENTRA TENANT, exactly as the device-code branch below
      // does. This branch used to mint `{ oid, name, upn, email }` with NO `tid`
      // while `tenantId` was in scope three lines up, which made this route the
      // LIVE GENERATOR of tid-less sessions: every consumer of the tenant
      // boundary (`resolveWorkspaceAccessByOid` step 4 / step 6,
      // `listAccessibleWorkspaces`, `resolveWorkspaceRole`) treats an absent
      // caller `tid` as `unconfirmed`, so a session minted here could never be
      // POSITIVELY matched to a tenant — and under the pre-#3840 truthiness
      // guard it was not FILTERED either, it simply fell through. Fixing the
      // consumers without fixing this would leave the generator refilling them.
      //
      // THE TOKEN'S OWN `tid` IS PREFERRED over the request's `tenantId`,
      // because it is what Entra asserted about the principal that actually
      // authenticated rather than what the caller asked for. `tenantId` is the
      // documented fallback and is not forgeable in a way that matters here:
      // the client-credentials grant above only succeeds if the caller genuinely
      // holds that SP's secret in that tenant. `undefined` remains reachable
      // (a token with neither) and stays an HONEST absence — `UserClaims.tid`
      // is optional by design, and per `tenant-boundary.ts` an absent tid is
      // `unconfirmed`, which is a refusal, never a grant.
      const tid = (p.tid as string) || tenantId || undefined;
      const claims: UserClaims = { oid, tid, name, upn: clientId, email: undefined };
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

  const rawTenant: unknown = body?.tenantId || undefined;
  // The override is interpolated into the authority URL path, so only a tenant
  // GUID or domain shape is accepted — never a path, query or host fragment.
  if (rawTenant !== undefined && (typeof rawTenant !== 'string' || !isValidTenantSegment(rawTenant))) {
    return NextResponse.json(
      { ok: false, error: 'tenantId must be an Entra tenant id or verified domain name', code: 'bad_tenant' },
      { status: 400 },
    );
  }
  const tenantOverride = rawTenant as string | undefined;
  const enc = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (!cancelled) controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      try {
        const who = await runDeviceCodeGrant({
          scopes: LOGIN_SCOPES,
          tenantId: tenantOverride,
          isCancelled: () => cancelled,
          onPrompt: (p) =>
            send({
              type: 'device_code',
              userCode: p.userCode,
              verificationUri: p.verificationUri,
              message: p.message,
              expiresIn: p.expiresIn,
            }),
        });
        // Entra TENANT id (rel-T11) — kept in lock-step with app/auth/callback:
        // `oid` is client_info.uid (MSAL's homeAccountId[0]); `tid` is the id
        // token's tid, falling back to client_info.utid.
        const claims: UserClaims = {
          oid: who.oid,
          tid: who.tid,
          name: who.name || who.username,
          email: who.username,
          upn: who.username,
        };
        const exp = sessionExp();
        const cookie = encodeSessionCookie({ claims, exp });
        send({ type: 'session', ok: true, cookie, expiresAt: exp, claims });
      } catch (e: unknown) {
        const f: DeviceCodeFailure =
          e instanceof DeviceCodeGrantError
            ? e.failure
            : {
                code: 'device_login_failed',
                deploymentFault: false,
                message: `Device-code sign-in failed inside the Console before Entra answered: ${e instanceof Error ? e.message : String(e)}`,
              };
        // Code, AADSTS and correlation id — never a token, device code or user code.
        console.error(
          '[auth/cli-session] device-code failed:',
          logSafe(f.code),
          logSafe(f.aadsts ?? '-'),
          logSafe(f.correlationId ?? '-'),
          logSafe(f.message),
        );
        send({ type: 'error', ok: false, error: f.message, code: f.code, aadsts: f.aadsts, correlationId: f.correlationId });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
