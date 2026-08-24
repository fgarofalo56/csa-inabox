/**
 * Transport-failure diagnosis for the /api/items/content-safety/** routes (#3578).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * All four content-safety routes relayed their upstream failure verbatim:
 *
 *     return NextResponse.json({ ok: false, error: e?.message || String(e), … });
 *
 * When the Content Safety data plane cannot be REACHED at all, `e` is undici's
 * `TypeError: fetch failed` — a message that carries no status, no host, no
 * errno and no remediation. That is what the operator saw as the headline
 * failure of the item type's headline action: **"Error fetch failed"** (#3578).
 *
 * The message is not merely unhelpful, it is UNTRUE by the standard in
 * `deploy-integrity.md` R7 ("an error must not state as fact something it did
 * not establish"). "fetch failed" reads as *the moderation call failed*, i.e.
 * as a verdict from the service. In fact the request never reached the service,
 * so there is no verdict at all — the same class of false claim as the
 * 2026-08-05 "the tag does not exist" that was really "I could not reach the
 * registry".
 *
 * THE CAUSE THE OLD CODE THREW AWAY
 * ---------------------------------
 * undici does not put the real failure in `err.message`; it puts it in
 * `err.cause`. A DNS failure is `TypeError: fetch failed` whose `.cause` is
 * `Error: getaddrinfo ENOTFOUND <host>` with `.code === 'ENOTFOUND'`. Reading
 * only `e.message` therefore discards the ONE field that says what happened.
 * {@link diagnoseTransportFailure} walks the whole `cause` chain and reports
 * the first errno it finds.
 *
 * HONESTY CONTRACT (R7)
 * ---------------------
 * - When the errno is known, it is named and explained.
 * - When it is NOT known, `cause` is `null` and the message SAYS the underlying
 *   cause was not reported. It never guesses a reason it did not observe.
 * - A real HTTP response from the service (FoundryError / CsError — a 400, 401,
 *   429, 500 …) is NOT a transport failure: those already carry a status and a
 *   body and are honest as they stand. {@link diagnoseTransportFailure} returns
 *   `null` for them so the caller's existing mapping still runs.
 *
 * The pattern is not invented here — `app/api/monitor/activity/route.ts`
 * already classifies the same undici failure into an actionable message. This
 * module is that idea, single-sourced for the content-safety family and
 * extended with the `cause`-chain walk.
 *
 * NO DEPLOYMENT TOPOLOGY IS DISCLOSED: the remediation names ENV VARS, never a
 * resolved hostname or resource id, so the body is safe for any signed-in
 * caller (these routes are session-gated, not admin-gated).
 */
import { NextResponse } from 'next/server';
import { FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';

/** A transport failure the route could not have gotten a status code from. */
export interface TransportDiagnosis {
  /** Machine-readable discriminator for the editor / Copilot gate registry. */
  code: 'upstream_unreachable' | 'upstream_timeout';
  /** The TRUE, user-facing sentence. Never asserts an unobserved cause. */
  error: string;
  /** Concrete remediation — env vars and network posture, never a raw stack. */
  hint: string;
  /**
   * The low-level errno actually observed on the `cause` chain
   * (`ENOTFOUND`, `ECONNREFUSED`, …), or `null` when the runtime reported
   * none. `null` is load-bearing: the message then says so rather than
   * inventing a reason.
   */
  cause: string | null;
}

/**
 * Node/undici errnos that mean "the request never reached the service".
 * Each maps to a specific, TRUE explanation of what was observed.
 */
const ERRNO_EXPLANATION: Record<string, string> = {
  ENOTFOUND: 'the endpoint hostname did not resolve in DNS',
  EAI_AGAIN: 'a DNS lookup for the endpoint hostname timed out',
  ECONNREFUSED: 'the endpoint refused the TCP connection',
  ECONNRESET: 'the connection to the endpoint was reset before a response arrived',
  ETIMEDOUT: 'the TCP connection to the endpoint timed out',
  EHOSTUNREACH: 'the endpoint host was unreachable from this network',
  ENETUNREACH: 'the endpoint network was unreachable from this container',
  EPIPE: 'the connection closed while the request was still being written',
  UND_ERR_CONNECT_TIMEOUT: 'the connection attempt exceeded its timeout budget',
  UND_ERR_SOCKET: 'the socket closed before a response arrived',
  UND_ERR_HEADERS_TIMEOUT: 'the endpoint accepted the connection but sent no response headers in time',
  UND_ERR_BODY_TIMEOUT: 'the endpoint stopped sending the response body',
  CERT_HAS_EXPIRED: "the endpoint's TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the endpoint presented a self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the endpoint's TLS certificate chain could not be verified",
  SELF_SIGNED_CERT_IN_CHAIN: "the endpoint's TLS chain contains a self-signed certificate",
};

/**
 * Outer-message shapes that mean "no HTTP response was obtained" even when no
 * errno rode along. `fetch failed` is undici's generic wrapper; `aborted` /
 * `terminated` cover a socket torn down mid-flight.
 */
const BARE_TRANSPORT_MESSAGE_RE = /\bfetch failed\b|\bnetwork(?:\s|-)?error\b|\baborted\b|\bterminated\b/i;

/** Walk `e.cause` (undici nests the real failure there) collecting errnos. */
function firstErrno(e: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: any = e;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 8; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const code = typeof cur.code === 'string' ? cur.code : null;
    if (code && code in ERRNO_EXPLANATION) return code;
    // An errno we do not have prose for is still an errno — report it verbatim
    // rather than pretending we saw nothing.
    if (code && /^(?:E[A-Z]{2,}|UND_ERR_[A-Z_]+|[A-Z_]{6,})$/.test(code)) return code;
    cur = cur.cause;
  }
  return null;
}

