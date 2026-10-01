#!/usr/bin/env node
/**
 * eval-measurement.mjs — did the Copilot quality-eval run JUDGE anything? (#4346)
 *
 * WHY THIS EXISTS
 * ---------------
 * The eval gate counted a surface as "measured" when it had `questions > 0`.
 * That is the number of questions the evaluator ASKED, not the number the
 * grounding judge SCORED. When the E2 judge's daily cap
 * (`LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP`) is spent, the evaluator still asks every
 * question, still computes a deterministic pass-rate, and then DEFERS the judge:
 * every surface comes back with `groundingAvg: null` and `passRate: null`.
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
 * THE JUDGED PREDICATE (load-bearing — read before editing)
 * ---------------------------------------------------------
 * A surface is JUDGED iff `questions > 0` AND `groundingAvg` is a finite number.
 *
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
 * MEASUREMENT STATES
 *   none                no surface asked a question
 *   deterministic-only  questions were asked, the judge scored NONE of them
 *   partial             the judge scored some surfaces and not others
 *   judged              the judge scored every surface that asked a question
 *
 * CLI
 *   node scripts/ci/eval-measurement.mjs --artifact eval-run.json
 *        [--annotate] [--prepend-to eval-summary.md]
 *     Prints one line; writes measurement / *_surfaces / *_questions to
 *     $GITHUB_OUTPUT when set; with --annotate emits a ::warning:: when the
 *     measurement is not `judged`; with --prepend-to puts the banner at the top
 *     of that file. Exit 0. A missing or unparseable artifact exits 2 — this
 *     module never reports a measurement it could not read.
 *
 *   node scripts/ci/eval-measurement.mjs --label --category <c>
 *        [--measurement <m>] [--reported-only true|false] [--gate-rc <n>]
 *     Prints the job-summary heading for the report-outcome job. LABELS only;
 *     it never changes a job conclusion.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEASUREMENTS = Object.freeze(['none', 'deterministic-only', 'partial', 'judged']);

const qs = (s) => {
  const n = Number(s?.questions);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** True iff the grounding judge produced a score for this surface. */
export function isJudgedSurface(s) {
  return qs(s) > 0 && typeof s?.groundingAvg === 'number' && Number.isFinite(s.groundingAvg);
}

/**
 * Classify a RunSummary. Throws on a receipt with no `surfaces` array — a
 * receipt this module cannot read is not a receipt that measured nothing.
 */
export function classifyMeasurement(run) {
  if (!run || !Array.isArray(run.surfaces)) {
    throw new TypeError('eval-run receipt has no `surfaces` array — cannot say what was measured');
  }
  const surfaces = run.surfaces;
  const scored = surfaces.filter((s) => qs(s) > 0);
  const judged = scored.filter(isJudgedSurface);
  const totalQuestions = scored.reduce((a, s) => a + qs(s), 0);
  const judgedQuestions = judged.reduce((a, s) => a + qs(s), 0);
  let measurement;
  if (scored.length === 0) measurement = 'none';
  else if (judged.length === 0) measurement = 'deterministic-only';
  else if (judged.length < scored.length) measurement = 'partial';
  else measurement = 'judged';
  return {
    measurement,
    totalSurfaces: surfaces.length,
    scoredSurfaces: scored.length,
    judgedSurfaces: judged.length,
    totalQuestions,
    judgedQuestions,
    unjudged: scored.filter((s) => !isJudgedSurface(s)).map((s) => String(s.surface ?? '?')),
  };
}

/** One human sentence. Never says "measured" for a run the judge did not score. */
export function describeMeasurement(m) {
  const counts = `the grounding judge scored ${m.judgedQuestions} of ${m.totalQuestions} question(s) asked, on ${m.judgedSurfaces} of ${m.scoredSurfaces} surface(s) that asked any (${m.totalSurfaces} in the receipt)`;
  switch (m.measurement) {
    case 'judged':
      return `JUDGED — ${counts}.`;
    case 'partial':
      return `PARTIALLY MEASURED — ${counts}. Not judged: ${m.unjudged.join(', ')}. Only the judged surfaces carry a quality result.`;
    case 'deterministic-only':
      return (
        `NOT MEASURED — ${counts}. The judge was deferred on every surface, so no grounding score or ` +
        'pass-rate exists for this run; only the deterministic pass-rate was computed, and it is not the ' +
        'quality bar. The receipt does not say WHY the judge deferred; the evaluator defers when its ' +
        'daily judge budget (LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP) is spent or no judge deployment is ' +
        'configured — see the evaluator job log for which.'
      );
    case 'none':
    default:
      return `NOT MEASURED — no surface asked a question (${m.totalSurfaces} surface(s) in the receipt).`;
  }
}

export function measurementBanner(m) {
  return `> **Eval measurement: ${m.measurement}.** ${describeMeasurement(m)}\n\n`;
}

/**
 * The report-outcome job-summary heading. `category` is run-outcome.mjs's
 * category for the evals job. A `success` is called PASS only when the judge
 * scored every surface AND the gate was enforcing. Everything else that ended
 * green says what it actually was.
 */
export function outcomeLabel({ category, measurement, reportedOnly, gateRc }) {
  const what = 'Copilot quality evals';
  if (category === 'failure') return `### ${what} — FAIL (a real verdict; see the eval job)`;
  if (category !== 'success') return `### ${what} — NO VERDICT`;
  if (measurement !== 'judged') {
    const m = MEASUREMENTS.includes(measurement) ? measurement : 'unrecorded';
    if (m === 'partial') {
      return `### ${what} — PARTIALLY MEASURED (the judge scored only some surfaces; see the eval summary)`;
    }
    return `### ${what} — NOT MEASURED (judge measurement: ${m}; the job is green because nothing was judged, not because quality passed)`;
  }
  if (String(reportedOnly) === 'true') {
    const rc = String(gateRc ?? '').trim() || 'unrecorded';
    return `### ${what} — REPORTED, NOT ENFORCED (gate rc=${rc}; an estate verdict, not a verdict on this diff)`;
  }
  return `### ${what} — PASS`;
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--annotate' || a === '--label') out.flags.add(a);
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
      }),
    );
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
        `scored_surfaces=${m.scoredSurfaces}`,
        `judged_surfaces=${m.judgedSurfaces}`,
        `total_questions=${m.totalQuestions}`,
        `judged_questions=${m.judgedQuestions}`,
        '',
      ].join('\n'),
    );
  }
  if (args.flags.has('--annotate') && m.measurement !== 'judged') {
    console.log(`::warning::eval measurement: ${describeMeasurement(m)}`);
  }
  if (args['prepend-to']) {
    const file = args['prepend-to'];
    const prior = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    writeFileSync(file, measurementBanner(m) + prior);
  }
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
