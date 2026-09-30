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
 *     every redemption was refused `invalid_client`, most likely AADSTS7000218,
 *     inferred because MSAL discarded the code; turning public flows on to
 *     "fix" that breaks browser sign-in with AADSTS700025). Whether Entra
 *     accepts the secret on this grant is UNVERIFIED until the live receipt on
 *     #4805; see device-code-grant.ts.
 *
 *     THE MINTED SESSION MUST BELONG TO THE DEPLOYMENT'S TENANT. The `tenantId`
 *     override is accepted only when it IS the deployment tenant
 *     (`AZURE_TENANT_ID`), anything else is 400 `bad_tenant`; and no session is
 *     minted unless the id token's `tid` equals `AZURE_TENANT_ID` and its `iss`
 *     is `<this cloud's login host>/<that tenant>/v2.0`.
 *     The session is stamped `authVia: 'device_code'` (lib/auth/session.ts).
 *
 *     LEAST PRIVILEGE FOR NON-INTERACTIVE SIGN-IN (operator decision 2026-09-30,
 *     lib/auth/device-code-policy.ts): the session lives 1 hour
 *     (`DEVICE_CODE_SESSION_MAX_AGE_SECS`) and is refused on admin surfaces;
 *     starting a sign-in is rate-limited per client IP (the `cli-session` class
 *     of lib/azure/rate-limiter.ts: 5 starts per 10 minutes) and capped at
 *     {@link MAX_OPEN_STREAMS_PER_IP} open streams per IP and
 *     {@link MAX_OPEN_STREAMS_TOTAL} per replica. Both refusals are 429 with
 *     `Retry-After`. The IP is `trustedClientIp`'s — the value a hop Loom
 *     controls wrote, never the caller's own `X-Forwarded-For` claim.
 *
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
  getAuthority,
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
import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';
import { DEVICE_CODE_SESSION_MAX_AGE_SECS } from '@/lib/auth/device-code-policy';
import { clientIp, enforceRateLimitForKey } from '@/lib/azure/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOGIN_SCOPES = ['openid', 'profile', 'email', 'User.Read'];

/** Open device-code streams allowed per client IP at once (operator decision 2026-09-30). */
export const MAX_OPEN_STREAMS_PER_IP = 2;
/** Open device-code streams allowed per replica at once — a key-independent backstop. */
export const MAX_OPEN_STREAMS_TOTAL = 50;
/** `Retry-After` for a stream-cap refusal: a device code lives 15 minutes; a minute is a fair wait. */
const STREAM_CAP_RETRY_AFTER_SECS = 60;
const openStreamsByIp = new Map<string, number>();
let openStreamsTotal = 0;

/** Reserve an open-stream slot for `ip`, or return false when a cap is reached. */
function acquireStreamSlot(ip: string): boolean {
  const mine = openStreamsByIp.get(ip) ?? 0;
  if (mine >= MAX_OPEN_STREAMS_PER_IP || openStreamsTotal >= MAX_OPEN_STREAMS_TOTAL) return false;
  openStreamsByIp.set(ip, mine + 1);
  openStreamsTotal += 1;
  return true;
}

function releaseStreamSlot(ip: string): void {
  const mine = openStreamsByIp.get(ip) ?? 0;
  if (mine <= 1) openStreamsByIp.delete(ip);
  else openStreamsByIp.set(ip, mine - 1);
  openStreamsTotal = Math.max(0, openStreamsTotal - 1);
}

/** Test-only: forget every open-stream reservation. */
export function __resetCliSessionStreams(): void {
  openStreamsByIp.clear();
  openStreamsTotal = 0;
}

/**
 * The shared limiter answers `{ ok:false, error:'rate_limited', retryAfter }`,
 * which the CLI and the VS Code extension can only print as "rate_limited".
 * Re-shape it for this route — same status and headers (`Retry-After` and the
 * `x-ratelimit-*` trio), plus a `message` and `hint` a person can act on. The
 * clients add the wait from `retryAfter`, so the sentence does not repeat it.
 */
