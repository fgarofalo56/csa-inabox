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
 *   MODE=poll POLL_OUTCOME=fresh|failed|timeout|unreachable|trigger_refused \
 *     POLL_BODY="$(cat get.json)" POLL_WAITED_S=$SECS POLL_ATTEMPTS=$N \
 *     POLL_IDLE_STREAK=$K POST_CODE=$CODE POST_CODES=504,502 POST_ATTEMPTS=$N \
 *     node scripts/ci/classify-reindex-result.mjs
 *
 * POLL_ATTEMPTS is EVERY poll the loop made; POLL_IDLE_STREAK is the TRAILING
 * run of them that read `stale`/`idle` with an unchanged chunk count. They are
 * different numbers and the `trigger_refused` message may only claim a reading
 * for the second (#4373).
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
 *   - 'trigger_refused' — every POST attempt was answered by the EDGE (gateway
 *                     5xx, no application body) and the TRAILING polls read
 *                     `stale`/`idle` with an unchanged chunk count. FAIL, and
 *                     named separately from 'timeout' because the next step is
 *                     different: this points at the request PATH, not at the
 *                     rebuild's duration. It is a RENAME of 'timeout' produced
 *                     after the same ceiling, never an early exit — the shell
 *                     evaluates it once the loop has ended, because no durable
 *                     "a rebuild is in flight" signal exists to end a wait on
 *                     (#3472; see the header note in reindex-loom-docs.sh).
 *
 * @param {{ outcome: string, body?: string, waitedSeconds?: number|string, attempts?: number|string, idleStreak?: number|string, postCode?: number|string, postCodes?: string, postAttempts?: number|string }} input
 * @returns {{ verdict: 'ok'|'tolerate'|'fail', level: 'notice'|'warning'|'error', message: string }}
 */
export function classifyReindexPoll({ outcome, body, waitedSeconds, attempts, idleStreak, postCode, postCodes, postAttempts }) {
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
    case 'timeout': {
      // #3942 — SAY WHICH CEILING TRIPPED. The poll loop now carries a wall
      // clock AND an attempt cap, and a message that names only the seconds
      // would assert a wall-clock timeout on a run that was cut off after N
      // polls (deploy-integrity R7).
      const polls = Number.isFinite(Number(attempts)) && Number(attempts) > 0
        ? ` after ${Number(attempts)} poll(s)`
        : '';
      // #3472 — TWO FAILURE MODES, ONE MESSAGE, AND A REVIEWER COULD NOT TELL
      // THEM APART. `freshness=stale job=idle` is not "the rebuild was slow": no
      // replica this poll reached was running one at all, which is a different
      // fact with a different next step (re-fire the trigger / check the job
      // dispatch) from "it is still building". Stated only from what was
      // observed — `job.state` is the ANSWERING REPLICA's view, so `idle` can
      // also mean the poll simply never landed on the worker, and this says so
      // rather than asserting nothing ran anywhere.
      const idle = job === 'idle' || job === 'unknown';
      const which = idle
        ? ' NOTHING WAS OBSERVED RUNNING: every replica this poll reached reported ' +
          `job=${job}, so this is "the index is stale and no rebuild was seen", NOT "a rebuild ran ` +
          'long". Note the replica caveat — `job.state` is only the answering replica\'s view, so ' +
          'this does not establish that no job ran anywhere. It does establish that none was ' +
          'visible for the whole wait.'
        : ` A rebuild was reported IN FLIGHT for the whole wait (job=${job}) — this is a slow or ` +
          'stuck rebuild, not an absent one.';
      return {
        verdict: 'fail',
        level: 'error',
        message:
          `loom-docs reindex did NOT reach a fresh state within ${waited}${polls} — ${detail}.` +
          which +
          ' A timeout is a REFUSAL, not a pass: proceeding would measure a STALE index, which is the ' +
          'exact failure this step exists to prevent. Failing loud.',
      };
    }
    case 'unreachable':
      return {
        verdict: 'tolerate',
        level: 'warning',
        message:
          'loom-docs reindex poll could not reach the console over Front Door (curl 000 on every attempt). ' +
          'TRANSIENT — the eval run reaches the console over the CAE-internal network (LOOM_EVAL_PROBE_URL), ' +
          'not Front Door, so it proceeds against the last-indexed corpus.',
      };
    // #3472 — A REFUSED TRIGGER IS NOT A SLOW REBUILD, AND THE OLD MESSAGE SAID
    // IT WAS. Run 33472611043 burned 904s over 57 polls and then reported "did
    // not reach a fresh state within 904s", which sent the reader at the
    // rebuild's duration. The rebuild was never accepted: the POST was answered
    // by the gateway, twice, and no poll ever saw a job.
    //
    // EVERY CLAUSE BELOW IS SCOPED TO WHAT WAS OBSERVED (deploy-integrity R7).
    // Established: N POST attempts each answered by the edge with no application
    // body, and the trailing polls reading freshness=stale job=idle with an
    // unchanged indexedChunkCount. NOT established, and therefore not asserted:
    // that no job ran anywhere (`job.state` is the answering REPLICA's view and
    // loom-console runs 2-6 replicas), or that no work progressed (the corpus
    // manifest is only written at the END of a rebuild, so the chunk count would
    // not move mid-run either way), or that the wait was shortened — it was not.
    case 'trigger_refused': {
      // NEVER INVENT THE ATTEMPT COUNT. This used to default to 2 when
      // `postAttempts` was absent, so a caller that did not pass it got the
      // sentence "All 2 POST attempt(s) were answered by the EDGE" over a run
      // that may have made one (POST_RETRIES=0, or the shell's pre-retry probe
      // skipped the retry). That is a number stated as measured and not
      // measured — deploy-integrity R7. With no count, say "Every".
      const n = Number(postAttempts);
      const tries = Number.isFinite(n) && n > 0 ? `All ${n}` : 'Every';
      // Same rule for the status: `trigger_refused` is only produced after a
      // gateway 5xx, but this function is pure and a caller that passes no code
      // has not established one. Name it only when it was handed over.
      //
      // AND NAME IT PER ATTEMPT, NOT ONCE FOR ALL OF THEM (#4373 review §4).
      // `postCode` alone is the LAST attempt's status, and the sentence around
      // it is plural ("All 2 POST attempt(s) were answered by the EDGE (HTTP
      // 502…)") — so a run whose attempt 1 was a 504 and attempt 2 a 502 was
      // reporting one sample as if it described both. The shell now hands over
      // EVERY attempt's code (`postCodes`, in order); when it does, each is
      // named. `postCode` remains the fallback for a caller that only has the
      // last one, and it says so ("on the LAST attempt") instead of implying it
      // covers all of them.
      const codes = String(postCodes ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      let edge;
      if (codes.length > 1) edge = ` (HTTP ${codes.join(' then ')}, one per attempt, no application body)`;
      else if (codes.length === 1) edge = ` (HTTP ${codes[0]}, no application body)`;
      else if (postCode) edge = ` (HTTP ${postCode} on the LAST attempt, no application body)`;
      else edge = ' (no application body)';
      // ── SAY WHICH POLLS. THE COUNT USED TO BE THE WRONG ONE (#4373 review §2).
      // This clause asserts that the polls it names read `freshness=stale
      // job=idle` with an unchanged chunk count. The shell establishes that for
      // the TRAILING streak only — `POLL_ATTEMPTS` is every poll the loop made,
      // including any that were unreachable, unparseable, or reported a
      // different state before the streak began. Printing the total therefore
      // claimed a reading for polls that never produced it: measured by the
      // reviewer at 10 claimed / 8 observed. The streak is now plumbed through
      // as `idleStreak` and the sentence names it explicitly; with no streak
      // handed over it says "the TRAILING" and no number, per the same rule that
      // forbids inventing the attempt count.
      const streak = Number(idleStreak);
      const total = Number(attempts);
      const haveStreak = Number.isFinite(streak) && streak > 0;
      const haveTotal = Number.isFinite(total) && total > 0;
      let polls;
      if (haveStreak && haveTotal) polls = `Of the ${total} poll(s) over ${waited} that followed, the LAST ${streak}`;
      else if (haveStreak) polls = `Over ${waited} of polling, the LAST ${streak} poll(s)`;
      else if (haveTotal) polls = `Of the ${total} poll(s) over ${waited} that followed, the TRAILING ones`;
      else polls = `Over ${waited} of polling, the TRAILING poll(s)`;
      return {
        verdict: 'fail',
        level: 'error',
        message:
          `loom-docs reindex TRIGGER REFUSED — ${detail}. ${tries} POST attempt(s) were answered by ` +
          `the EDGE${edge}. ${polls} read freshness=stale ` +
          'job=idle with the indexed chunk count unchanged. So the rebuild was never OBSERVED to be ' +
          'accepted or running, and the evals would measure the same STALE index they started with. ' +
          'This is a REQUEST-PATH problem, not a slow rebuild: look at the origin response timeout on ' +
          'POST /api/help-copilot/reindex (front-door.bicep originResponseTimeoutSeconds) and at whether ' +
          'the POST reached a replica at all — not at how long a corpus rebuild takes. ' +
          'CAVEATS, because this verdict is stated from what was seen and nothing more: `job.state` is ' +
          "only the ANSWERING replica's view and the console runs several replicas, so `idle` does not " +
          'prove no job started anywhere; and the corpus manifest is written only at the END of a ' +
          'rebuild, so an unchanged chunk count is not evidence that no work progressed. Failing loud. ' +
          'This verdict is a RENAME, not a shortcut: the wait ran to the same ceiling a `timeout` would ' +
          'have, and the exit code is identical — only the diagnosis differs.',
      };
    }
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
          attempts: process.env.POLL_ATTEMPTS ?? '',
          idleStreak: process.env.POLL_IDLE_STREAK ?? '',
          postCode: process.env.POST_CODE ?? '',
          postCodes: process.env.POST_CODES ?? '',
          postAttempts: process.env.POST_ATTEMPTS ?? '',
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
