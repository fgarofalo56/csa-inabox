#!/usr/bin/env node
/**
 * deploy-fiab-gcch: a SCHEDULED run must never reach the approval-gated deploy
 * job (#4233).
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ────────────────────────────────────────
 * Before this change, `deploy-validate` (the only job carrying
 * `environment: gcc-high-deploy`) ran on EVERY trigger, schedule included, so
 * a daily cron run sat `waiting` at the required-reviewers gate exactly like
 * an operator dispatch would. Run 35234173588 (created 2026-09-17) held the
 * `deploy-fiab-gcch-schedule` concurrency group `waiting` at that gate for
 * ~12.7 days, and 12 scheduled runs created in that window queued at 0 jobs
 * and were silently dropped. The fix is a job-level `if:` on `deploy-validate`
 * that is FALSE whenever `github.event_name == 'schedule'`, so a scheduled run
 * never asks the environment for approval at all — deploys are dispatch-only.
 *
 * ── WHAT IS ASSERTED, AND WHAT VALUE WOULD BREAK EACH ASSERTION ────────────
 * 1. The `schedule:` trigger still exists under `on:`. Breaks if someone
 *    "fixes" the stacking by deleting the cron instead of gating the job
 *    (the operator decision for #4233 is explicit: KEEP the trigger).
 * 2. Every job in this workflow that carries an `environment:` key has a
 *    job-level `if:` that CANNOT be true while `github.event_name == 'schedule'`
 *    — checked as a semantic property (guardIsBinding), not a substring, for
 *    the reason gcch-standdown-completeness.test.mjs's round 4 and round 8
 *    notes record: GitHub binds `&&` tighter than `||`, so a guard written as
 *
 *      A || B && github.event_name != 'schedule'
 *
 *    parses as `A || (B && GUARD)` — inert whenever `A` alone is true on
 *    `schedule` — and a guard nested one level deeper inside a disjunct
 *      (B || GUARD) && C
 *    is just as dead. Both shapes are MEASURED below to turn this suite RED;
 *    only `GUARD && (A || B)` (the guard as a conjunct of the WHOLE
 *    expression, which is what deploy-fiab-gcch.yml ships) passes.
 * 3. There is at least one such job. A parser that silently finds zero gated
 *    jobs would make assertion 2 pass VACUOUSLY — the exact "a complete
 *    enumeration of the wrong set reads exactly like a complete enumeration"
 *    shape gcch-standdown-completeness.test.mjs was built against. Breaks if
 *    the `environment:` key is removed from every job (which would also
 *    defeat the approval gate entirely — a change that SHOULD be caught
 *    here).
 *
 * The boolean-expression helpers (`blankLiterals`, `splitTopLevel`,
 * `stripWrapper`, `isFullyParenthesised`, `satisfiableWithoutGuard`,
 * `guardIsBinding`) are intentionally DUPLICATED from
 * gcch-standdown-completeness.test.mjs rather than imported: importing a
 * sibling `*.test.mjs` would register its ~60 tests under this file's run
 * every time `node --test` executes this file directly, coupling two suites
 * that should stay independent. The logic is unchanged from that file's
 * round-4/round-8 hardened form.
 *
 * ── MUTATION, RUN AGAINST A SANDBOX COPY (assertion-design.md) ─────────────
 * `LOOM_GCCH_WORKFLOW_PATH` overrides the workflow read, exactly as the
 * sibling suite's seam does, so the RED half is reproducible without touching
 * the tracked file:
 *   cp .github/workflows/deploy-fiab-gcch.yml /tmp/mut.yml
 *   sed -i "s/always() && github.event_name != 'schedule' && /always() \&\& /" /tmp/mut.yml
 *   LOOM_GCCH_WORKFLOW_PATH=/tmp/mut.yml node --test <this file>   # RED
 *
 * Run: node --test scripts/ci/__tests__/gcch-schedule-preflight-only.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapKeys, parseWorkflow, scalarValue } from '../_workflow-yaml.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_WF = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-gcch.yml');

/** The property every gated job's `if:` must guarantee. */
const SCHEDULE_GUARD = "github.event_name != 'schedule'";

function workflowText() {
  // NORMALISED. `.github/workflows/**` is checked in CRLF here, and a
  // `\n`-anchored regex silently matches nothing against raw CRLF bytes — a
  // guard that reads "compliant" because it found no lines at all.
  return readFileSync(process.env.LOOM_GCCH_WORKFLOW_PATH || DEFAULT_WF, 'utf8').replace(/\r\n/g, '\n');
}

// ── Duplicated from gcch-standdown-completeness.test.mjs (see header) ──────

function blankLiterals(expr) {
  let out = '';
  let inStr = false;
  for (const c of String(expr)) {
    if (c === "'") {
      inStr = !inStr;
      out += c;
      continue;
    }
    out += inStr && '()|&'.includes(c) ? '_' : c;
  }
  return out;
}