/** Concatenate the whole `cause` chain's messages so the outer-shape test can
 *  see a failure undici only described on an inner error. */
function messageChain(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: any = e;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (typeof cur === 'object') {
      if (seen.has(cur)) break;
      seen.add(cur);
    }
    if (typeof cur?.message === 'string') parts.push(cur.message);
    else if (typeof cur === 'string') parts.push(cur);
    cur = cur?.cause;
  }
  return parts.join(' | ');
}

/**
 * Classify `e` as a transport failure, or return `null` when it is anything
 * else (including a real HTTP error response from the service, which already
 * carries a status and a body).
 */
export function diagnoseTransportFailure(e: unknown): TransportDiagnosis | null {
  // A timeout the platform imposed itself — the most precise case, and the one
  // where we positively know no response arrived.
  if (e instanceof FetchTimeoutError) {
    return {
      code: 'upstream_timeout',
      cause: 'FetchTimeoutError',
      error:
        'The request to Azure AI Content Safety timed out before the service responded, '
        + 'so no moderation result was produced. This is a connectivity/latency failure, '
        + 'not a moderation verdict.',
      hint:
        'Confirm the Console container app has outbound network access to the Content Safety '
        + 'endpoint (LOOM_CONTENT_SAFETY_ENDPOINT, or the shared Azure AI Services account it '
        + 'falls back to via LOOM_AOAI_ENDPOINT / LOOM_FOUNDRY_ENDPOINT). If the endpoint is '
        + 'behind a private endpoint, check the Private DNS zone and the subnet NSG, then retry.',
    };
  }

  // An error carrying an HTTP status is a RESPONSE, not a transport failure —
  // leave it to the caller's existing status mapping.
  const status = (e as any)?.status;
  if (typeof status === 'number' && status > 0) return null;

  const errno = firstErrno(e);
  const chain = messageChain(e);
  const looksTransport = errno !== null || BARE_TRANSPORT_MESSAGE_RE.test(chain);
  if (!looksTransport) return null;

  const observed = errno && ERRNO_EXPLANATION[errno]
    ? `${ERRNO_EXPLANATION[errno]} (${errno})`
    : errno
      ? `the network layer reported ${errno}`
      : 'the runtime did not report an underlying cause';

  return {
    code: 'upstream_unreachable',
    cause: errno,
    error:
      `Could not reach Azure AI Content Safety — ${observed}. `
      + 'The request never reached the service, so no moderation result was produced: '
      + 'this is a connectivity failure, not a moderation verdict.',
    hint:
      'Confirm LOOM_CONTENT_SAFETY_ENDPOINT points at a deployed Content Safety resource (or '
      + 'that the shared Azure AI Services account it falls back to is set via LOOM_AOAI_ENDPOINT '
      + '/ LOOM_FOUNDRY_ENDPOINT), and that the Console container app has outbound access to it. '
      + 'For a private-endpoint deployment, verify the Private DNS zone record and the subnet NSG. '
      + 'Then retry — this class of failure is often transient.',
  };
}

/**
 * The 502 response for a diagnosed transport failure.
 *
 * 502 (not 503) is deliberate: 503 is already this family's HONEST
 * not-deployed gate (`NotDeployedError` / `CsNotConfiguredError`), and the two
 * states are genuinely different — "not provisioned" is a configuration answer,
 * "provisioned but unreachable" is an infrastructure answer. Keeping 502 also
 * preserves the status the routes already returned on this path, so the editor's
 * existing handling is unchanged; only the BODY becomes true.
 */
export function transportErrorResponse(d: TransportDiagnosis): NextResponse {
  return NextResponse.json(
    { ok: false, error: d.error, hint: d.hint, code: d.code, cause: d.cause, transport: true },
    { status: 502 },
  );
}
