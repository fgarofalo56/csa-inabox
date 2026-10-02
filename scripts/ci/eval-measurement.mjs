#!/usr/bin/env node
/**
 * eval-measurement.mjs — did the Copilot quality-eval run JUDGE anything? (#4346)
 *
 * WHY THIS EXISTS
 * ---------------
 * The eval gate counted a surface as "measured" when it had `questions > 0`.
 * `questions` is the number of rows that came back with an answer, not the
 * number the grounding judge SCORED. When the E2 judge's daily cap
 * (`LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP`) is spent, the evaluator still probes
 * every row, still computes a deterministic pass-rate, and then DEFERS the
 * judge: every surface comes back with `groundingAvg: null` and
 * `passRate: null`.
 *
 * Measured 2026-09-30: after ~14:13 UTC the cap was spent by that day's 31
 * fully-judged sweeps, and 19 further runs judged ZERO questions. 17 of them
 * were PR runs that concluded green, and their logs said
 * "surfaces actually measured: 10". Their job summaries said
 * "Copilot quality evals — PASS". Nothing had been judged.
 *
 * This module answers the question those runs got wrong, from the run receipt
 * (`eval-run.json`, the `RunSummary` the evaluator emits), and nothing else.
 *
 * WHAT THE RECEIPT CAN AND CANNOT SAY
 * -----------------------------------
 * A `groundingAvg: null` is written whenever no row on the surface has
 * `judgeStatus === 'scored'`. A deferred judge, a judge call that failed on
 * every row, and every row auto-failing all produce that same shape, and the
 * per-surface receipt carries no judged/deferred/error counts. So this module
 * never says WHY the judge scored nothing; the evaluator job log's per-surface
 * `judged= deferred= auto-fail=` line does.
 *
 * THE PREDICATES (load-bearing — read before editing)
 * ---------------------------------------------------
 * A surface is PROBED iff `questions > 0` OR `rowsAttempted > 0`. A surface
 * whose every probe call failed comes back `questions: 0, rowsAttempted: 15`;
 * it was attempted and measured nothing, so it must count against the run,
 * not drop out of both sides of the count.
 *
 * A surface HAS A GROUNDING SCORE iff `questions > 0` AND `groundingAvg` is a
 * finite number.
 *   - `groundingAvg` is the ONLY field the judge alone produces. `passRate` is
 *     not used: images built before the deferral split wrote the DETERMINISTIC
 *     pass-rate into `passRate` on a deferred run, so a non-null `passRate`
 *     does not prove the judge ran. `deterministicPassRate` never counts.
 *   - `groundingAvg: 0` IS judged — the judge ran and scored every answer 0.
 *     A truthiness test (`if (s.groundingAvg)`) would call that "not judged",
 *     which is the falsy-zero trap; `Number.isFinite` is deliberate.
 *   - a finite `groundingAvg` on a surface with `questions: 0` is NOT judged:
 *     there is nothing it could be an average of.
 *
 * A surface is FULLY JUDGED iff it has a grounding score, its `rowsAttempted`
 * (when present) is not greater than `questions`, AND its declared
 * `passPredicate.judgeCoverage` is not a finite number below 1. `groundingAvg`
 * is finite as soon as ONE row is scored (a judge budget that ran out
 * mid-surface), so a surface at coverage 0.2 is PARTLY judged and is never
 * counted as fully judged. A surface that lost probe rows — `questions: 12,
 * rowsAttempted: 15` — is PARTLY judged too: the judge never saw the 3 rows
 * that failed to probe, so "fully scored" is a claim the receipt does not
 * support, even when every surviving row was scored and no `judgeCoverage`
 * is declared. A receipt that omits `judgeCoverage` (images before #2992) is
 * read as before: a grounding score over every attempted row is a judged
 * surface.
 *
 * MEASUREMENT STATES
 *   none                no probed surface returned an answer
 *   deterministic-only  answers came back; the judge scored NONE of them
 *   partial             some probed surface is not fully judged
 *   judged              the judge fully scored every probed surface
 *
 * CLI
 *   node scripts/ci/eval-measurement.mjs --artifact eval-run.json
 *        [--annotate] [--prepend-to eval-summary.md]
 *     Prints one line; writes measurement / *_surfaces / *_questions /
 *     measurement_text (the printed line) to
 *     $GITHUB_OUTPUT when set; with --annotate emits a ::warning:: when the
 *     measurement is not `judged`; with --prepend-to puts the banner at the top
 *     of that file. Exit 0. A missing or unparseable artifact exits 2 — this
 *     module never reports a measurement it could not read.
 *
 *   node scripts/ci/eval-measurement.mjs --label --category <c>
 *        [--measurement <m>] [--reported-only true|false] [--gate-rc <n>]
 *        [--coverage-unknown true|false]
 *     Prints the job-summary heading for the report-outcome job. LABELS only;
 *     it never changes a job conclusion.
 *
 *   node scripts/ci/eval-measurement.mjs --check-run --measurement <m>
 *        --text <describeMeasurement line> --head-sha <40-hex sha>
 *     Prints the Checks API body for the SEPARATE neutral check-run named
 *     NOT_MEASURED_CHECK_NAME. Only for deterministic-only / partial / none;
 *     any other measurement, or a malformed sha, exits 2 and prints nothing.
 *     The check-run's conclusion is always `neutral`: it is informational and
 *     changes no other check's conclusion.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEASUREMENTS = Object.freeze(['none', 'deterministic-only', 'partial', 'judged']);

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const qs = (s) => positive(s?.questions);
const attemptedRows = (s) => positive(s?.rowsAttempted);

/** The declared judge coverage, or null when the receipt does not carry one. */
function judgeCoverageOf(s) {
  const c = s?.passPredicate?.judgeCoverage;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** True iff the surface was probed at all — answered rows OR attempted rows. */
export function isProbedSurface(s) {
  return qs(s) > 0 || attemptedRows(s) > 0;
}

/** True iff the grounding judge produced a score for this surface (one row is enough). */
export function isJudgedSurface(s) {
  return qs(s) > 0 && typeof s?.groundingAvg === 'number' && Number.isFinite(s.groundingAvg);
}

/** True iff the judge scored the surface over every attempted row, and its
 * declared coverage (if any) is not below 1. */
export function isFullyJudgedSurface(s) {
  if (!isJudgedSurface(s)) return false;
  const attempted = attemptedRows(s);
  if (attempted > 0 && attempted > qs(s)) return false;
  const c = judgeCoverageOf(s);
  return c === null || c >= 1;
}

const pct = (c) => `${Math.round(c * 100)}%`;

/**
 * Classify a RunSummary. Throws on a receipt with no `surfaces` array — a
 * receipt this module cannot read is not a receipt that measured nothing.
 */
export function classifyMeasurement(run) {
  if (!run || !Array.isArray(run.surfaces)) {
    throw new TypeError('eval-run receipt has no `surfaces` array — cannot say what was measured');
  }
  const surfaces = run.surfaces;
  const probed = surfaces.filter(isProbedSurface);
  const withScore = probed.filter(isJudgedSurface);
  const fully = probed.filter(isFullyJudgedSurface);
  const totalQuestions = probed.reduce((a, s) => a + qs(s), 0);
  const judgedQuestions = fully.reduce((a, s) => a + qs(s), 0);
  let measurement;
  if (totalQuestions === 0) measurement = 'none';
  else if (withScore.length === 0) measurement = 'deterministic-only';
  else if (fully.length < probed.length) measurement = 'partial';
  else measurement = 'judged';
  const name = (s) => String(s.surface ?? '?');
  // True iff EVERY surface counted as fully judged has no declared
  // `judgeCoverage` at all -- the shape every run takes while the deployed
  // evaluator image lags main and never emits `passPredicate` (#4875). In
  // that shape "fully scored" is not an established fact, only "has a
  // grounding score": `isFullyJudgedSurface` reads a missing coverage as
  // fully judged (unchanged, for images before #2992), but the TEXT must not
  // claim coverage it was never told.
  const coverageUnknown = fully.length > 0 && fully.every((s) => judgeCoverageOf(s) === null);
  return {
    measurement,
    totalSurfaces: surfaces.length,
    probedSurfaces: probed.length,
    judgedSurfaces: fully.length,
    partlyJudgedSurfaces: withScore.length - fully.length,
    totalQuestions,
    judgedQuestions,
    coverageUnknown,
    // Probed, and the judge produced no score at all (includes surfaces where
    // no probe row returned an answer).
    unjudged: probed.filter((s) => !isJudgedSurface(s)).map(name),
    // Probed and returned no answer at all: every attempted row failed.
    unanswered: probed.filter((s) => qs(s) === 0).map((s) => ({ surface: name(s), rowsAttempted: attemptedRows(s) })),
    // A grounding score, but either dropped probe rows the judge never saw,
    // or a declared judge coverage below 1.
    partlyJudged: withScore
      .filter((s) => !isFullyJudgedSurface(s))
      .map((s) => {
        const attempted = attemptedRows(s);
        return {
          surface: name(s),
          questions: qs(s),
          rowsAttempted: attempted,
          droppedRows: attempted > 0 && attempted > qs(s),
          judgeCoverage: judgeCoverageOf(s),
        };
      }),
  };
}

const WHY_UNKNOWN =
  'The receipt does not say why: a deferred judge (the daily cap LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP spent, or no ' +
  'judge deployment configured), a judge call that failed on every row, or every row auto-failing all produce ' +
  "this shape. The evaluator job log's per-surface `judged= deferred= auto-fail=` line says which.";

/** One human sentence. Never says "measured" for a run the judge did not score. */
export function describeMeasurement(m) {
  const counts =
    `the grounding judge fully scored ${m.judgedSurfaces} of the ${m.probedSurfaces} surface(s) that were probed ` +
    `(${m.totalSurfaces} in the receipt); ${m.judgedQuestions} of the ${m.totalQuestions} question(s) that returned ` +
    'an answer are on fully scored surfaces';
  const coverageUnknownNote =
    ' Judge coverage is UNKNOWN for this run: the receipt does not record `passPredicate.judgeCoverage` on any ' +
    'surface (the deployed evaluator image lags main, #4875), so only a grounding score is established -- full ' +
    'judge coverage is not.';
  switch (m.measurement) {
    case 'judged':
      return `JUDGED — ${counts}.${m.coverageUnknown ? coverageUnknownNote : ''}`;
    case 'partial': {
      const parts = [];
      const unanswered = new Map(m.unanswered.map((u) => [u.surface, u.rowsAttempted]));
      if (m.unjudged.length) {
        parts.push(
          `No grounding score: ${m.unjudged
            .map((s) => (unanswered.has(s) ? `${s} (0 of ${unanswered.get(s)} probed row(s) returned an answer)` : s))
            .join(', ')}.`,
        );
      }
      if (m.partlyJudged.length) {
        parts.push(
          `Partly judged: ${m.partlyJudged
            .map((p) => {
              if (p.droppedRows) {
                return `${p.surface} (${p.questions} of ${p.rowsAttempted} probed row(s) returned an answer)`;
              }
              if (typeof p.judgeCoverage !== 'number' || !Number.isFinite(p.judgeCoverage)) {
                return `${p.surface} (judge coverage unknown)`;
              }
              return `${p.surface} (judge coverage ${pct(p.judgeCoverage)})`;
            })
            .join(', ')}.`,
        );
      }
      return `PARTIALLY MEASURED — ${counts}. ${parts.join(' ')} Only the fully scored surfaces carry a quality result.`;
    }
    case 'deterministic-only':
      return (
        `NOT MEASURED — ${counts}. The judge scored no question on any surface, so this run has no judged ` +
        `pass-rate; only the deterministic pass-rate was computed, and it is not the quality bar. ${WHY_UNKNOWN}`
      );
    case 'none':
    default:
      return (
        `NOT MEASURED — no surface returned an answer (${m.probedSurfaces} of ${m.totalSurfaces} surface(s) in ` +
        'the receipt were probed).'
      );
  }
}

/**
 * The exact check-run name. tools/drain/gates.py reads a `neutral` conclusion
 * on THIS name as "not evidence" (never green coverage), and its test lifts
 * the string from this file rather than retyping it.
 */
export const NOT_MEASURED_CHECK_NAME = 'Copilot quality: not measured';

/** Measurements that publish the neutral check-run: every one except `judged`. */
export const NOT_MEASURED_STATES = Object.freeze(['deterministic-only', 'partial', 'none']);

/**
 * The Checks API body for the neutral not-measured check-run, or null when the
 * measurement is `judged` or unrecorded (no check-run is published then).
 * Throws on a head sha that is not 40 hex characters: a check-run attached to
 * the wrong commit is worse than none.
 */
export function notMeasuredCheckRun({ measurement, text, headSha }) {
  if (!NOT_MEASURED_STATES.includes(measurement)) return null;
  const sha = String(headSha ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new TypeError(`head sha is not a 40-character hex commit id: ${JSON.stringify(sha)}`);
  }
  const line =
    String(text ?? '').trim() ||
    `The evals job recorded the measurement \`${measurement}\` but no description of it.`;
  return {
    name: NOT_MEASURED_CHECK_NAME,
    head_sha: sha,
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: measurement === 'partial' ? 'Partially measured' : 'Not measured',
      summary:
        `**Judge measurement: ${measurement}.** ${line}\n\n` +
        'This check is informational. It is not a quality verdict and not a pass, and it does not change ' +
        'the conclusion of any other check on this commit.',
    },
  };
}

