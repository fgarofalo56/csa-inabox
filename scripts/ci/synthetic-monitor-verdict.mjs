#!/usr/bin/env node
/**
 * synthetic-monitor verdict (#4065) — say what was MEASURED, not what was guessed.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `loom-synthetic-monitor.yml` closed every non-Succeeded run with, verbatim:
 *
 *     ::error::Synthetic journeys FAILED (status=$STATUS, execution $EXEC)
 *              — realFails>0 (…). Inspect ContainerAppConsoleLogs_CL … for the
 *              failing journey + the Journeys tab on /admin/health.
 *
 * Measured on 25 consecutive runs (2026-08-24T19:30Z → 2026-08-25T14:04Z, seven
 * distinct SHAs): BOTH of the queries that could have established `realFails`
 * returned ZERO ROWS, and the workflow announced that itself two lines earlier —
 *
 *     ##[notice]No UAT_RESULT row yet … (query succeeded, zero rows …)
 *     ##[notice]No 'synthetic J' console lines in the last 2h (query succeeded, zero rows).
 *
 * So `realFails>0` was asserted from no journey data at all. The only fact in
 * hand was the Container App execution status. That is `deploy-integrity.md` R7
 * ("an error must not state as fact something it did not establish") and the
 * UNKNOWN-reported-as-NEGATIVE class. The same file already honours the
 * distinction elsewhere — "'no journey lines' below is unknown, not negative" —
 * and the final verdict simply did not.
 *
 * The remediation was wrong for the same reason. Those executions went
 * Running → Failed in ~65 seconds having written NOTHING, so the console-log
 * table carries no row for them: the reader is sent to search an empty table.
 * A job that dies that fast with no output is failing at STARTUP — image pull,
 * env/secret resolution, managed-identity login, or a crash before the first
 * write — which lives in the execution and replica surfaces
 * (`ContainerAppSystemLogs_CL` carries "Error provisioning revision …
 * ErrorCode: [ErrImagePull]|[Timeout]|[ContainerCrashing]"), not in journey
 * logs that were never emitted.
 *
 * SCOPE OF THAT "EMPTY" CLAIM — it is about `ContainerAppConsoleLogs_CL` and
 * NOTHING ELSE. An earlier revision of this header also asserted the
 * /admin/health Journeys tab was "empty by construction", which was an
 * inference presented as a measurement — the R7 error this very module exists
 * to remove. Measured instead: that tab is served by
 * `app/api/admin/synthetic-runs/route.ts` → `lib/admin/synthetic-runs-reader.ts`,
 * which lists Blob artifacts at `uat-runs/synthetic/<runId>/verdicts.ndjson`
 * in `LOOM_UAT_RESULTS_ACCOUNT` — a DIFFERENT store, and one that returns the
 * last N runs rather than this execution's. Zero console rows therefore
 * establishes nothing about it, in either direction. It is left out of the
 * no-data remediation because it is not where a startup failure's evidence is,
 * not because it was measured to be empty.
 *
 * ── EVIDENCE MUST BE THIS EXECUTION'S (#4065 round 2) ──────────────────────
 * A row is only evidence about the execution it came FROM. The ACA job carries
 * its own 15-minute schedule trigger, so a 2-hour log window routinely spans a
 * dozen prior executions: a query scoped only by time (or by job name) can hand
 * this module a `UAT_REAL_FAILS` line written by execution N-9 while execution
 * N died at startup having emitted nothing — and the verdict would then name
 * the wrong execution as having failing journeys. That is the SAME over-claim
 * this module removes, rebuilt on a new evidence path, so the module refuses
 * it structurally: a data-bearing side (`row`/`rows`) may only be promoted to
 * real-failure evidence when the caller states WHICH execution its query was
 * scoped to, and that execution is the one under test.
 *
 * The workflow supplies that by scoping both queries with
 * `ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '<exec>'`
 * — the correlation key Microsoft Learn's own "Query job run logs" recipe uses
 * (`az containerapp job execution list --query "[0].name"` → `startswith`;
 * learn.microsoft.com/azure/container-apps/jobs-get-started-cli). `ContainerGroupName_s`
 * is the REPLICA name in that table, and a job execution's replicas are named
 * `<execution>-<suffix>`, which is why `startswith` and not `==`.
 * `scripts/ci/__tests__/synthetic-monitor-verdict.test.mjs` reads the workflow
 * and fails if either query loses that filter while still claiming correlation.
 *
 * ── WHAT COUNTS AS EVIDENCE (nothing here is a guessed regex) ───────────────
 * Every token below is PINNED by the runner that emits it, so this module reads
 * a contract rather than inventing a pattern (the mistake the workflow's own
 * comment warns about — "a pattern that matched nothing would render as 'no
 * journey failed'"):
 *
 *   apps/fiab-console/e2e/run-uat-unattended.mjs:498
 *     `UAT_RESULT pass=<n> fail=<n> skip=<n> realFails=<n> infraGated=<n>`
 *   apps/fiab-console/e2e/run-uat-unattended.mjs:522
 *     `UAT_RESULT exit_code=<n> realFails=<n> infraGated=<n>`
 *   apps/fiab-console/e2e/run-uat-unattended.mjs:530  (emitted ONLY when realFails > 0)
 *     `UAT_REAL_FAILS app=… crashes=[…] empties=[…] infraGatedSteps=<n>`
 *   apps/fiab-console/e2e/run-uat-unattended.mjs:201  (every failing spec, gated or not)
 *     `UAT_FAIL <file>:<line> › <title> :: <first error line>`
 *
 * `UAT_FAIL` is deliberately NOT treated as a real failure. printFailedTests()
 * enumerates *all* failing specs including honest infra gates, and the runner
 * exits 0 when every one of them is gated. Promoting `UAT_FAIL` to "realFails>0"
 * would re-introduce the very over-claim this module exists to remove.
 *
 * A `UAT_RESULT` row with NO `realFails=` token yields `null`, never 0 — an
 * absent field is unknown, not a measurement of zero.
 *
 * ── THE VERDICTS ────────────────────────────────────────────────────────────
 *   succeeded       execution Succeeded                                exit 0
 *   journeys-failed non-Succeeded AND real-fail evidence exists        exit 1
 *                   (…and that evidence is correlated to THIS execution)
 *   unknown         non-Succeeded AND no correlated real-fail evidence exit 1
 *   not-deployed    the job is absent from this estate                 exit 0
 *
 * `unknown` keeps the NON-ZERO exit on purpose. Failing closed on UNKNOWN is
 * correct — an unattended monitor that cannot see its subject must not report
 * green. What changes is that it stops naming a cause it never established.
 *
 * USAGE
 *   node scripts/ci/synthetic-monitor-verdict.mjs \
 *     --status Failed --execution loom-synthetic-monitor-06cuztq \
 *     --job loom-synthetic-monitor --resource-group rg-csa-loom-admin-centralus \
 *     --uat-state zero-rows   [--uat-file FILE]      [--uat-rc N] \
 *     [--uat-correlation EXEC] \
 *     --journeys-state zero-rows [--journeys-file FILE] [--journeys-rc N] \
 *     [--journeys-correlation EXEC]
 *
 * `--uat-correlation` / `--journeys-correlation` name the execution the
 * corresponding query was SCOPED to. Omit them and the rows are treated as
 * uncorrelated — readable as evidence of nothing, which is the honest reading
 * of a row that could have come from any execution.
 *
 * Log text reaches this process through FILES and argv, never through a shell
 * string that is re-evaluated — a Playwright error line carrying a backtick or
 * `${` has already killed one step in this workflow (see the github-script
 * note in loom-synthetic-monitor.yml).
 *
 * Tests: node --test scripts/ci/__tests__/synthetic-monitor-verdict.test.mjs
 */

