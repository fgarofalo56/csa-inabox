/**
 * LU-2 / #2679 — the OAuth token-exchange step that makes `authMode=entra`
 * actually work against Loom Unity.
 *
 * WHY THIS EXISTS. Upstream `AuthDecorator` (line 79, identical in v0.5.0 and
 * v0.5.1) rejects any bearer whose `iss` is not the server's own `internal`
 * issuer:
 *
 *     if (!issuer.equals(INTERNAL)) throw new AuthorizationException(...)
 *
 * So a Microsoft Entra access token presented DIRECTLY on
 * `/api/2.1/unity-catalog/*` is answered **403 PERMISSION_DENIED** even when its
 * `aud` matches `server.audiences` byte for byte. Measured, not inferred —
 * receipt in `docs/fiab/security/loom-unity-authz-proof.md` — which lands with
 * #2638 and is NOT on main yet, so do not expect that path to resolve until it
 * merges. The measured table:
 *
 *   | none / malformed                        | 401 |
 *   | Entra bearer, exact audience, direct    | 403 |
 *   | internal token from the exchange        | 200 |
 *
 * The Entra token is therefore a SUBJECT token, not the API credential. It is
 * exchanged once at `/api/1.0/unity-control/auth/tokens` for a server-minted
 * internal token, and that is what rides on catalog calls.
 *
 * WHERE THE SUBJECT TOKEN GOES. The exchange POSTs a real Entra credential to
 * `ossUcBase()`, which reads `LOOM_UNITY_URL` from the environment and nothing
 * else — it is never derived from a request body, path, or header. That property
 * is load-bearing: the recurring defect class in this codebase (#2683, #2691,
 * #2607) is a credential travelling to a caller-chosen address. If anyone ever
 * makes the Loom Unity base URL request-influenced, this call becomes a
 * credential-exfiltration primitive and must gain an allow-list check like
 * `assertAllowedUcHost`.
 */
import { ossUcBase } from '@/lib/azure/uc-backend';

/**
 * Upstream's token-exchange endpoint (unity-CONTROL, not unity-catalog) and the
 * three form params it expects.
 *
 * These four values are byte-identical to the ones the live harness uses against
 * the real image (`apps/loom-unity/tests/authz/authz-e2e.sh`, cases 5 and 7, also
 * landing with #2638) — the harness that produced the measured table above. That
 * is the independent check that this client talks to the right endpoint with the
 * right grant, rather than a plausible-looking guess at the upstream contract.
 */
const EXCHANGE_PATH = '/api/1.0/unity-control/auth/tokens';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

/**
 * How long a minted internal token is reused.
 *
 * The server's response carries NO `exp` claim, so there is no real expiry to
 * honour and we cannot pin the TTL to the token itself. A deliberately short
 * window bounds how long a principal that has since been disabled in the
 * catalog keeps a usable credential; the cost of a miss is one extra POST.
 */
const TTL_MS = 5 * 60_000;

/** How long to wait on the exchange before failing closed. */
const TIMEOUT_MS = 10_000;

interface CacheEntry {
  token: string;
  expiresAt: number;
}

/**
 * Minted internal tokens, keyed by server + subject-token digest.
 *
 * This cache is PROCESS-WIDE, not per-request, and that is deliberate — but it
 * deserves the scrutiny a shared credential store should get. It is not a
 * cross-tenant leak, because the subject is always the **Console's own managed
 * identity**, never an end user's token: every entry represents the same single
 * service principal, so there is no per-user credential here to hand to the
 * wrong caller. Per-user authorization is enforced upstream of this — the BFF
 * audit choke point (LU-3) and the effective-permissions resolver (LU-4) decide
 * what a given human may see before any catalog call is made.
 *
 * If a future change ever makes the subject an END-USER token (on-behalf-of
 * flow), this cache becomes a cross-user credential store and the key must
 * carry the user identity — the subject-token digest alone would still be
 * correct, but `invalidateUcInternalToken` would need to fire on session end.
 */
const cache = new Map<string, CacheEntry>();
/** In-flight exchanges, so a burst of concurrent calls fires ONE POST. */
const inflight = new Map<string, Promise<string>>();

/**
 * Record the exchange on the LU-3 audit trail.
 *
 * The audit choke-point guard requires any file that talks to a Loom Unity
 * address to land a row — "an audit trail with a hole in it is worse than no
 * trail, because it is trusted." This exchange cannot go through `ucFetch`
 * (`ucFetch` calls `ossUcAuthHeader()`, which calls THIS — routing it back
 * through would be circular), so it records directly, exactly as
 * `probe-loom-unity-authz` does in `lib/admin/health-probes.ts`.
 *
 * It is also genuinely worth auditing rather than a box-tick: a burst of failed
 * exchanges is the signature of a disabled/renamed Console principal or a
 * catalog that has forgotten its minted tokens, and a SUCCESSFUL exchange is the
 * moment the Console acquires catalog authority.
 *
 * Never carries token material — `detail` names the endpoint and status only.
 */
