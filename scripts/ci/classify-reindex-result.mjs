#!/usr/bin/env node
/**
 * Classify the result of the `loom-docs` reindex trigger that
 * copilot-quality-evals.yml (and the post-deploy bootstrap) fire BEFORE the
 * Copilot quality-eval run — issue #2929, the index-FRESHNESS half.
 *
 * WHY A SEPARATE, TESTED SCRIPT
 * -----------------------------
 * The reindex step's whole job is to make the eval self-heal on a stale index:
 * if the index is not refreshed, the gate measures the wrong corpus and can go
 * green having measured nothing (the repo's dominant defect class — see
 * scripts/ci/check-annotation-teeth.mjs). So the pass/warn/FAIL decision must be
 * fail-LOUD and it must be UNIT-TESTABLE, not buried in a bash `case` nobody
 * exercises. This is the pure decision core; the workflow does the curl and
 * feeds the HTTP code + response body in.
 *
 * THE CONTRACT (POST /api/help-copilot/reindex, see apps/fiab-console/app/api/
 * help-copilot/reindex/route.ts + lib/azure/loom-docs-index.ts::reindex):
 *   - 202 { ok:true, accepted:true, jobId, ... } — the rebuild was ACCEPTED and
 *     runs in the background (the route went async in #2929 so no Front Door
 *     origin timeout sits on the critical path). NOT a completion: the caller
 *     MUST poll GET /api/help-copilot/reindex and feed the terminal state back
 *     through `classifyReindexPoll` below.
 *   - 200 { ok:true, backend, totalChunks, uploaded, ... } — refreshed inline
 *     (pre-#2929 consoles, still accepted). When LOOM_AI_SEARCH_SERVICE is
 *     UNSET the route STILL succeeds against the Cosmos fallback
 *     (backend:'cosmos') and warns — that is the honest "not configured" the
 *     eval tolerates (it then measures the Cosmos path).
 *   - 401 — no session AND LOOM_INTERNAL_TOKEN missing/mismatched. The reindex
 *     did NOT run: fail loud, the eval would measure a stale index.
 *   - 502 { ok:false, error } — a real reindex failure (upload failed / empty
 *     corpus). Fail loud.
 *   - curl connect failure (code 000) — the console is unreachable over Front
 *     Door. TOLERATED with a loud warning: the eval itself reaches the console
 *     over the CAE-internal network (LOOM_EVAL_PROBE_URL), not Front Door, so a
 *     transient public-edge blip must not red the quality gate.
 *
 * 2026-08-04 — WHY `no corpus chunks` IS NO LONGER AN HONEST GATE.
 * The eval run 30937670794 got `HTTP 502 {"ok":false,"backend":"none",
 * "totalChunks":0,…,"error":"No corpus chunks discovered — check that docs/ and
 * PRPs/ exist relative to cwd"}` back in ~160 MILLISECONDS. That is not a
 * timeout and not "infra not provisioned": the console image simply shipped
 * WITHOUT its staged Copilot corpus (only full-app-deploy-commercial.yml ran
 * stage-copilot-corpus.sh, so the routine builders produced images whose
 * `copilot-corpus/` held just `.gitkeep`). The corpus being absent is the whole
 * failure — the index cannot be refreshed at all — yet `no corpus chunks` sat
 * in NOT_CONFIGURED_RE, so this classifier called it an honest gate, exited 0,
 * and the eval measured a STALE index and reported hit-rates as if fresh. A
 * classifier that tolerates the one failure it exists to catch measures
 * nothing. Empty corpus is now a hard FAIL.
 *
 * verdict → exit code:  ok | tolerate → 0 ;  fail → 1.
 *
 * Usage (workflow):
 *   # the POST
 *   HTTP_CODE=$CODE RESP_BODY="$(cat body)" node scripts/ci/classify-reindex-result.mjs
 *   # the poll verdict (after polling GET to a terminal state)
 *   MODE=poll POLL_OUTCOME=fresh|failed|timeout|unreachable POLL_BODY="$(cat get.json)" \
 *     POLL_WAITED_S=$SECS node scripts/ci/classify-reindex-result.mjs
 */
import { pathToFileURL } from 'node:url';

