/**
 * Loom Unity — per-workspace federation FAILURE CLASSIFIER (deploy-integrity R7).
 *
 * Extracted verbatim from unity-catalog-client.ts. It lives beside that client
 * rather than inside it because the classifier is a pure, dependency-free
 * function over a caught error: it calls no Databricks endpoint, holds no
 * credential, and shares no state with the REST surface. Keeping it here lets
 * the R7 reasoning below stay long enough to be USEFUL — the comments are the
 * point of this module, since every defect it encodes was a message that read
 * plausibly and was false.
 *
 * `describeWorkspaceFailure` is re-exported from unity-catalog-client.ts, which
 * remains the canonical import surface for callers.
 */

/** Error `name`s that are, on their own, proof a request was attempted and the
 *  TRANSPORT failed. `FetchTimeoutError` is our own (fetch-with-timeout.ts);
 *  `AbortError` / `TimeoutError` are what an aborted `fetch` surfaces. */
const TRANSPORT_ERROR_NAMES = new Set(['FetchTimeoutError', 'AbortError', 'TimeoutError']);

/** Network errno / undici codes. Node's `fetch` reports these on `err.cause.code`
 *  and stringifies them into the message when a client re-wraps. Anchored on the
 *  CODE TOKENS rather than on prose so a reworded message cannot silently turn a
 *  transport failure into "cause not established" (or the reverse). */
const TRANSPORT_CODE_RE =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|EPROTO|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)|CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/;

/** Prose fallbacks for the shapes that carry no `cause` and no errno token —
 *  Node's bare `TypeError: fetch failed`, and our own timeout wording. */
const TRANSPORT_PROSE_RE = /\bfetch failed\b|\baborted due to timeout\b|\btimed out after\b/i;

/**
 * POSITIVE evidence that the transport failed, or `null` when nothing
 * establishes it. Returns the evidence itself so the caller can NAME it — the
 * whole point of R7 is that the message says what it knows AND how.
 *
 * Deliberately NOT "the error had no status field": that is the inference that
 * turned an honest config gate into a networking red herring.
 */
function transportFailureEvidence(err: {
  name?: string;
  message?: string;
  cause?: { code?: string } | null;
} | null): string | null {
  const name = err?.name;
  if (name === 'FetchTimeoutError') return 'timed out';
  if (name && TRANSPORT_ERROR_NAMES.has(name)) return 'aborted before a response arrived';
  const code = typeof err?.cause?.code === 'string' ? err.cause.code : '';
  if (code && TRANSPORT_CODE_RE.test(code)) return code;
  const msg = err?.message ?? '';
  const m = TRANSPORT_CODE_RE.exec(msg);
  if (m) return m[0];
  if (TRANSPORT_PROSE_RE.test(msg)) return 'transport failure';
  return null;
}

/**
 * Describe a per-workspace federation failure using ONLY what the code
 * established (#3841 / deploy-integrity R7).
 *
 * ORIGINAL DEFECT (#3841): "unreachable" was hard-coded into every row while
 * `e.status` was interpolated beside it, so a denial read "(workspace X
 * unreachable: 403 …)" — self-contradictory, because a status IS proof the
 * server answered. In Gov, where Loom Unity IS the catalog story
 * (cloud-parity.md), that pointed the next investigator at networking while the
 * container was Healthy.
 *
 * SECOND DEFECT (#3924 r3) — why the shape below. Classifying purely on the
 * PRESENCE of a number silently asserted two things never established:
 *
 *   1. that whatever produced the status was THE WORKSPACE. `ossUcAuthHeader()`
 *      runs INSIDE `ucFetch`'s try, so `UcTokenExchangeError` propagates here
 *      from uc-token-exchange.ts — and two of its throw sites (non-JSON body;
 *      no `access_token`) sit AFTER `if (!res.ok)`, carrying a **2xx** from the
 *      TOKEN-EXCHANGE endpoint. It rendered "(workspace X responded 200 —
 *      rejected the request)". The workspace rejected nothing; it was never asked.
 *   2. that the ABSENCE of a status meant the network failed — it may mean no
 *      request was attempted. `OssUcAuthNotConfiguredError` carries a `hint` and
 *      NO `status`, so an honest config gate (default `entra` posture with
 *      LOOM_UNITY_CLIENT_ID / _AUDIENCE / _TOKEN unset) rendered "unreachable —
 *      no HTTP response", discarding the `bicepModule` / `followUp` that fixes it.
 *
 * Both were MORE misleading than the string they replaced: the original was
 * self-flagging, these were confident, plausible and false. Raising a sentence's
 * assertiveness without establishing its provenance is the R7 failure, not a fix.
 *
 * SO: classify by PROVENANCE first, status second. "unreachable" requires
 * POSITIVE transport evidence (`FetchTimeoutError`, an abort, a network errno)
 * rather than being the fallback for "no number found"; a status outside the
 * error classes is never a rejection; and when nothing establishes a cause the
 * copy says so — R7: if the code does not know, the message says it does not.
 *
 * The underlying `e.message` is preserved verbatim in EVERY arm. Callers regex
 * it — `app/api/catalog/metastores/route.ts` tests /account.?admin/i on this
 * string to raise the account-admin gate — so dropping it in any one arm would
 * silently disable that gate for that arm only.
 */