/**
 * The states a result query can be in.
 *
 * `row` and `rows` are the same concept — the query returned data — and both
 * spellings are accepted on both sides. The published type used to omit `rows`
 * while the code required it, so a caller who followed the contract fell into
 * the terminal `else` and was told "NOT ATTEMPTED (no Log Analytics workspace
 * resolved)" about a query that had run and returned rows. A false statement
 * produced by a type/implementation mismatch is still a false statement.
 *
 * @typedef {'row'|'rows'|'zero-rows'|'query-failed'|'not-attempted'} QueryState
 */

/** Every state this module recognises. Anything else is a caller bug, loudly. */
const VALID_STATES = new Set(['row', 'rows', 'zero-rows', 'query-failed', 'not-attempted']);
/** The two spellings that mean "the query came back with data". */
const DATA_STATES = new Set(['row', 'rows']);
/** The placeholder used when no --execution was supplied — never correlatable. */
const UNKNOWN_EXECUTION = '<unknown execution>';

/**
 * Coerce + VALIDATE a query state. An unrecognised value throws rather than
 * falling through to a default, because every default here is a factual claim
 * about a query, and a claim derived from a typo is exactly the class this
 * module exists to remove.
 *
 * @param {unknown} v
 * @param {'UAT_RESULT'|'per-journey'} which
 * @returns {QueryState}
 */