/**
 * Honest infra-gate signals — a "not configured / not provisioned" body.
 *
 * DELIBERATELY EXCLUDES the empty-corpus message (see the 2026-08-04 note in
 * the header). Adding `no corpus chunks` back here re-opens the exact hole that
 * let a broken reindex pass: the classifier's own test suite pins that
 * ("empty corpus (502) is a REAL failure, never an honest gate").
 */
const NOT_CONFIGURED_RE =
  /not configured|not provisioned|not set|no ai search|LOOM_AI_SEARCH/i;

/** The empty-corpus failure, matched explicitly so it can never be tolerated. */
const NO_CORPUS_RE = /no corpus chunks/i;

/**
 * Status codes an EDGE (Front Door) or ingress emits on the origin's behalf.
 * A body carrying one of these tells us about the path, not about the console.
 *
 * 500 is excluded on purpose: it is what the app itself returns, and treating it
 * as indeterminate would hand the console a way to fail silently.
 */
const GATEWAY_CODES = new Set([502, 503, 504]);

/**
 * @param {{ code: number|string, body?: string }} input
 * @returns {{ verdict: 'ok'|'accepted'|'tolerate'|'fail', level: 'notice'|'warning'|'error', message: string }}
 */
export function classifyReindexResult({ code, body }) {
  const n = Number.parseInt(String(code), 10);
  const raw = typeof body === 'string' ? body : '';
  let parsed = null;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  // --- 202: ACCEPTED. The rebuild runs in the background — poll for the -----
  //     terminal state. Verdict 'accepted' so a caller that forgets to poll
  //     cannot mistake this for a completed refresh.
  if (n === 202) {
    if (parsed && parsed.ok === false) {
      return {
        verdict: 'fail',
        level: 'error',
        message: `reindex returned HTTP 202 but ok:false — ${summarize(parsed)}. A 202 must carry ok:true; treating as a failed refresh.`,
      };
    }
    const already = parsed?.alreadyRunning ? ' (a run was already in flight)' : '';
    return {
      verdict: 'accepted',
      level: 'notice',
      message:
        `loom-docs reindex ACCEPTED (HTTP 202, job=${parsed?.jobId ?? 'unknown'})${already}. ` +
        'NOT yet complete — poll GET /api/help-copilot/reindex until freshness.state === "fresh".',
    };
  }

  // --- 2xx: the reindex endpoint answered. Success means ok:true. ------------
  if (Number.isFinite(n) && n >= 200 && n < 300) {
    if (parsed && parsed.ok === false) {
      return {
        verdict: 'fail',
        level: 'error',
        message: `reindex returned HTTP ${n} but ok:false — ${summarize(parsed)}. A 2xx must carry ok:true; treating as a failed refresh.`,
      };
    }
    const be = parsed?.backend ?? 'unknown';
    const cosmosGate =
      be === 'cosmos' &&
      Array.isArray(parsed?.warnings) &&
      parsed.warnings.some((w) => NOT_CONFIGURED_RE.test(String(w)));
    const note = cosmosGate
      ? ' (AI Search not configured — honest gate; the eval measures the Cosmos fallback path)'
      : '';
    return {
      verdict: 'ok',
      level: 'notice',
      message: `loom-docs reindex OK — ${summarize(parsed)}${note}.`,
    };
  }

  // --- connect failure (curl printed 000): unreachable over Front Door. ------
  if (n === 0 || String(code) === '000') {
    return {
      verdict: 'tolerate',
      level: 'warning',
      message:
        'loom-docs reindex could not reach the console over Front Door (curl 000). ' +
        'TRANSIENT — the eval run reaches the console over the CAE-internal network ' +
        '(LOOM_EVAL_PROBE_URL), not Front Door, so it proceeds against the last-indexed corpus.',
    };
  }

  // --- 401/403: the reindex did NOT run. This is the exact stale-index bug. --
  if (n === 401 || n === 403) {
    return {
      verdict: 'fail',
      level: 'error',
      message:
        `reindex rejected (HTTP ${n}). LOOM_INTERNAL_TOKEN is missing or does not match the console ` +
        'env (the same token the copilot-evaluator + memory-consolidate use). The index was NOT ' +
        'refreshed, so the eval would measure a STALE index — failing loud.',
    };
  }

  // --- 5xx: real failure, UNLESS the body is an honest not-configured gate. --
  if (Number.isFinite(n) && n >= 500) {
    // The empty-corpus 502 is checked FIRST and unconditionally: it is the one
    // failure this classifier exists to catch, and it must never fall through
    // to the honest-gate branch (see the 2026-08-04 note in the header).
    if (NO_CORPUS_RE.test(raw)) {
      return {
        verdict: 'fail',
        level: 'error',
        message:
          `reindex found NO CORPUS (HTTP ${n}): ${summarize(parsed) || firstLine(raw)}. ` +
          'The console image is missing its staged Copilot corpus — the workflow that built it did ' +
          'not run scripts/csa-loom/stage-copilot-corpus.sh, so copilot-corpus/ holds only .gitkeep. ' +
          'The index was NOT refreshed and CANNOT be — failing loud rather than measuring a stale index.',
      };
    }
    if (NOT_CONFIGURED_RE.test(raw)) {
      return {
        verdict: 'tolerate',
        level: 'warning',
        message: `reindex honest-gated (HTTP ${n}): ${summarize(parsed) || firstLine(raw)}. Not a failure — infra not provisioned; the eval measures whatever backend is available.`,
      };
    }
    // A GATEWAY 5xx with no application body settles NOTHING, so do not pretend
    // it does — measure instead (#3396). Front Door / ACA ingress answered on
    // the console's behalf, which means we do not know whether the POST ever
    // reached a replica. Both readings are live:
    //   - it reached one  -> the job IS running and the index will converge;
    //   - it did not      -> nothing started and the index stays stale.
    // Failing here asserts the second; tolerating asserts the first. Neither is
    // established, so this returns 'poll' and lets the DURABLE freshness signal
    // decide. That signal answers the real question — `state:'fresh'` means "the
    // indexed corpus matches the staged docs", a claim about CONTENT, not about
    // whether a job ran — so a converged index passes honestly, and one that
    // never converges times out and fails honestly (classifyReindexPoll).
    //
    // Deliberately NARROW: gateway status codes only, and only when the body is
    // NOT parseable application JSON. The console's own 5xx (the empty-corpus
    // 502 above, or any JSON error) still fails loud on the spot — it answered,
    // so its answer is the measurement.
    if (GATEWAY_CODES.has(n) && !parsed) {
      return {
        verdict: 'poll',
        level: 'warning',
        message:
          `reindex POST hit a GATEWAY ${n} with no application body (${firstLine(raw) || '(empty body)'}). ` +
          'The edge answered for the console, so whether the POST reached a replica is UNKNOWN — ' +
          'not asserting either way. Polling the durable corpus-freshness signal to settle it; ' +
          'if the index does not converge, the poll times out and this step fails.',
      };
    }
    return {
      verdict: 'fail',
      level: 'error',
      message: `reindex failed (HTTP ${n}): ${summarize(parsed) || firstLine(raw)}. The index was NOT refreshed — failing loud.`,
    };
  }

  // --- anything else (404, other 4xx, un-parseable code): fail loud. ---------
  return {
    verdict: 'fail',
    level: 'error',
    message: `reindex returned an unexpected HTTP ${code}: ${firstLine(raw) || '(empty body)'}. The index was NOT confirmed refreshed — failing loud.`,
  };
}

