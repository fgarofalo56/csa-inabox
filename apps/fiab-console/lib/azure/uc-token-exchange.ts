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
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { logSafe } from '@/lib/util/log-safe';


/**
 * Upstream's token-exchange endpoint (unity-CONTROL, not unity-catalog) and the
 * FOUR form params it requires.
 *
 * These values are byte-identical to the ones the live harness uses against the
 * real image (`apps/loom-unity/tests/authz/authz-e2e.sh`, cases 5 and 7, lines
 * 136-139 and 154-157, also landing with #2638) — the harness that produced the
 * measured table above. That is the independent check that this client talks to
 * the right endpoint with the right grant, rather than a plausible-looking guess
 * at the upstream contract.
 *
 * REQUESTED_TOKEN_TYPE was MISSING here until F1, and its absence made the whole
 * exchange non-functional against a real server — for the Unity path as well as
 * the Iceberg one. Measured live on 2026-08-07, warm, both paths:
 *
 *   HTTP 400 {"error_code":"INVALID_ARGUMENT",
 *             "message":"Unsupported requested token type: null"}
 *
 * The header above this constant used to say "the three form params it expects"
 * in one line and "these four values are byte-identical to the live harness" in
 * the next. The prose had counted the harness correctly; the code implemented one
 * fewer. Nothing caught it, because every unit test doubled the exchange endpoint
 * with a stub that returned an access_token for ANY request body — so the tests
 * modelled the CODE, not the server, and #2679 shipped an exchange that had never
 * completed against a live catalog once. That is why
 * `/api/catalog/unity/capabilities` still hedged with "Not yet confirmed against a
 * live catalog": it never had been.
 *
 * The test that pins this now asserts the request BODY, param by param.
 */
const EXCHANGE_PATH = '/api/1.0/unity-control/auth/tokens';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * How long a minted internal token is reused.
 *
 * The server's response carries NO `exp` claim, so there is no real expiry to
 * honour and we cannot pin the TTL to the token itself. A deliberately short
 * window bounds how long a principal that has since been disabled in the
 * catalog keeps a usable credential; the cost of a miss is one extra POST.
 */
const TTL_MS = 5 * 60_000;

/**
 * How long to wait on the exchange before failing closed.
 *
 * 45s, not 10s (F1). The exchange targets Container Apps that scale to zero, so
 * the FIRST call after any idle period pays a JVM cold start. Measured
 * 2026-08-07 against `iceberg-catalog` at 0 replicas:
 *
 *   502 in 10,865ms — "token exchange could not reach … timed out after 10000ms"
 *
 * — twice in a row, while the revision was still `Activating`. It reached
 * `RunningAtMaxScale` about 60s in, after which the same call answered in 440ms.
 * So a 10s ceiling in front of a ~23s cold start is a GUARANTEED first-call
 * failure, reported with an error that reads like a network fault rather than a
 * cold start.
 *
 * This is a bound, not tolerance: it still fails closed, and it stays well under
 * the Front Door 30s edge timeout FOR THE WARM PATH, which is the only path a
 * user waits on interactively. The real fix for the latency is `minReplicas: 1`
 * on the engines (issue #3110); until that lands, this stops the platform
 * turning a slow start into a false "unreachable".
 */
const TIMEOUT_MS = 45_000;

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