async function signInRateLimited(limited: Response): Promise<Response> {
  const prior = (await limited.clone().json().catch(() => ({}))) as { retryAfter?: unknown };
  const headerWait = Number(limited.headers.get('Retry-After'));
  const retryAfter =
    typeof prior.retryAfter === 'number' && prior.retryAfter > 0
      ? prior.retryAfter
      : Number.isFinite(headerWait) && headerWait > 0
        ? headerWait
        : undefined;
  const headers = new Headers();
  for (const [k, v] of limited.headers) {
    if (k === 'retry-after' || k.startsWith('x-ratelimit-')) headers.set(k, v);
  }
  return NextResponse.json(
    {
      ok: false,
      error: 'rate_limited',
      code: 'rate_limited',
      message: 'Too many device-code sign-in attempts from this network.',
      hint: 'Wait, then run the sign-in again. An attempt that is already waiting can still be completed in the browser.',
      retryAfter,
    },
    { status: 429, headers },
  );
}

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
  const homeTenant = process.env.AZURE_TENANT_ID as string; // configured() guarantees it
  // The override is interpolated into the authority URL path, so it must be a
  // tenant-segment shape — never a path, query or host fragment — AND it must be
  // the deployment's own tenant: the minted session must belong to the
  // deployment's tenant, so there is no other tenant worth asking Entra about.
  // (Verified domain names are not accepted: the Console has no cheap, trusted
  // list of them, and the tenant id is always valid.)
  // The SHAPE check is defence in depth and, while the home-tenant comparison
  // stands, an EQUIVALENT MUTANT (arm C13): an override that must equal
  // AZURE_TENANT_ID reaches the same authority path the default already uses,
  // so deleting the shape check changes no outcome. It is kept so the
  // comparison can never be loosened into a URL-injection path by itself.
  if (
    rawTenant !== undefined &&
    (typeof rawTenant !== 'string' ||
      !isValidTenantSegment(rawTenant) ||
      !sameTenantConfirmed(rawTenant, homeTenant))
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "tenantId must be this deployment's Entra tenant id (the one the Console runs in); omit it to use that tenant",
        code: 'bad_tenant',
      },
      { status: 400 },
    );
  }
  const tenantOverride = rawTenant as string | undefined;

  // Starting a sign-in is rate-limited per client IP, then capped by open
  // streams. Only a well-formed start is counted: the 400s above cost Entra nothing.
  const ip = clientIp(req.headers);
  const limited = await enforceRateLimitForKey(`cli-session:${ip}`, 'cli-session');
  if (limited) return signInRateLimited(limited);
  if (!acquireStreamSlot(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Too many device-code sign-ins are already waiting from this address. Finish or cancel one, then try again.',
        code: 'too_many_open_sign_ins',
        message: 'Too many device-code sign-ins are already waiting from this address.',
        hint: 'Finish or cancel a sign-in that is already waiting, then try again.',
        retryAfter: STREAM_CAP_RETRY_AFTER_SECS,
      },
      { status: 429, headers: { 'Retry-After': String(STREAM_CAP_RETRY_AFTER_SECS) } },
    );
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseStreamSlot(ip);
    }
  };

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
        // THE MINTED SESSION MUST BELONG TO THE DEPLOYMENT'S TENANT: the id
        // token's `tid` must be AZURE_TENANT_ID, and its `iss` must be this
        // cloud's login host for that tenant. Either mismatch refuses the mint.
        // THE comparison primitive (lib/auth/tenant-boundary.ts): case-insensitive,
        // and a missing or empty tid on either side refuses.
        if (!sameTenantConfirmed(who.tid, homeTenant)) {
          throw new DeviceCodeGrantError({
            code: 'tenant_mismatch',
            deploymentFault: false,
            message: `The account that signed in belongs to tenant ${who.tid ? `"${who.tid}"` : '(none stated in the id token)'}, not this deployment's tenant. The minted session must belong to the deployment's tenant; sign in with an account from that tenant.`,
          });
        }
        const expectedIss = `${getAuthority(who.tid)}/v2.0`;
        if (who.iss !== expectedIss) {
          throw new DeviceCodeGrantError({
            code: 'id_token_issuer_mismatch',
            deploymentFault: true,
            message: `The id token was issued by ${who.iss ? `"${who.iss}"` : '(no issuer)'}, not "${expectedIss}", the issuer for this deployment's tenant on this cloud (AZURE_CLOUD=${process.env.AZURE_CLOUD || 'AzureCloud'}). Refusing to mint a session from it.`,
          });
        }
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
        // 1 hour, from THIS mint (operator decision 2026-09-30); a refresh never
        // extends it (app/api/auth/refresh/route.ts).
        const exp = Math.floor(Date.now() / 1000) + DEVICE_CODE_SESSION_MAX_AGE_SECS;
        // Marked as a device-code session, which the least-privilege policy in
        // lib/auth/device-code-policy.ts keys on.
        const cookie = encodeSessionCookie({ claims, exp, authVia: 'device_code' });
        send({ type: 'session', ok: true, cookie, expiresAt: exp, claims });
      } catch (e: unknown) {
        const f: DeviceCodeFailure =
          e instanceof DeviceCodeGrantError
            ? e.failure
            : {
                code: 'device_login_failed',
                deploymentFault: false,
                message: `Device-code sign-in failed inside the Console with an unexpected error, which is not a verdict from Entra: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
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
        release();
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      release();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