function normalizeQueryState(v, which) {
  const s = v === undefined || v === null || v === '' ? 'not-attempted' : String(v);
  if (!VALID_STATES.has(s)) {
    throw new TypeError(
      `[synthetic-monitor] the ${which} query state ${JSON.stringify(s)} is not one of ` +
        `${[...VALID_STATES].join(' | ')}. Refusing to guess: an unrecognised state must not ` +
        'render as "NOT ATTEMPTED", which would assert something about the query that was never measured.',
    );
  }
  return /** @type {QueryState} */ (s);
}

/**
 * Is this side's data actually about the execution under test?
 *
 * A row is evidence about the execution it came FROM. The caller states which
 * execution its query was scoped to; anything else — absent, blank, or a
 * different execution — is UNCORRELATED and may not be promoted to a claim
 * about this run's journeys.
 *
 * @param {string} execution the execution under test
 * @param {unknown} scopedTo what the caller says the query was scoped to
 * @returns {boolean}
 */
function isCorrelated(execution, scopedTo) {
  if (typeof scopedTo !== 'string') return false;
  const s = scopedTo.trim();
  if (s === '') return false;
  return s === execution && execution !== '' && execution !== UNKNOWN_EXECUTION;
}

/** The placeholder used when no --execution was supplied — never correlatable. */
/**
 * Pull `realFails=<n>` out of a UAT_RESULT summary line.
 *
 * The boundaries on both sides are load-bearing: `realFails` must be a whole
 * token. `xrealFails=3` (a prefix) and `realFailsX=3` (a suffix) are both
 * something else's field and yield null, not 3.
 *
 * @param {string|null|undefined} line
 * @returns {number|null} the count, or null when the line/token is absent
 *                        (UNKNOWN — never coerced to 0)
 */
export function parseRealFails(line) {
  if (typeof line !== 'string' || line.length === 0) return null;
  const m = /(?:^|\s)realFails=(\d+)(?:\s|$)/.exec(line);
  return m ? Number(m[1]) : null;
}

/** `UAT_REAL_FAILS …` is emitted only when the runner counted a real failure. */
const REAL_FAILS_LINE = /(?:^|\s)UAT_REAL_FAILS\s/;
/** `UAT_FAIL …` covers infra-gated specs too — informative, NOT proof of a real fail. */
const ANY_FAIL_LINE = /(?:^|\s)UAT_FAIL\s/;