// ─────────────────────────────────────────────────────────────────────────────
// SELF-DIAGNOSIS for the mint → exchange → catalog-call chain (#3197)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single greppable token every step of the catalog-auth chain logs under.
 *
 * WHY THIS EXISTS — measured, not inferred. On 2026-08-10 the live Commercial
 * console answered BOTH `/api/catalog/iceberg/config` and
 * `/api/catalog/iceberg/namespaces` with
 *
 *   {"ok":false,"error":"Iceberg REST Catalog returned HTTP 403",
 *    "code":"iceberg_catalog_error"}
 *
 * while every documented prerequisite was satisfied (the Entra app registration
 * DOES carry `identifierUris`, the catalog auto-bound the Console principal as
 * an ENABLED Unity Catalog user at boot, the `loom` warehouse was created and
 * granted). And `az containerapp logs show -n loom-console` returned ZERO lines
 * matching iceberg / unity / 403 / exchange / token; the catalog logged only its
 * boot sequence. So there was no evidence anywhere for WHICH of the three steps
 * refused — and the three are not distinguishable from the outside:
 *
 *   - the Entra MINT can quietly return nothing, and `icebergAuthHeader()` then
 *     returned `{}` — an ANONYMOUS upstream hop, which a catalog with
 *     authorization enabled answers 403;
 *   - the EXCHANGE can be refused, which surfaces as a different message but was
 *     never logged either;
 *   - the CATALOG CALL can refuse a perfectly-minted internal token.
 *
 * All three produced the same user-visible string. The defect this module now
 * fixes is therefore NOT the 403 — it is that the 403 was not diagnosable
 * (`deploy-integrity.md` R6: every failure self-diagnoses; R7: a message never
 * asserts a cause the code did not establish).
 *
 *   grep '[uc-auth]'                    every step of the chain
 *   grep '[uc-auth] step=mint'          Entra token acquisition
 *   grep '[uc-auth] step=exchange'      POST /api/1.0/unity-control/auth/tokens
 *   grep '[uc-auth] step=catalog-call'  the call that carries the internal token
 *   grep '[uc-auth] step=invalidate'    the 401/403 minted-token eviction
 *
 * NOTHING here ever carries token material. The claim helper below returns a
 * FIXED set of six public identifiers and the log helper takes only explicit
 * fields; `__tests__/uc-auth-diagnostics.test.ts` asserts a token handed to any
 * call site cannot reach the output.
 */
export const UC_AUTH_DIAG = '[uc-auth]';

/** The four separately-attributable steps of the chain. */
export type UcAuthStep = 'mint' | 'exchange' | 'catalog-call' | 'invalidate';

/**
 * The NON-SECRET identity claims of a bearer this process already holds.
 *
 * Every field is a public identifier that appears in the Azure portal: an object
 * id, an application id, an audience, an issuer, a tenant id, an expiry. None of
 * them can be replayed. The signature, the raw token, and every other claim are
 * deliberately NOT carried — this type is the allow-list, not a filter applied
 * after the fact.
 *
 * The pair that actually names an audience misconfiguration is
 * (`audience` requested at the mint site, `tokenAud` observed here): the catalog
 * server derives its accepted audiences from its own client id, so a token whose
 * `aud` is some OTHER app registration is refused with no clue as to why.
 */
export interface SubjectTokenClaims {
  /** `oid` — the principal the token was minted FOR. */
  oid: string;
  /** `appid`/`azp` — the application that minted it. */
  appid: string;
  /** `aud` — what the token is addressed to (comma-joined when it is a list). */
  tokenAud: string;
  /** `iss` — which issuer minted it (v1.0 `sts.windows.net` vs v2.0 differ). */
  iss: string;
  /** `tid` — the tenant. */
  tid: string;
  /** `exp` rendered ISO-8601, so an expired credential is obvious. */
  exp: string;
}

const asStr = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/**
 * Decode the six public claims of a JWT this process already holds.
 *
 * The payload is base64url and unsigned-readable by design; reading it is not a
 * privilege escalation — we minted the token. Returns `undefined` for anything
 * that is not a decodable JWT (a pre-shared opaque token, a truncated string),
 * and NEVER throws: a diagnostic that can break the call it is diagnosing is
 * worse than no diagnostic.
 */
export function describeSubjectToken(token: string): SubjectTokenClaims | undefined {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2 || !parts[1]) return undefined;
    const raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return undefined;
    const aud = raw.aud;
    const expSec = typeof raw.exp === 'number' ? raw.exp : 0;
    return {
      oid: asStr(raw.oid),
      appid: asStr(raw.appid ?? raw.azp),
      tokenAud: Array.isArray(aud) ? aud.map(asStr).join(',') : asStr(aud),
      iss: asStr(raw.iss),
      tid: asStr(raw.tid),
      exp: expSec ? new Date(expSec * 1000).toISOString() : '',
    };
  } catch {
    return undefined;
  }
}

/** Outcomes that are NOT a failure — logged at info, everything else at warn. */
const BENIGN_OUTCOMES = new Set(['ok', 'minted', 'evicted']);

/**
 * Emit ONE structured, greppable line for one step of the chain, and return it
 * (so a test can assert on the exact text rather than on a spy's argument shape).
 *
 * Every interpolated value goes through `logSafe` — the repo's
 * CodeQL-recognisable sanitizer (`lib/util/log-safe.ts`). Upstream error bodies
 * and namespace names are attacker-influencable, and a bare CR/LF in one would
 * forge a whole log record, which is precisely the class
 * `scripts/ci/check-log-injection.mjs` exists to keep closed.
 *
 * Free-text fields are emitted last so the `key=value` head of the line stays
 * machine-parseable even when a body contains spaces.
 */
