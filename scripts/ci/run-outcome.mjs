#!/usr/bin/env node
/**
 * run-outcome.mjs — the ONE place that decides what a GitHub outcome MEANS.
 *
 * WHY THIS EXISTS (#3368)
 *
 *   Two surfaces reported a CANCELLATION as a FAILURE on the same day:
 *
 *   1. The deploy-failure auto-filer opened #3356 — "full-app-deploy-commercial
 *      is failing", P0-shaped, citing deploy-integrity.md R1 — from run
 *      31710130307, whose conclusion is `cancelled`. The operator had cancelled
 *      it themselves to deconflict a duplicate ACR-lease holder. The deploy
 *      path was never broken. The predicate was
 *          needs.redeploy-with-apps.result != 'success'
 *      inside an `if: always()` job, and `!= 'success'` is true for `cancelled`
 *      and for `skipped`.
 *
 *   2. `Run + gate Copilot quality evals` showed RED WITH ZERO STEPS EXECUTED,
 *      displaced from the repo-wide `copilot-quality-evals-estate` queue
 *      (`cancel-in-progress: false`) by a later PR. It produced no verdict at
 *      all, yet was indistinguishable from a genuine failure to a reviewer.
 *
 *   Both directions of the error are live and BOTH are harmful:
 *     - cancelled read as FAILED manufactures false P0s, and R1 says a broken
 *       deploy path preempts all feature work — a false P0 costs what a real
 *       one costs;
 *     - cancelled read as PASSED hides real gaps, which is how a required
 *       security check goes green over a scan that never ran.
 *   So this module never collapses the states. It names them.
 *
 * THE FOUR CATEGORIES
 *
 *   success     the thing ran and passed.
 *   failure     the thing ran and GENUINELY failed. Only `failure`,
 *               `timed_out` and `startup_failure` qualify.
 *   no-verdict  it did NOT produce a result: `cancelled`, `skipped`,
 *               `neutral`, `stale`, `action_required`. Not evidence either way.
 *   pending     it has not finished (or never reported): null, '', `queued`,
 *               `in_progress`, `waiting`, `requested`, `pending`. Reading this
 *               as a negative is the recorded UNKNOWN-as-NEGATIVE trap
 *               (an in-progress check read as "not found", #2819).
 *
 *   Anything unrecognised is `unknown` — NEVER silently folded into failure or
 *   into success. GitHub can add a conclusion at any time; a classifier that
 *   guesses is how a false verdict is manufactured (deploy-integrity.md R7).
 *
 * WHY TWO ENFORCEMENT MODES, AND WHY THAT IS NOT A CONTRADICTION
 *
 *   The right response to "no verdict" depends on what the caller does with it,
 *   so the caller declares it rather than this module guessing:
 *
 *   default            Used by the deploy-failure filer. no-verdict / pending /
 *                      unknown exit 0: a cancellation may be LOGGED, never
 *                      FILED as a P0. Filing on a non-failure is defect (1).
 *   --require-verdict  Used by required branch-protection checks (trivy, sbom).
 *                      no-verdict / pending / unknown exit 1 — fail CLOSED, so
 *                      a cancelled scan can never count as a pass. What changes
 *                      versus the code this replaces is not the exit status but
 *                      the MESSAGE: it now says "no verdict — cancelled",
 *                      not the false "the gate failed" (R7).
 *   --report-only      ALWAYS exits 0. For a step whose only job is to LABEL an
 *                      outcome that another check already gates on — e.g. the
 *                      copilot-quality-evals reporter, where the `evals` job's
 *                      own conclusion is the gate and is untouched. This is not
 *                      a discarded result: nothing here was the enforcement
 *                      point, and the mode refuses to emit `::error::` at all
 *                      (it would be an annotation that cannot reach a job
 *                      conclusion — see scripts/ci/check-annotation-teeth.mjs),
 *                      pointing at the gating job instead.
 *
 *   In both modes `genuineFailure` is the same boolean. The modes differ only
 *   in how they treat the ABSENCE of a verdict, which is exactly the axis the
 *   two defects sat on.
 *
 * USAGE (library)
 *   import { classifyOutcome, isGenuineFailure } from './run-outcome.mjs';
 *
 * USAGE (CLI, for bash/YAML consumers)
 *   node scripts/ci/run-outcome.mjs --result "$RESULT" --what "trivy-fs"
 *   node scripts/ci/run-outcome.mjs --result "$A" --result "$B" --require-verdict
 *
 *   Multiple --result flags roll up worst-first: a genuine failure outranks a
 *   no-verdict, which outranks pending, which outranks success. One failed
 *   shard makes the roll-up a failure even if a sibling was merely cancelled.
 *
 * EXIT
 *   0  success, or (default mode) no-verdict / pending / unknown
 *   1  genuine failure, or (--require-verdict) no-verdict / pending / unknown
 *   2  usage error — no --result supplied at all
 *
 * Tests: node --test scripts/ci/__tests__/run-outcome.test.mjs
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ran, and genuinely failed. `timed_out`/`startup_failure` are real failures. */
const GENUINE_FAILURE = new Set(['failure', 'timed_out', 'startup_failure']);