async function recordExchange(base: string, status: number, outcome: 'success' | 'failure' | 'denied', detail: string): Promise<void> {
  try {
    const { recordUnityAccess } = await import('@/lib/azure/unity-audit');
    await recordUnityAccess({
      operation: 'auth.token-exchange',
      securableType: 'metastore',
      securableFqn: '*',
      backend: 'oss',
      method: 'POST',
      path: EXCHANGE_PATH,
      status,
      durationMs: 0,
      outcome,
      detail: `${base}${EXCHANGE_PATH}: ${detail}`,
    });
  } catch {
    /* audit is additive telemetry — never fail the exchange on it */
  }
}

/** Thrown when the exchange cannot produce an internal token. The Console fails
 * closed on this rather than retrying with the raw Entra token, which would
 * either 403 opaquely or — far worse — succeed against a server running with
 * authorization disabled and so hide the very misconfiguration it should surface. */
export class UcTokenExchangeError extends Error {
  /** HTTP status from the exchange endpoint, when there was one. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UcTokenExchangeError';
    this.status = status;
  }
}

/**
 * A stable, non-reversible cache key for one subject token.
 *
 * Hashed rather than used verbatim so the raw Entra token never becomes a Map
 * key that could surface in a heap dump keyed by string, or in any future
 * diagnostic that enumerates cache keys. The server base is folded in so a
 * reconfigured `LOOM_UNITY_URL` cannot be served a token minted for the
 * previous server.
 */
async function cacheKey(base: string, subjectToken: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `${base}|${createHash('sha256').update(subjectToken).digest('base64url')}`;
}

/**
 * Drop any cached internal token for this subject.
 *
 * The UC client calls this when the catalog answers 401/403, so a token the
 * server has stopped honouring cannot wedge every subsequent request for the
 * rest of the TTL.
 */
export async function invalidateUcInternalToken(subjectToken: string): Promise<void> {
  let base: string;
  try {
    base = ossUcBase();
  } catch {
    // No configured server => nothing could have been cached under it.
    return;
  }
  const key = await cacheKey(base, subjectToken);
  cache.delete(key);
  inflight.delete(key);
}

/** Test seam: forget every minted token. */
export function resetUcTokenExchangeCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Exchange an Entra access token for a Loom Unity **internal** token.
 *
 * Returns the internal `access_token`. Throws {@link UcTokenExchangeError} on
 * any failure — never returns the subject token as a fallback.
 */
export async function exchangeForInternalUcToken(subjectToken: string): Promise<string> {
  if (!subjectToken) throw new UcTokenExchangeError('No subject token to exchange.');

  const base = ossUcBase();
  const key = await cacheKey(base, subjectToken);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    // Form-encoded per RFC 8693 (the upstream endpoint reads form params).
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      subject_token: subjectToken,
    });

    let res: Response;
    try {
      res = await fetch(`${base}${EXCHANGE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (e) {
      // Network / timeout. The message deliberately carries no token material.
      void recordExchange(base, 0, 'failure', `unreachable: ${(e as Error)?.message || String(e)}`);
      throw new UcTokenExchangeError(
        `Loom Unity token exchange could not reach ${base}${EXCHANGE_PATH}: ${(e as Error)?.message || String(e)}`,
      );
    }

    if (!res.ok) {
      // Upstream error text can be echoed — it is the server's own message, not
      // ours — but cap it so a stray HTML error page cannot flood a log line.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 401/403 is the catalog REFUSING this principal — an auditor's row.
      // Anything else is an availability failure.
      void recordExchange(
        base,
        res.status,
        res.status === 401 || res.status === 403 ? 'denied' : 'failure',
        `rejected (HTTP ${res.status})`,
      );
      throw new UcTokenExchangeError(
        `Loom Unity rejected the token exchange (HTTP ${res.status}). ${detail}`,
        res.status,
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      void recordExchange(base, res.status, 'failure', 'non-JSON response');
      throw new UcTokenExchangeError(
        'Loom Unity returned a non-JSON token-exchange response.',
        res.status,
      );
    }

    const token = (payload as { access_token?: unknown })?.access_token;
    if (typeof token !== 'string' || !token) {
      // A 200 with no usable token is a failure, not a success. Returning
      // undefined here would send an anonymous request downstream.
      void recordExchange(base, res.status, 'failure', 'response carried no access_token');
      throw new UcTokenExchangeError(
        'Loom Unity token-exchange response carried no access_token.',
        res.status,
      );
    }

    cache.set(key, { token, expiresAt: Date.now() + TTL_MS });
    // The moment the Console acquires catalog authority — the row an auditor
    // correlates every subsequent catalog operation back to.
    void recordExchange(base, res.status, 'success', 'internal token minted');
    return token;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}