export function logUcAuthDiag(
  step: UcAuthStep,
  outcome: string,
  fields: Record<string, string | number | undefined>,
): string {
  const parts = [`${UC_AUTH_DIAG} step=${step}`, `outcome=${logSafe(outcome, 40)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue;
    parts.push(`${k}=${logSafe(v, 300)}`);
  }
  const line = parts.join(' ');
  /* eslint-disable no-console */
  if (BENIGN_OUTCOMES.has(outcome)) console.info(line);
  else console.warn(line);
  /* eslint-enable no-console */
  return line;
}

/**
 * Validate an explicit exchange base before a credential is sent to it.
 *
 * The subject token is a real Entra access token; posting it to an
 * attacker-chosen address would hand it over. The module header warned that the
 * day this function accepts a caller-supplied address it needs an allow-list —
 * this is that allow-list.
 *
 * It deliberately does NOT reuse `assertAllowedUcHost`: that one resolves
 * **Databricks workspace** hostnames and would reject the internal
 * `iceberg-catalog.…azurecontainerapps.io` FQDN outright. The meaningful
 * invariant here is narrower and stronger — the base must be one this
 * DEPLOYMENT ITSELF configured, i.e. byte-equal to `LOOM_ICEBERG_CATALOG_URL`
 * or `LOOM_UNITY_URL`. A caller cannot widen that set; only a redeploy can.
 */
function assertExchangeBase(baseOverride: string): string {
  const norm = (v: string | undefined) => (v || '').trim().replace(/\/+$/, '');
  const trimmed = norm(baseOverride);
  if (!trimmed) throw new UcTokenExchangeError('Token-exchange base URL is empty.');

  const configured = [
    norm(process.env.LOOM_ICEBERG_CATALOG_URL),
    norm(process.env.LOOM_UNITY_URL),
  ].filter(Boolean);

  if (!configured.includes(trimmed)) {
    // Names the var to set, never echoes a caller-formatted URL back verbatim
    // into anything that renders.
    throw new UcTokenExchangeError(
      'Refusing to send an Entra token to a token-exchange base this deployment did not '
        + 'configure. The base must equal LOOM_ICEBERG_CATALOG_URL or LOOM_UNITY_URL.',
    );
  }
  return trimmed;
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
 *
 * It also emits the line that separates two states which were previously
 * IDENTICAL from the outside (#3197): `outcome=evicted` proves an exchange had
 * genuinely happened and produced a token that the catalog then refused;
 * `outcome=nothing-cached` proves the refused request carried no exchanged token
 * at all — an anonymous or pre-shared-token hop. Without that line, "the
 * exchange succeeded and the catalog said no" and "the exchange never ran" are
 * the same observation.
 */
export async function invalidateUcInternalToken(subjectToken: string, baseOverride?: string): Promise<void> {
  let base: string;
  if (baseOverride) {
    // Invalidation must not be able to fail closed the way minting does: a
    // rejected base simply means nothing was ever cached under it.
    try {
      base = assertExchangeBase(baseOverride);
    } catch {
      logUcAuthDiag('invalidate', 'skipped', {
        reason: 'the base is not LOOM_ICEBERG_CATALOG_URL or LOOM_UNITY_URL, so nothing could have been cached under it',
      });
      return;
    }
  } else {
    try {
      base = ossUcBase();
    } catch {
      // No configured server => nothing could have been cached under it.
      logUcAuthDiag('invalidate', 'skipped', { reason: 'LOOM_UNITY_URL is not configured' });
      return;
    }
  }
  const key = await cacheKey(base, subjectToken);
  const evicted = cache.delete(key);
  inflight.delete(key);
  const subject = describeSubjectToken(subjectToken);
  logUcAuthDiag('invalidate', evicted ? 'evicted' : 'nothing-cached', {
    base,
    oid: subject?.oid,
    tokenAud: subject?.tokenAud,
  });
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
 *
 * `baseOverride` selects WHICH server mints the token. It defaults to the OSS-UC
 * server (`ossUcBase()`), but the Iceberg REST Catalog is a **separate Container
 * App running the same image with its own database and its own minted-token
 * state** — an internal token minted by `loom-unity` is not honoured by
 * `iceberg-catalog` and vice versa. So the Iceberg client passes its own base
 * (F1). Folding the base into the cache key (see {@link cacheKey}) keeps the two
 * servers' tokens from ever being served to each other.
 *
 * The base is env-derived, never request-influenced — but this function is now
 * reachable with a caller-supplied address, which is exactly the condition the
 * module header warned would turn it into a credential-exfiltration primitive.
 * So the override is validated by `assertExchangeBase` before any token
 * leaves the process. A caller cannot widen that allow-list.
 */
export async function exchangeForInternalUcToken(
  subjectToken: string,
  baseOverride?: string,
): Promise<string> {
  if (!subjectToken) throw new UcTokenExchangeError('No subject token to exchange.');

  const base = baseOverride
    ? assertExchangeBase(baseOverride)
    : ossUcBase();
  const key = await cacheKey(base, subjectToken);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    // The six public claims of the SUBJECT, carried on every line below so a log
    // reader can answer "which principal, addressed to which audience, minted by
    // which app, issued by which endpoint, expiring when" without ever seeing a
    // token. `subject` is `undefined` for an opaque (non-JWT) credential.
    const subject = describeSubjectToken(subjectToken);
    const who = {
      base,
      oid: subject?.oid,
      appid: subject?.appid,
      tokenAud: subject?.tokenAud,
      iss: subject?.iss,
      tid: subject?.tid,
      exp: subject?.exp,
    };

    // Form-encoded per RFC 8693 (the upstream endpoint reads form params).
    // All FOUR params — `requested_token_type` is required; omitting it is
    // answered 400 "Unsupported requested token type: null".
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      subject_token: subjectToken,
    });

    let res: Response;
    try {
      // fetchWithTimeout, not bare fetch (no-bare-server-fetch guard). A raw
      // AbortSignal.timeout would bound this call too, but the shared wrapper is
      // the single audited transport: it reports a timeout-abort distinctly from a
      // caller-abort, and it is the chokepoint the dependency-chaos harness
      // injects into, so a bare fetch here would be invisible to that testing.
      res = await fetchWithTimeout(`${base}${EXCHANGE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        cache: 'no-store',
      }, TIMEOUT_MS);
    } catch (e) {
      // Network / timeout. The message deliberately carries no token material.
      logUcAuthDiag('exchange', 'unreachable', {
        ...who,
        path: EXCHANGE_PATH,
        timeoutMs: TIMEOUT_MS,
        reason: (e as Error)?.message || String(e),
      });
      void recordExchange(base, 0, 'failure', `unreachable: ${(e as Error)?.message || String(e)}`);
      throw new UcTokenExchangeError(
        `Loom Unity token exchange could not reach ${base}${EXCHANGE_PATH}: ${(e as Error)?.message || String(e)}`,
      );
    }

    if (!res.ok) {
      // Upstream error text can be echoed — it is the server's own message, not
      // ours — but cap it so a stray HTML error page cannot flood a log line.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // The line that answers "did the exchange even happen, and what did the
      // server SAY?". The upstream body is the only place the server's own
      // reason (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, an unregistered
      // principal) is ever stated, and until now it was read into an exception
      // message that the BFF replaced with a generic envelope.
      logUcAuthDiag('exchange', res.status === 401 || res.status === 403 ? 'denied' : 'failure', {
        ...who,
        path: EXCHANGE_PATH,
        status: res.status,
        body: detail,
      });
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
      logUcAuthDiag('exchange', 'non-json', { ...who, path: EXCHANGE_PATH, status: res.status });
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
      logUcAuthDiag('exchange', 'no-token', { ...who, path: EXCHANGE_PATH, status: res.status });
      void recordExchange(base, res.status, 'failure', 'response carried no access_token');
      throw new UcTokenExchangeError(
        'Loom Unity token-exchange response carried no access_token.',
        res.status,
      );
    }

    cache.set(key, { token, expiresAt: Date.now() + TTL_MS });
    // Logged as loudly as the failures. "The exchange succeeded" is the fact
    // that turns a downstream 403 from an unattributable mystery into a claim
    // about the CATALOG CALL specifically — and its absence is the fact that
    // says the exchange was never reached at all.
    logUcAuthDiag('exchange', 'minted', { ...who, path: EXCHANGE_PATH, status: res.status, ttlMs: TTL_MS });
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