/** Completed WITHOUT producing a result. Not evidence of health or of breakage. */
const NO_VERDICT = new Set(['cancelled', 'canceled', 'skipped', 'neutral', 'stale', 'action_required']);

/** Has not finished. Distinct from "finished without a verdict". */
const PENDING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/** Category ranking for roll-ups: worst first. */
const RANK = { failure: 4, unknown: 3, 'no-verdict': 2, pending: 1, success: 0 };

/**
 * Classify one GitHub job `result` / run `conclusion` / check `conclusion`.
 *
 * PURE. `raw` may be null/undefined/'' — all three mean "no outcome reported",
 * which is `pending`, not a failure.
 *
 * @param {string|null|undefined} raw
 * @returns {{
 *   raw: string|null,
 *   outcome: string,
 *   category: 'success'|'failure'|'no-verdict'|'pending'|'unknown',
 *   genuineFailure: boolean,
 *   verdict: boolean,
 *   label: string
 * }}
 *   `verdict` is "this produced a result we can act on" — true only for
 *   success and genuine failure. `label` is a phrase that is TRUE by
 *   construction, so a caller cannot print a claim the classification does not
 *   support.
 */
export function classifyOutcome(raw) {
  const norm = typeof raw === 'string' ? raw.trim().toLowerCase() : raw == null ? '' : String(raw).trim().toLowerCase();

  if (norm === '') {
    return {
      raw: raw == null ? null : String(raw),
      outcome: 'pending',
      category: 'pending',
      genuineFailure: false,
      verdict: false,
      label: 'no outcome was reported (still running, or never started) — this is NOT a failure',
    };
  }
  if (norm === 'success') {
    return { raw: norm, outcome: 'success', category: 'success', genuineFailure: false, verdict: true, label: 'succeeded' };
  }
  if (GENUINE_FAILURE.has(norm)) {
    return {
      raw: norm,
      outcome: norm,
      category: 'failure',
      genuineFailure: true,
      verdict: true,
      label: norm === 'failure' ? 'genuinely failed' : `genuinely failed (${norm})`,
    };
  }
  if (NO_VERDICT.has(norm)) {
    return {
      raw: norm,
      outcome: norm === 'canceled' ? 'cancelled' : norm,
      category: 'no-verdict',
      genuineFailure: false,
      verdict: false,
      label: `was ${norm === 'canceled' ? 'cancelled' : norm} — it produced NO verdict, so this is neither a pass nor a failure`,
    };
  }
  if (PENDING.has(norm)) {
    return {
      raw: norm,
      outcome: norm,
      category: 'pending',
      genuineFailure: false,
      verdict: false,
      label: `is ${norm} — it has not finished, so there is no verdict yet`,
    };
  }
  return {
    raw: norm,
    outcome: norm,
    category: 'unknown',
    genuineFailure: false,
    verdict: false,
    label: `reported an outcome this classifier does not recognise ("${norm}") — treated as NO verdict rather than guessed`,
  };
}