/**
 * Classify the POLL verdict after a 202 — i.e. "did the accepted rebuild
 * actually finish?".
 *
 * This is the second half of the same decision, deliberately in the SAME script
 * (and the same test suite) rather than a second bash `case` in the workflow:
 * splitting the verdict across two code paths is how one of them ends up
 * untested and lax.
 *
 * `outcome` is what the poll loop observed:
 *   - 'fresh'       — GET reported `freshness.state === 'fresh'`. The DURABLE,
 *                     cross-replica signal (the persisted corpus manifest), so
 *                     it holds no matter which replica answered. PASS.
 *   - 'failed'      — a replica reported `job.state === 'failed'`. FAIL.
 *   - 'timeout'     — the cap elapsed without a terminal state. A TIMEOUT IS A
 *                     REFUSAL, NOT A PASS: proceeding would measure exactly the
 *                     stale index this step exists to prevent. FAIL.
 *   - 'unreachable' — every poll failed to connect (curl 000). Tolerated for
 *                     the same reason the POST's 000 is: the eval reaches the
 *                     console over the CAE-internal network, not Front Door.
 *
 * @param {{ outcome: string, body?: string, waitedSeconds?: number|string }} input
 * @returns {{ verdict: 'ok'|'tolerate'|'fail', level: 'notice'|'warning'|'error', message: string }}
 */