function toLines(v) {
  if (Array.isArray(v)) return v.filter((l) => typeof l === 'string' && l.trim() !== '');
  if (typeof v === 'string') return v.split(/\r?\n/).filter((l) => l.trim() !== '');
  return [];
}

/**
 * Classify a synthetic-monitor run from what was actually measured.
 *
 * @param {{
 *   status: string,
 *   execution?: string,
 *   jobName?: string,
 *   resourceGroup?: string,
 *   uat?: {state: QueryState, line?: string|null, rc?: number|null, correlatedTo?: string|null},
 *   journeys?: {state: QueryState, lines?: string[]|string|null, rc?: number|null, correlatedTo?: string|null},
 * }} input
 * @returns {{verdict: 'succeeded'|'journeys-failed'|'unknown'|'not-deployed',
 *            reason: string, exitCode: number, realFails: number|null,
 *            evidence: string[], message: string, remediation: string[]}}
 * @throws {TypeError} on an unrecognised query state — never a silent default.
 */
export function syntheticMonitorVerdict(input) {
  const status = String(input?.status ?? 'Unknown');
  const execution = input?.execution || UNKNOWN_EXECUTION;
  const jobName = input?.jobName || 'loom-synthetic-monitor';
  const rg = input?.resourceGroup || 'rg-csa-loom-admin-centralus';

  const uatState = normalizeQueryState(input?.uat?.state, 'UAT_RESULT');
  const jState = normalizeQueryState(input?.journeys?.state, 'per-journey');

  // Correlation is checked for the DATA states only: "zero rows" and "the query
  // failed" say nothing about any execution, so there is nothing to mis-attribute.
  const uatHasData = DATA_STATES.has(uatState);
  const jHasData = DATA_STATES.has(jState);
  const uatCorrelated = uatHasData && isCorrelated(execution, input?.uat?.correlatedTo);
  const jCorrelated = jHasData && isCorrelated(execution, input?.journeys?.correlatedTo);

  // Data that is not correlated to THIS execution is not this execution's
  // evidence. It is still reported (an operator wants to know it exists) — it
  // simply cannot move the verdict.
  const uatLine = uatCorrelated ? (input?.uat?.line ?? null) : null;
  const jLines = jCorrelated ? toLines(input?.journeys?.lines) : [];
  const rawUatLine = typeof input?.uat?.line === 'string' ? input.uat.line.trim() : '';
  const uncorrelatedJLines = jHasData && !jCorrelated ? toLines(input?.journeys?.lines) : [];
  // A data state whose payload is EMPTY is not discarded data — there was
  // nothing to discard. Naming it "DISCARDED" would be its own small R7.
  const uatDiscarded = uatHasData && !uatCorrelated && rawUatLine !== '';
  const uatEmptyRow = uatHasData && rawUatLine === '';
  const jDiscarded = uncorrelatedJLines.length > 0;
  const jEmptyRows = jHasData && toLines(input?.journeys?.lines).length === 0;

  if (status === 'NotDeployed') {
    return {
      verdict: 'not-deployed',
      reason: 'job-absent',
      exitCode: 0,
      realFails: null,
      evidence: [],
      remediation: [],
      message:
        `[synthetic-monitor] SKIP — the ${jobName} Container App Job is not deployed in ${rg}. ` +
        'Nothing was measured about the journeys, and nothing is claimed about them.',
    };
  }

  const realFails = parseRealFails(uatLine);
  const realFailLines = jLines.filter((l) => REAL_FAILS_LINE.test(l));
  const anyFailLines = jLines.filter((l) => ANY_FAIL_LINE.test(l));
  const hasUncorrelatedData = uatDiscarded || jDiscarded;

  /** Evidence lines, in the order an operator should read them. */
  const evidence = [];
  if (uatCorrelated && !uatEmptyRow) evidence.push(`UAT_RESULT row (scoped to ${execution}): ${uatLine}`);
  else if (uatEmptyRow) {
    evidence.push(
      'UAT_RESULT state says a row was returned but its payload is EMPTY — there is nothing to read, ' +
        'and nothing is claimed from it.',
    );
  } else if (uatDiscarded) {
    evidence.push(
      `UAT_RESULT row DISCARDED — the query was not scoped to ${execution} ` +
        `(scoped to: ${JSON.stringify(input?.uat?.correlatedTo ?? null)}), so the row may belong to ` +
        'any prior execution of this job and is not evidence about this one.',
    );
  } else if (uatState === 'query-failed') {
    evidence.push(
      `UAT_RESULT query FAILED (rc=${input?.uat?.rc ?? '?'}) — its silence is UNKNOWN, not zero failures.`,
    );
  } else if (uatState === 'zero-rows') {
    evidence.push('UAT_RESULT query succeeded with ZERO ROWS — the runner never wrote a summary line (or ingestion lagged).');
  } else {
    evidence.push('UAT_RESULT query was NOT ATTEMPTED (no Log Analytics workspace resolved).');
  }
  if (jCorrelated && !jEmptyRows) evidence.push(`Journey console lines retrieved for ${execution}: ${jLines.length}`);
  else if (jEmptyRows) {
    evidence.push(
      'Per-journey state says rows were returned but the payload is EMPTY — there is nothing to read, ' +
        'and nothing is claimed from it.',
    );
  } else if (jDiscarded) {
    evidence.push(
      `Journey console lines DISCARDED (${uncorrelatedJLines.length}) — the query was not scoped to ${execution} ` +
        `(scoped to: ${JSON.stringify(input?.journeys?.correlatedTo ?? null)}). This job runs on its own 15-minute ` +
        'schedule, so an unscoped window routinely contains other executions lines.',
    );
  } else if (jState === 'query-failed') {
    evidence.push(
      `Per-journey query FAILED (rc=${input?.journeys?.rc ?? '?'}) — its silence is UNKNOWN, not "no journey failed".`,
    );
  } else if (jState === 'zero-rows') {
    evidence.push("Per-journey query succeeded with ZERO ROWS — the execution emitted no 'synthetic J' / UAT_* console lines at all.");
  } else {
    evidence.push('Per-journey query was NOT ATTEMPTED (no Log Analytics workspace resolved).');
  }

  if (status === 'Succeeded') {
    return {
      verdict: 'succeeded',
      reason: 'execution-succeeded',
      exitCode: 0,
      realFails,
      evidence,
      remediation: [],
      message: `[synthetic-monitor] OK — execution ${execution} Succeeded.`,
    };
  }

  // ---- non-Succeeded: is there EVIDENCE of a failing journey, or only a status?
  const hasRealFailEvidence = (realFails !== null && realFails > 0) || realFailLines.length > 0;

  if (hasRealFailEvidence) {
    const cited =
      realFails !== null && realFails > 0
        ? `realFails=${realFails} (from the runner's own UAT_RESULT summary)`
        : `UAT_REAL_FAILS console line(s): ${realFailLines.length}`;
    return {
      verdict: 'journeys-failed',
      reason: realFails !== null && realFails > 0 ? 'uat-result-real-fails' : 'uat-real-fails-line',
      exitCode: 1,
      realFails,
      evidence,
      remediation: [
        `az monitor log-analytics query -w <workspace> --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '${execution}' | order by TimeGenerated asc | project Log_s"`,
        'Journeys tab on /admin/health (the per-journey verdicts for this run).',
        'docs/fiab/runbooks/synthetic-journeys.md',
      ],
      message:
        `[synthetic-monitor] JOURNEYS FAILED (status=${status}, execution ${execution}) — ${cited}. ` +
        'The runner exits non-zero only on real code/login failures; honest infra gates exit 0, ' +
        'so this is a REAL failure and not a gate.',
    };
  }

  // ---- UNKNOWN. Only the execution status is established.
  const noJourneyDataAtAll = jLines.length === 0;
  const gatedOnly = anyFailLines.length > 0 && realFailLines.length === 0 && (realFails === null || realFails === 0);

  const remediation = hasUncorrelatedData
    ? [
        // Re-run the read scoped to THIS execution. Learn's own job-run log
        // recipe uses exactly this key.
        `az monitor log-analytics query -w <workspace> --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '${execution}' | order by TimeGenerated asc | project TimeGenerated, Log_s"  # THIS execution only — the rows above were not scoped to it`,
        `az containerapp job logs show -n ${jobName} -g ${rg} --container ${jobName} --execution ${execution} --tail 300`,
        `az containerapp job execution show -n ${jobName} -g ${rg} --job-execution-name ${execution}`,
      ]
    : noJourneyDataAtAll
      ? [
          // The ~65s no-output shape: diagnose the EXECUTION, not journey logs
          // that were never written.
          `az containerapp job execution show -n ${jobName} -g ${rg} --job-execution-name ${execution}`,
          `az containerapp job replica list -n ${jobName} -g ${rg} --execution ${execution} -o table`,
          `az containerapp job logs show -n ${jobName} -g ${rg} --container ${jobName} --execution ${execution} --tail 300`,
          `az monitor log-analytics query -w <workspace> --analytics-query "ContainerAppSystemLogs_CL | where ContainerAppName_s == '${jobName}' | where TimeGenerated > ago(2h) | order by TimeGenerated asc | project TimeGenerated, Log_s"  # carries "Error provisioning revision … ErrorCode: [ErrImagePull]|[Timeout]|[ContainerCrashing]"`,
          `az containerapp job show -n ${jobName} -g ${rg} --query "properties.template.containers[].{image:image,env:env[].name}"  # image tag actually referenced + env/secretref names`,
        ]
      : [
          `az monitor log-analytics query -w <workspace> --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '${execution}' | order by TimeGenerated asc | project Log_s"  # the FULL log for THIS execution, not a 2h window`,
          `az containerapp job logs show -n ${jobName} -g ${rg} --container ${jobName} --execution ${execution} --tail 300`,
        ];

  const whyUnknown = hasUncorrelatedData
    ? 'result rows WERE retrieved, but the query that produced them was not scoped to this execution, so they ' +
      'cannot be attributed to it. This job also runs on its own 15-minute schedule, which means an unscoped ' +
      "window normally contains several OTHER executions' lines — promoting one of those would name the wrong " +
      'execution as having failing journeys, which is the same over-claim this verdict exists to remove.'
    : noJourneyDataAtAll
      ? 'BOTH result queries came back without a single journey row, so nothing is known about J1..J6 — ' +
        'not which one failed, not whether any of them ran. An execution that reaches a terminal state ' +
        'having emitted no console output at all is failing at STARTUP (image pull, env/secret resolution, ' +
        'managed-identity login, or a crash before the first write), which journey logs cannot show you ' +
        'because they do not exist.'
      : gatedOnly
        ? `journey lines were retrieved (${jLines.length}, including ${anyFailLines.length} UAT_FAIL) but NOT one UAT_REAL_FAILS ` +
          'line and no realFails= count above zero. UAT_FAIL covers honest infra gates too, so it does not ' +
          'establish a real failure — which of the two this is, is unknown from the data in hand.'
        : `journey lines were retrieved (${jLines.length}) but none of them carries the runner's real-failure ` +
          "markers (UAT_REAL_FAILS, or a realFails= count above zero), so the journeys' outcome is not established.";

  return {
    verdict: 'unknown',
    reason: hasUncorrelatedData
      ? 'uncorrelated-evidence'
      : noJourneyDataAtAll
        ? 'no-journey-data'
        : gatedOnly
          ? 'gated-fails-only'
          : 'no-real-fail-markers',
    exitCode: 1,
    realFails,
    evidence,
    remediation,
    message:
      `[synthetic-monitor] UNKNOWN — execution ${execution} ended ${status}, and that is the ONLY thing ` +
      `established by this run. The journeys' outcome is UNKNOWN: ${whyUnknown} ` +
      'Failing the run anyway (an unattended monitor that cannot see its subject must not report green), ' +
      'and attributing it to NOTHING — no real-failure count was measured, so none is named. ' +
      '(The literal over-claim this replaced is deliberately absent from this string, ' +
      'so a grep for it stays a true detector.)',
  };
}