export function measurementBanner(m) {
  return `> **Eval measurement: ${m.measurement}.** ${describeMeasurement(m)}\n\n`;
}

/**
 * The report-outcome job-summary heading. `category` is run-outcome.mjs's
 * category for the evals job. A `success` is called PASS only when the judge
 * fully scored every probed surface AND the gate recorded that it enforced
 * (`reportedOnly === 'false'`; an unrecorded value is not PASS). `PASS` over a
 * run whose `judgeCoverage` was never recorded (`coverageUnknown`) is
 * qualified: the run is still PASS (the gate itself does not know coverage is
 * missing), but the heading says so rather than implying full coverage was
 * established. A `failure` is called a real verdict only over a judged run.
 * Everything else says what it actually was.
 */
export function outcomeLabel({ category, measurement, reportedOnly, gateRc, coverageUnknown }) {
  const what = 'Copilot quality evals';
  const m = MEASUREMENTS.includes(measurement) ? measurement : 'unrecorded';
  const rc = String(gateRc ?? '').trim() || 'unrecorded';
  const ro = String(reportedOnly ?? '').trim();
  const cu = String(coverageUnknown ?? '').trim() === 'true';
  if (category === 'failure') {
    if (m === 'judged') return `### ${what} — FAIL (a real verdict; see the eval job)`;
    if (m === 'partial') {
      return (
        `### ${what} — FAIL, PARTIALLY MEASURED (the judge did not fully score every surface, so this is not a ` +
        'full quality verdict: the failure may be a judge/measurement failure rather than a quality regression; ' +
        'the eval job names the surface that failed)'
      );
    }
    if (m === 'unrecorded') {
      return `### ${what} — FAIL (the eval job failed before a judge measurement was recorded; see the eval job)`;
    }
    return (
      `### ${what} — FAIL, NOT MEASURED (judge measurement: ${m}; the judge scored nothing, so this is a ` +
      'judge/measurement failure, not a judged quality verdict; see the eval job)'
    );
  }
  if (category !== 'success') return `### ${what} — NO VERDICT`;
  const reported = ro === 'true' ? ` — REPORTED, NOT ENFORCED (gate rc=${rc})` : '';
  if (m !== 'judged') {
    if (m === 'partial') {
      return `### ${what} — PARTIALLY MEASURED (the judge did not fully score every surface; see the eval summary)${reported}`;
    }
    return `### ${what} — NOT MEASURED (judge measurement: ${m}; the job is green because nothing was judged, not because quality passed)${reported}`;
  }
  if (ro === 'true') {
    return `### ${what} — REPORTED, NOT ENFORCED (gate rc=${rc}; an estate verdict, not a verdict on this diff)`;
  }
  if (ro !== 'false') {
    return `### ${what} — JUDGED, ENFORCEMENT UNRECORDED (gate rc=${rc}; the gate did not record whether it enforced, so this is not reported as PASS)`;
  }
  if (cu) {
    return `### ${what} — PASS (judge coverage not recorded by this evaluator; #4875)`;
  }
  return `### ${what} — PASS`;
}