export function classifyReindexPoll({ outcome, body, waitedSeconds }) {
  const raw = typeof body === 'string' ? body : '';
  let parsed = null;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const waited = Number.isFinite(Number(waitedSeconds)) ? `${Number(waitedSeconds)}s` : 'the cap';
  const state = parsed?.freshness?.state ?? 'unknown';
  const job = parsed?.job?.state ?? 'unknown';
  const chunks = parsed?.freshness?.indexedChunkCount;
  const detail =
    `freshness=${state} job=${job}` +
    (Number.isFinite(chunks) ? ` indexedChunks=${chunks}` : '') +
    (parsed?.backend ? ` backend=${parsed.backend}` : '');

  switch (String(outcome)) {
    case 'fresh':
      return {
        verdict: 'ok',
        level: 'notice',
        message: `loom-docs reindex COMPLETE — ${detail}. The eval measures a FRESH index.`,
      };
    case 'failed':
      return {
        verdict: 'fail',
        level: 'error',
        message:
          `loom-docs reindex FAILED — ${detail}` +
          (parsed?.job?.error ? ` error=${firstLine(String(parsed.job.error))}` : '') +
          '. The index was NOT refreshed — failing loud rather than measuring a stale index.',
      };
    case 'timeout':
      return {
        verdict: 'fail',
        level: 'error',
        message:
          `loom-docs reindex did NOT reach a fresh state within ${waited} — ${detail}. ` +
          'A timeout is a REFUSAL, not a pass: proceeding would measure a STALE index, which is the ' +
          'exact failure this step exists to prevent. Failing loud.',
      };
    case 'unreachable':
      return {
        verdict: 'tolerate',
        level: 'warning',
        message:
          'loom-docs reindex poll could not reach the console over Front Door (curl 000 on every attempt). ' +
          'TRANSIENT — the eval run reaches the console over the CAE-internal network (LOOM_EVAL_PROBE_URL), ' +
          'not Front Door, so it proceeds against the last-indexed corpus.',
      };
    default:
      return {
        verdict: 'fail',
        level: 'error',
        message: `unknown reindex poll outcome '${outcome}' — ${detail}. Refusing to assume success; failing loud.`,
      };
  }
}

/** Compact one-line summary of a ReindexResult-shaped body. */
function summarize(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const bits = [];
  if (parsed.backend) bits.push(`backend=${parsed.backend}`);
  if (parsed.mode) bits.push(`mode=${parsed.mode}`);
  if (Number.isFinite(parsed.totalChunks)) bits.push(`chunks=${parsed.totalChunks}`);
  if (Number.isFinite(parsed.uploaded)) bits.push(`uploaded=${parsed.uploaded}`);
  if (parsed.error) bits.push(`error=${firstLine(String(parsed.error))}`);
  return bits.join(' ');
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/)[0].slice(0, 300);
}

function main() {
  const mode = process.env.MODE ?? 'post';
  const { verdict, level, message } =
    mode === 'poll'
      ? classifyReindexPoll({
          outcome: process.env.POLL_OUTCOME ?? '',
          body: process.env.POLL_BODY ?? '',
          waitedSeconds: process.env.POLL_WAITED_S ?? '',
        })
      : classifyReindexResult({
          code: process.env.HTTP_CODE ?? process.argv[2] ?? '',
          body: process.env.RESP_BODY ?? '',
        });
  if (level === 'notice') console.log(message);
  else console.log(`::${level}::${message}`);
  // 0 = proceed, 1 = fail the step, 75 = INDETERMINATE, go poll (EX_TEMPFAIL).
  // reindex-loom-docs.sh keys on 75 explicitly; any other non-zero is a failure
  // there, so a typo in this mapping fails the step rather than skipping it.
  if (verdict === 'poll') process.exit(75);
  process.exit(verdict === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