/**
 * Did this outcome establish a GENUINE failure? The predicate the filer gates
 * on. False for cancelled, skipped, pending and unknown — every state that did
 * not establish breakage.
 *
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
export function isGenuineFailure(raw) {
  return classifyOutcome(raw).genuineFailure;
}

/**
 * Did this outcome produce an actionable result at all?
 *
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
export function hasVerdict(raw) {
  return classifyOutcome(raw).verdict;
}

/**
 * Roll several outcomes into one, worst-first.
 *
 * A genuine failure anywhere outranks everything: one failed shard plus one
 * cancelled shard is a FAILURE, because breakage was established. An unknown
 * outranks a no-verdict so a classifier gap is never quietly downgraded.
 *
 * @param {(string|null|undefined)[]} raws
 * @returns {ReturnType<typeof classifyOutcome> & {parts: ReturnType<typeof classifyOutcome>[]}}
 */
export function rollUp(raws) {
  const parts = (raws || []).map(classifyOutcome);
  if (parts.length === 0) {
    return { ...classifyOutcome(''), parts };
  }
  let worst = parts[0];
  for (const p of parts) {
    if (RANK[p.category] > RANK[worst.category]) worst = p;
  }
  return { ...worst, parts };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const results = [];
  let requireVerdict = false;
  let reportOnly = false;
  let what = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--result') {
      // An EMPTY value is meaningful (pending / never reported), so an empty
      // string is recorded rather than dropped. Only a missing flag is absent.
      results.push(i + 1 < argv.length ? argv[i + 1] : '');
      i += 1;
    } else if (argv[i] === '--require-verdict') {
      requireVerdict = true;
    } else if (argv[i] === '--report-only') {
      reportOnly = true;
    } else if (argv[i] === '--what') {
      what = i + 1 < argv.length ? argv[i + 1] : null;
      i += 1;
    }
  }
  return { results, requireVerdict, reportOnly, what };
}

/**
 * The CLI decision, as a pure function so the exit contract is unit-testable
 * rather than only observable by running a process.
 *
 * @param {{results:(string|null)[], requireVerdict?:boolean, reportOnly?:boolean, what:string|null}} args
 * @returns {{code:0|1|2, annotation:string|null, line:string, category:string}}
 */
export function cliDecision({ results, requireVerdict, reportOnly, what }) {
  if (!results || results.length === 0) {
    return {
      code: 2,
      annotation:
        '::error::run-outcome: no --result supplied. Refusing to classify nothing — a check that ' +
        'reports a verdict it never computed is the defect this file exists to prevent.',
      line: 'category=usage-error',
      category: 'usage-error',
    };
  }
  if (requireVerdict && reportOnly) {
    return {
      code: 2,
      annotation:
        '::error::run-outcome: --require-verdict and --report-only are contradictory (one enforces, ' +
        'the other only labels). Pick the one that matches what this step is for.',
      line: 'category=usage-error',
      category: 'usage-error',
    };
  }

  const r = rollUp(results);
  const subject = what ? `${what} ` : '';
  const detail =
    r.parts.length > 1 ? ` [${r.parts.map((p) => `${p.outcome}`).join(', ')}]` : '';
  const line = `${subject}${r.label}${detail}`;

  if (reportOnly) {
    // Never `::error::` here: an error annotation from a step that cannot fail
    // is precisely what check-annotation-teeth.mjs exists to reject. Say what
    // happened and name the check that DOES gate on it.
    return {
      code: 0,
      annotation: `::notice::${line}. (Reported for labelling only — the gating check is the job's own conclusion.)`,
      line,
      category: r.category,
    };
  }

  if (r.category === 'success') {
    return { code: 0, annotation: null, line, category: r.category };
  }
  if (r.category === 'failure') {
    return { code: 1, annotation: `::error::${line}`, line, category: r.category };
  }
  // no-verdict / pending / unknown — the whole point of this module.
  if (requireVerdict) {
    return {
      code: 1,
      annotation:
        `::error::${line}. This check requires a verdict, so it fails CLOSED — but note it did NOT fail: ` +
        'nothing was measured. Re-run it to get a result.',
      line,
      category: r.category,
    };
  }
  return {
    code: 0,
    annotation: `::warning::${line}. Logged, not escalated.`,
    line,
    category: r.category,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const d = cliDecision(args);
  if (d.annotation) process.stdout.write(`${d.annotation}\n`);
  process.stdout.write(`${d.line}\n`);
  process.stdout.write(`outcome-category=${d.category}\n`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `category=${d.category}\nverdict=${d.category === 'success' || d.category === 'failure'}\n`);
  }
  process.exit(d.code);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}