function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--annotate' || a === '--label' || a === '--check-run') out.flags.add(a);
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`eval-measurement: ${e.message}`);
    return 2;
  }
  if (args.flags.has('--label')) {
    if (!args.category) {
      console.error('eval-measurement: --label needs --category');
      return 2;
    }
    console.log(
      outcomeLabel({
        category: args.category,
        measurement: args.measurement,
        reportedOnly: args['reported-only'],
        gateRc: args['gate-rc'],
        coverageUnknown: args['coverage-unknown'],
      }),
    );
    return 0;
  }
  if (args.flags.has('--check-run')) {
    let body;
    try {
      body = notMeasuredCheckRun({ measurement: args.measurement, text: args.text, headSha: args['head-sha'] });
    } catch (e) {
      console.error(`eval-measurement: ${e.message}`);
      return 2;
    }
    if (body === null) {
      console.error(
        `eval-measurement: --check-run is only for ${NOT_MEASURED_STATES.join(' / ')}; ` +
          `got ${JSON.stringify(args.measurement ?? '')}, so no check-run body was produced`,
      );
      return 2;
    }
    console.log(JSON.stringify(body));
    return 0;
  }
  if (!args.artifact) {
    console.error('eval-measurement: --artifact <eval-run.json> is required');
    return 2;
  }
  let m;
  try {
    m = classifyMeasurement(JSON.parse(readFileSync(args.artifact, 'utf-8')));
  } catch (e) {
    console.error(`eval-measurement: could not read a measurement from ${args.artifact}: ${e.message}`);
    return 2;
  }
  console.log(`eval measurement: ${describeMeasurement(m)}`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `measurement=${m.measurement}`,
        `total_surfaces=${m.totalSurfaces}`,
        `probed_surfaces=${m.probedSurfaces}`,
        `judged_surfaces=${m.judgedSurfaces}`,
        `total_questions=${m.totalQuestions}`,
        `judged_questions=${m.judgedQuestions}`,
        `coverage_unknown=${m.coverageUnknown}`,
        // One line by construction; newlines are folded anyway so a future
        // multi-line description cannot break the key=value output format.
        `measurement_text=${describeMeasurement(m).replace(/[\r\n]+/g, ' ')}`,
        '',
      ].join('\n'),
    );
  }
  if (args.flags.has('--annotate') && m.measurement !== 'judged') {
    console.log(`::warning::eval measurement: ${describeMeasurement(m)}`);
  }
  if (args['prepend-to']) {
    const file = args['prepend-to'];
    // Read-then-catch, not exists-then-read: an existence check followed by a
    // read is a file-system race (the file can change between the two). An
    // absent summary is the only error treated as "nothing to prepend to";
    // any other read failure propagates.
    let prior = '';
    try {
      prior = readFileSync(file, 'utf-8');
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    writeFileSync(file, measurementBanner(m) + prior);
  }
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