export function describeWorkspaceFailure(host: string, e: unknown): string {
  const err = e as {
    status?: number | string;
    statusCode?: number | string;
    response?: { status?: number | string } | null;
    message?: string;
    name?: string;
    cause?: { code?: string } | null;
    hint?: { missingEnvVar?: string; bicepModule?: string; followUp?: string } | null;
  } | null;
  const msg = err?.message ?? 'error';

  // ARM 1 — a CONFIG GATE (`OssUcAuthNotConfiguredError` / `OssUcNotConfiguredError`).
  // Thrown before anything left the process: neither a rejection nor a fact
  // about reachability. Carry the remediation through rather than discarding it
  // — the operator needs the bicep module, not a networking hunt.
  const hint = err?.hint;
  if (hint && typeof hint.missingEnvVar === 'string' && hint.missingEnvVar) {
    const remedy = [
      hint.bicepModule ? `deploy ${hint.bicepModule}` : '',
      hint.followUp || '',
    ].filter(Boolean).join('; ');
    return `(workspace ${host} not configured — no request was attempted: ${msg}${remedy ? `; ${remedy}` : ''})`;
  }

  // Whose fact is the status below? A token-exchange failure is a fact about the
  // EXCHANGE endpoint and must never be attributed to the workspace.
  const fromExchange = err?.name === 'UcTokenExchangeError';
  const subject = fromExchange
    ? `the Loom Unity token-exchange endpoint for workspace ${host}`
    : `workspace ${host}`;

  // Read the status from whichever property carries it. Azure SDK `RestError`
  // uses `statusCode`, some wrappers keep the whole `response`. Reading only
  // `.status` made those shapes indistinguishable from "no response at all".
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status;
  const status = Number(raw ?? 0);
  const answered = Number.isFinite(status) && status > 0;

  if (answered) {
    if (fromExchange) {
      const verb =
        status < 400 ? `answered ${status} with a response the exchange could not use`
          : status === 401 || status === 403 ? `refused the token exchange with ${status}`
            : `failed the token exchange with ${status}`;
      return `(${subject} ${verb}: ${msg})`;
    }
    const verb =
      status === 401 || status === 403 ? 'denied access'
        : status === 404 ? 'answered 404 (path or metastore not found)'
          : status === 501 ? 'reported an unsupported operation'
            : status >= 500 ? 'returned a server error'
              : status >= 400 ? 'rejected the request'
                // 1xx/2xx/3xx: the response was NOT an error, so the failure was
                // raised after it. Calling this "rejected" invents a refusal.
                : 'a non-error status, so the failure was raised after the response';
    return `(workspace ${host} responded ${status} — ${verb}: ${msg})`;
  }

  // No status. "unreachable" is claimed ONLY on positive transport evidence.
  const evidence = transportFailureEvidence(err);
  if (evidence) return `(${subject} unreachable — no HTTP response (${evidence}): ${msg})`;
  return `(${subject} failed before any HTTP response was recorded — cause not established: ${msg})`;
}