// ------------------------------------------------------------------ CLI
function parseArgv(argv) {
  /** @type {Record<string,string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * GITHUB_OUTPUT is a single-line channel without a heredoc — flatten and bound.
 *
 * The bound is 4000, not a few hundred: at 900 the no-data remediation (933
 * chars) lost its last command, which is precisely the one an operator needs
 * when nothing was logged. A cap that silently eats the payload is its own
 * small version of this file's problem.
 */
function oneLine(s, max = 4000) {
  return String(s).replace(/\r?\n/g, ' | ').slice(0, max);
}

async function main() {
  const a = parseArgv(process.argv.slice(2));
  if (!a.status) {
    console.error(
      'usage: node scripts/ci/synthetic-monitor-verdict.mjs --status S [--execution E] [--job J] ' +
        '[--resource-group RG] [--uat-state row|zero-rows|query-failed|not-attempted] [--uat-file F] [--uat-rc N] ' +
        '[--uat-correlation EXEC] ' +
        '[--journeys-state rows|zero-rows|query-failed|not-attempted] [--journeys-file F] [--journeys-rc N] ' +
        '[--journeys-correlation EXEC]',
    );
    process.exit(2);
  }
  const { readFileSync, existsSync } = await import('node:fs');
  const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf8') : '');

  const result = syntheticMonitorVerdict({
    status: a.status,
    execution: a.execution,
    jobName: a.job,
    resourceGroup: a['resource-group'],
    uat: {
      state: /** @type {QueryState} */ (a['uat-state'] || 'not-attempted'),
      line: readIf(a['uat-file']).replace(/\r/g, '').trim(),
      rc: a['uat-rc'] !== undefined ? Number(a['uat-rc']) : null,
      // The execution the UAT_RESULT query was scoped to. Absent ⇒ uncorrelated
      // ⇒ the row cannot become a claim about this execution's journeys.
      correlatedTo: a['uat-correlation'] ?? null,
    },
    journeys: {
      state: /** @type {QueryState} */ (a['journeys-state'] || 'not-attempted'),
      lines: readIf(a['journeys-file']).replace(/\r/g, ''),
      rc: a['journeys-rc'] !== undefined ? Number(a['journeys-rc']) : null,
      correlatedTo: a['journeys-correlation'] ?? null,
    },
  });

  console.log('[synthetic-monitor] what was MEASURED this run:');
  console.log(`  execution status : ${a.status}`);
  for (const e of result.evidence) console.log(`  ${e}`);
  console.log(result.message);
  if (result.remediation.length > 0) {
    console.log('[synthetic-monitor] where to look (this is where the evidence actually is):');
    for (const r of result.remediation) console.log(`  ${r}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `verdict=${result.verdict}\n` +
        `verdict_reason=${result.reason}\n` +
        `verdict_message=${oneLine(result.message)}\n` +
        `verdict_remediation=${oneLine(result.remediation.join(' ;; '))}\n`,
    );
  }
  if (process.env.GITHUB_ACTIONS) {
    if (result.exitCode !== 0) console.log(`::error::${oneLine(result.message, 4000)}`);
    else console.log(`::notice::${oneLine(result.message, 4000)}`);
  }
  process.exit(result.exitCode);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[synthetic-monitor] FAIL — the verdict could not be computed: ${e.message}`);
    process.exit(2);
  });
}
