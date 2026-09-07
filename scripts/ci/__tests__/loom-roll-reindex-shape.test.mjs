#!/usr/bin/env node
/**
 * The live roll lane must refresh the loom-docs index — and must do it WITHOUT
 * corrupting the one signal that says whether the estate got rolled (#4276).
 *
 * WHAT WAS MEASURED, AND WHY A GUARD RATHER THAN A COMMENT.
 * `.github/workflows/loom-roll-and-validate.yml` is the roll that actually
 * runs: it is `workflow_run`-triggered off build-fiab-images-acr-tasks and
 * rolls loom-console on every merge. Before the change this file guards,
 * `grep -c reindex` over its 1743 lines returned 0. The only roll workflow that
 * DID reindex is console-bluegreen-roll.yml:677, whose last four runs are all
 * `failure` (newest 30635466301, 2026-07-31). So every new image carried a new
 * docs corpus to the estate while the index over that corpus was refreshed only
 * by a nightly schedule, if at all — the stale-index condition that
 * copilot-quality-evals then measures and fails PRs on (#3472).
 *
 * The fix is easy to write and easy to write WRONG in a way nothing would
 * notice, which is what the controls below are for. Every one of them is chosen
 * to die under a specific mutation of the SHIPPING file — the fixtures are
 * string surgery on the real workflow text, not invented YAML, so a fixture
 * that agreed with a broken guard would still have to agree with what ships:
 *
 *   - delete the reindex entirely -> `missing-caller`. This is the pre-fix head
 *     shape, so this control is the RED->GREEN receipt for the change itself.
 *   - move the reindex INSIDE the roll job, i.e. the shape the
 *     console-bluegreen-roll copy uses -> `caller-inside-contract-job`. That
 *     copy is safe THERE because console-bluegreen-roll.yml is not one of
 *     reconcile-policy's CONSOLE_ROLL_SOURCES. Here it is not: a failed reindex
 *     would flip the conclusion of the job named `Roll image + validate live
 *     URL`, and `selectLastConsoleRoll` keeps only runs whose jobConclusion is
 *     'success' while deploy-fiab-commercial.yml's post-apply gate asks for
 *     that job by name. Both would then report that a roll which DID ship the
 *     image shipped nothing. The job name this control keys on is IMPORTED from
 *     the shipping table rather than spelled here, so the two cannot drift.
 *   - drop the needs/if gate -> `caller-not-gated-on-roll`: a run whose gate
 *     refused to roll (run 32006479915 concluded `success` having rolled
 *     nothing) would reindex anyway and report on an estate it never touched.
 *   - point CONSOLE_URL at a repo variable instead of the URL this run actually
 *     probed -> `console-url-not-from-roll`: reindexing a console the run never
 *     established is deploy-integrity R7 inside the fix itself.
 *   - keep the reference but delete the job output it reads ->
 *     `console-url-output-undeclared`. This is the present-but-inert shape: the
 *     expression resolves to empty, and nothing in YAML or actionlint says so.
 *   - downgrade FATAL to 'false' -> `fatal-downgraded`: the shared driver's
 *     documented non-blocking caller is the post-deploy bootstrap and only it.
 *   - make the rollback key on the reindex -> `rollback-keys-on-reindex`: a
 *     stale index is not evidence the new revision is bad, and reverting a
 *     healthy revision over it is a cure worse than the disease.
 *   - set the job timeout BELOW the poll budget -> `timeout-below-poll-budget`:
 *     the runner would cancel the poll mid-flight and the run would report a
 *     cancellation instead of the script's honest verdict.
 *
 * The invoked script is also checked to EXIST on disk, because a guard that
 * only greps YAML passes a path typo that fails at runtime.
 *
 * Run: node --test scripts/ci/__tests__/loom-roll-reindex-shape.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWorkflow, mapKeys, scalarValue } from '../_workflow-yaml.mjs';
// The SHIPPING table that says which job conclusion answers "did the estate get
// rolled?" — imported so the anti-collision control below is bound to it.
import { CONSOLE_ROLL_SOURCES } from '../reconcile-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW = 'loom-roll-and-validate.yml';
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', WORKFLOW);

/** The shared driver every reindex call site must go through (#2929). */
const DRIVER = 'scripts/ci/reindex-loom-docs.sh';

/** The job whose conclusion downstream gates read, per the shipping table. */
const CONTRACT_JOB_NAME = CONSOLE_ROLL_SOURCES.find((s) => s.workflow === WORKFLOW)?.jobPattern;

const SHIPPING = readFileSync(WORKFLOW_PATH, 'utf8');

/* ── the analyzer ─────────────────────────────────────────────────────────── */

const val = (node) => (node === undefined || node === null ? null : scalarValue(node));
const keys = (node) => (node && typeof node === 'object' ? mapKeys(node) : []);

/** `needs:` is either a scalar or a sequence; normalise to a list of job ids. */
function needsList(job) {
  const n = job?.needs;
  if (!n) return [];
  if (Array.isArray(n)) return n.map((x) => val(x)).filter(Boolean);
  const one = val(n);
  return one ? [one] : [];
}