function splitTopLevel(expr, op) {
  const src = String(expr).trim();
  const scan = blankLiterals(src);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < scan.length; i += 1) {
    const c = scan[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && c === op && scan[i + 1] === op) {
      parts.push(src.slice(start, i));
      i += 1;
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function stripWrapper(expr) {
  return String(expr)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
}

function isFullyParenthesised(t) {
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  const scan = blankLiterals(t);
  let depth = 0;
  for (let i = 0; i < scan.length; i += 1) {
    if (scan[i] === '(') depth += 1;
    else if (scan[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === scan.length - 1;
    }
  }
  return false;
}

/**
 * Is there a truth assignment that satisfies `expr` with `guard` FALSE?
 * Maximally permissive on unrecognised atoms (assumed TRUE), so the caller
 * fails closed rather than passing on a parse it does not understand.
 */
function satisfiableWithoutGuard(expr, guard) {
  const src = stripWrapper(expr);
  if (src.length === 0) return true;
  const ors = splitTopLevel(src, '|');
  if (ors.length > 1) return ors.some((o) => satisfiableWithoutGuard(o, guard));
  const ands = splitTopLevel(src, '&');
  if (ands.length > 1) return ands.every((a) => satisfiableWithoutGuard(a, guard));
  let t = src;
  let negated = false;
  while (t.startsWith('!')) {
    negated = !negated;
    t = t.slice(1).trim();
  }
  if (isFullyParenthesised(t)) return negated !== satisfiableWithoutGuard(t.slice(1, -1), guard);
  return negated !== !t.includes(guard);
}

/** Is `guard` NECESSARY for `ifExpr` to be true? */
function guardIsBinding(ifExpr, guard) {
  if (!String(ifExpr).includes(guard)) return false;
  return !satisfiableWithoutGuard(ifExpr, guard);
}

// ── Workflow-specific parsing ───────────────────────────────────────────────

/**
 * Every top-level job: `{ name, if, hasEnvironment }`.
 *
 * Built on the repo's shared `_workflow-yaml.mjs` block-structure reader
 * (already used by scripts/ci/__tests__/deploy-staleness.test.mjs and the
 * `check-workflow-*.mjs` guards) rather than a bespoke regex scan — real block
 * structure, not indentation columns this file would have to re-derive, and
 * comments are stripped by the shared reader rather than by a second regex
 * that could disagree with it. `environment:` is detected as a KEY PRESENT on
 * the job mapping, which is true whether it is written as the scalar form
 * this workflow uses (`environment: gcc-high-deploy`) or the mapping form
 * (`environment:\n  name: …`) — so a future switch of form is still
 * recognised as "uses the gated environment" rather than silently falling out
 * of scope.
 *
 * @param {string} src
 * @returns {{name:string, if:string, hasEnvironment:boolean}[]}
 */
export function parseJobs(src) {
  const doc = parseWorkflow(src);
  const jobsNode = doc.jobs;
  assert.ok(jobsNode && typeof jobsNode === 'object' && !('v' in jobsNode), 'no top-level `jobs:` mapping found in the workflow');
  return Object.entries(jobsNode).map(([name, job]) => ({
    name,
    if: scalarValue(job?.if) ?? '',
    hasEnvironment: Boolean(job && typeof job === 'object' && Object.prototype.hasOwnProperty.call(job, 'environment')),
  }));
}

/** Does `on:` declare a `schedule:` trigger? */
export function hasScheduleTrigger(src) {
  const doc = parseWorkflow(src);
  // YAML reserves bare `on` as a boolean-ish key in older specs, and GitHub's
  // own parser is lenient about it, but this repo's workflows all write it as
  // the plain string `on:` — mapKeys would return [] for a non-mapping node,
  // which is exactly the fail-closed behaviour wanted if that ever changes.
  return mapKeys(doc.on).includes('schedule');
}

test('on: still declares a schedule trigger (#4233 — operator decision: keep it)', () => {
  assert.ok(hasScheduleTrigger(workflowText()), 'the `schedule:` trigger was removed from `on:` — the settled #4233 decision is to KEEP it and gate the approval-gated job instead');
});

test('at least one job carries the gated environment (a zero-match parse would make the next test vacuous)', () => {
  const gated = parseJobs(workflowText()).filter((j) => j.hasEnvironment);
  assert.ok(gated.length > 0, 'no job in deploy-fiab-gcch.yml was parsed as carrying an `environment:` key — either the approval gate was removed entirely, or this parser no longer recognises it. Either way the guard below has nothing to check, which is a silent pass, not a clean one');
});

test('every job using the gated environment has a job-level if: that is false on schedule', () => {
  const jobs = parseJobs(workflowText());
  const gated = jobs.filter((j) => j.hasEnvironment);
  const problems = [];
  for (const job of gated) {
    if (!guardIsBinding(job.if, SCHEDULE_GUARD)) {
      problems.push(
        `job '${job.name}' carries the gated environment, but its if: (\`${job.if || '(none)'}\`) does not ` +
          `guarantee \`${SCHEDULE_GUARD}\` — there is a truth assignment where the job runs on a SCHEDULED ` +
          'trigger, which re-opens #4233: the job asks its environment for approval, sits `waiting`, and holds ' +
          'the concurrency group exactly as run 35234173588 did for 12.7 days.',
      );
    }
  }
  assert.deepEqual(problems, []);
});

// ── Unit coverage for the two GitHub-precedence bypasses the suite above
//    exists to catch (named in the header, measured here directly) ─────────

test('guardIsBinding: a guard nested one disjunct away from the top is INERT (GH && binds tighter than ||)', () => {
  // Breaks on exactly the shape a reviewer could "simplify" the fix into:
  // composing with the EXISTING `(schedule || full)` by appending `&& GUARD`
  // to only the right-hand disjunct instead of wrapping the whole expression.
  const mutant = `always() && (github.event_name == 'schedule' || inputs.run_mode == 'full' && ${SCHEDULE_GUARD})`;
  assert.equal(guardIsBinding(mutant, SCHEDULE_GUARD), false, 'this expression IS satisfiable with the guard false (take the left disjunct), so guardIsBinding must report it as non-binding — if it reports true here, the inert-guard bypass is undetectable');
});

test('guardIsBinding: the guard as a top-level conjunct of the whole expression is binding', () => {
  const real = `always() && ${SCHEDULE_GUARD} && needs.precheck.outputs.configured == 'true'`;
  assert.equal(guardIsBinding(real, SCHEDULE_GUARD), true, 'this is the exact shape deploy-fiab-gcch.yml ships for deploy-validate; if this returns false the helper itself is broken, not the workflow');
});