/**
 * Read the wiring the roll lane must have, and say what is wrong with it.
 *
 * Returns `{ problems: string[], callers, contractJobId }`. `problems` carries
 * stable slugs so a control asserts the SPECIFIC defect it drove, not merely
 * "something failed" — a guard that collapses every mutation onto one message
 * cannot tell a real regression from a typo in its own fixture.
 */
export function analyzeReindexWiring(text) {
  const doc = parseWorkflow(text);
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
  const problems = [];

  // Which job carries the name downstream gates read?
  const contractJobId =
    keys(jobs).find((id) => val(jobs[id]?.name) === CONTRACT_JOB_NAME) ?? null;
  if (!contractJobId) {
    problems.push('contract-job-missing');
    return { problems, callers: [], contractJobId };
  }

  // Every step in every job that invokes the shared reindex driver.
  const callers = [];
  for (const jobId of keys(jobs)) {
    const job = jobs[jobId];
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    for (const step of steps) {
      const run = String(val(step?.run) ?? '');
      if (run.includes(DRIVER)) callers.push({ jobId, job, step, run });
    }
  }
  if (callers.length === 0) {
    problems.push('missing-caller');
    return { problems, callers, contractJobId };
  }

  for (const caller of callers) {
    const { jobId, job, step } = caller;

    // 1. Never inside the job whose conclusion answers "did the estate roll?".
    if (jobId === contractJobId) problems.push('caller-inside-contract-job');

    // 2. Gated on the roll having actually happened.
    const gatedByNeeds = needsList(job).includes(contractJobId);
    const cond = String(val(job?.if) ?? '');
    const gatedByIf = cond.includes(`needs.${contractJobId}.result`) && cond.includes("'success'");
    if (!gatedByNeeds || !gatedByIf) problems.push('caller-not-gated-on-roll');

    // 3. CONSOLE_URL is the URL this run rolled, published by the roll job.
    const env = step?.env;
    const consoleUrl = String(val(env?.CONSOLE_URL) ?? '');
    const m = consoleUrl.match(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/);
    if (!m || m[1] !== contractJobId) {
      problems.push('console-url-not-from-roll');
    } else if (!keys(jobs[m[1]]?.outputs).includes(m[2])) {
      // Present but inert: the expression resolves to empty and YAML is happy.
      problems.push('console-url-output-undeclared');
    }

    // 4. FATAL stays at its default. Only the post-deploy bootstrap may be
    //    non-blocking; the driver's own header says so.
    const fatal = String(val(env?.FATAL) ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (fatal && fatal !== 'true') problems.push('fatal-downgraded');

    // 5. The job's wall-clock bound must exceed the poll budget it wraps, or
    //    the runner kills the poll and reports a cancellation instead of a
    //    verdict.
    const pollS = Number(String(val(env?.POLL_TIMEOUT_S) ?? '900').replace(/['"]/g, ''));
    const timeoutMin = Number(String(val(job?.['timeout-minutes']) ?? '').replace(/['"]/g, ''));
    if (Number.isFinite(timeoutMin) && timeoutMin > 0 && timeoutMin * 60 <= pollS) {
      problems.push('timeout-below-poll-budget');
    }
  }

  // 6. The rollback must not key on the reindex. Reverting a healthy revision
  //    because an index went stale is the cure being worse than the disease.
  const rollbackStep = (jobs[contractJobId]?.steps ?? []).find((s) =>
    String(val(s?.name) ?? '').toLowerCase().startsWith('rollback'),
  );
  if (rollbackStep && String(val(rollbackStep.if) ?? '').includes('reindex')) {
    problems.push('rollback-keys-on-reindex');
  }

  return { problems, callers, contractJobId };
}

/* ── fixtures: string surgery on the SHIPPING text ─────────────────────────── */

/** Everything from the reindex job header to EOF — the whole added job. */
const JOB_HEADER = '\n  reindex-loom-docs:\n';
const jobStart = () => {
  const i = SHIPPING.indexOf(JOB_HEADER.replace(/\n/g, '\r\n'));
  return i >= 0 ? { i, nl: '\r\n' } : { i: SHIPPING.indexOf(JOB_HEADER), nl: '\n' };
};

/** The pre-fix head shape: the lane with no reindex job at all. */
function withoutReindexJob() {
  const { i } = jobStart();
  assert.ok(i > 0, 'the shipping lane must contain the reindex job for this fixture to mean anything');
  // Cut back to the start of its leading comment block so the fixture is a
  // clean workflow rather than a job body with orphaned comments.
  const head = SHIPPING.slice(0, i);
  const lastBlank = head.lastIndexOf('\n\n');
  return SHIPPING.slice(0, lastBlank > 0 ? lastBlank : i);
}

/** Move the reindex step into the roll job, the console-bluegreen-roll shape. */
function reindexInsideRollJob() {
  const { nl } = jobStart();
  const stepBlock = [
    '      - name: Reindex loom-docs + wait for cross-replica freshness',
    '        env:',
    '          CONSOLE_URL: ${{ steps.vars.outputs.url }}',
    '          INTERNAL_TOKEN: ${{ secrets.LOOM_INTERNAL_TOKEN }}',
    '          POLL_TIMEOUT_S: \'900\'',
    '        run: bash scripts/ci/reindex-loom-docs.sh',
    '',
  ].join(nl);
  const anchor = `      - name: Rollback on validation failure`;
  const idx = withoutReindexJob().indexOf(anchor);
  assert.ok(idx > 0, 'the Rollback step is the splice anchor');
  const base = withoutReindexJob();
  return base.slice(0, idx) + stepBlock + base.slice(idx);
}

const swap = (from, to) => {
  assert.ok(SHIPPING.includes(from), `fixture anchor not found: ${from}`);
  return SHIPPING.replace(from, to);
};

const dropLineContaining = (needle) => {
  const lines = SHIPPING.split('\n');
  const kept = lines.filter((l) => !l.includes(needle));
  assert.equal(kept.length, lines.length - 1, `expected exactly one line containing ${needle}`);
  return kept.join('\n');
};

/* ── controls ─────────────────────────────────────────────────────────────── */

test('the shipping roll lane wires the reindex, and wires it correctly', () => {
  const { problems, callers, contractJobId } = analyzeReindexWiring(SHIPPING);
  assert.deepEqual(problems, [], `loom-roll-and-validate.yml wiring problems: ${problems.join(', ')}`);
  assert.equal(callers.length, 1, 'exactly one reindex call site in this lane');
  assert.notEqual(callers[0].jobId, contractJobId);
});

test('the driver the lane invokes actually exists on disk', () => {
  // A YAML-only guard passes a path typo that fails at runtime.
  assert.ok(existsSync(join(REPO_ROOT, DRIVER)), `${DRIVER} must exist`);
  assert.ok(analyzeReindexWiring(SHIPPING).callers[0].run.includes(DRIVER));
});

test('the contract job name is read from the shipping table, not spelled here', () => {
  // If reconcile-policy stops naming this workflow, this guard is measuring
  // nothing and must say so rather than passing vacuously.
  assert.equal(typeof CONTRACT_JOB_NAME, 'string');
  assert.ok(CONTRACT_JOB_NAME.length > 0);
  assert.equal(analyzeReindexWiring(SHIPPING).contractJobId, 'roll-and-validate');
});

test('MUTATION: no reindex at all (the pre-fix head shape) is caught', () => {
  const { problems } = analyzeReindexWiring(withoutReindexJob());
  assert.ok(problems.includes('missing-caller'), problems.join(','));
});

test('MUTATION: the reindex inside the roll job is caught', () => {
  // Safe in console-bluegreen-roll (not a CONSOLE_ROLL_SOURCE); here it would
  // make a failed reindex read as "the estate was never rolled".
  const { problems } = analyzeReindexWiring(reindexInsideRollJob());
  assert.ok(problems.includes('caller-inside-contract-job'), problems.join(','));
});

test('MUTATION: an ungated reindex job is caught', () => {
  const text = swap(
    "    if: ${{ needs.roll-and-validate.result == 'success' }}\r\n",
    '',
  );
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('caller-not-gated-on-roll'), problems.join(','));
});

test('MUTATION: CONSOLE_URL from a repo variable instead of the rolled URL is caught', () => {
  const text = swap(
    'CONSOLE_URL: ${{ needs.roll-and-validate.outputs.console_url }}',
    "CONSOLE_URL: ${{ vars.LOOM_VERIFY_URL || 'https://csa-loom.limitlessdata.ai' }}",
  );
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('console-url-not-from-roll'), problems.join(','));
});

test('MUTATION: a CONSOLE_URL reference whose job output was deleted is caught', () => {
  // The present-but-inert shape: valid YAML, valid expression syntax, resolves
  // to an empty string, and only the driver's fail-closed would ever say so.
  const text = dropLineContaining('console_url: ${{ steps.vars.outputs.url }}');
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('console-url-output-undeclared'), problems.join(','));
});

test('MUTATION: FATAL downgraded to false is caught', () => {
  const text = swap(
    "          POLL_TIMEOUT_S: '900'",
    "          FATAL: 'false'\r\n          POLL_TIMEOUT_S: '900'",
  );
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('fatal-downgraded'), problems.join(','));
});

test('MUTATION: a rollback that keys on the reindex is caught', () => {
  const text = swap(
    "steps.validate.outcome == 'failure' || steps.uat.outcome == 'failure' ||",
    "steps.validate.outcome == 'failure' || steps.uat.outcome == 'failure' ||\r\n           needs.reindex-loom-docs.result == 'failure' ||",
  );
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('rollback-keys-on-reindex'), problems.join(','));
});

test('MUTATION: a job timeout shorter than the poll budget is caught', () => {
  const text = swap('    timeout-minutes: 25', '    timeout-minutes: 5');
  const { problems } = analyzeReindexWiring(text);
  assert.ok(problems.includes('timeout-below-poll-budget'), problems.join(','));
});
