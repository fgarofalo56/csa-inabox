#!/usr/bin/env node
/**
 * deploy-fiab-gcch: a DECLARED-PAUSED run must stand down COMPLETELY. (refs #4233)
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ────────────────────────────────────────
 * The stand-down was PARTIAL. `Estate is DECLARED paused — this run measures
 * nothing` printed "This run is UNMEASURED, not clean", `Bicep what-if` and
 * `Provision` skipped on `steps.adx_preflight.outputs.estate_paused != 'true'`
 * — and three later steps were gated ONLY on `schedule || run_mode == 'full'`,
 * so they ran anyway. Run 33519232492 (2026-09-01) is the receipt:
 *
 *   ADX preflight                     success   estate_paused=true
 *   Estate is DECLARED paused         success   "UNMEASURED, not clean"
 *   Bicep what-if                     skipped
 *   Image preflight — Gov ACR …       success   ← opened the sovereign ACR firewall
 *   Image-tag revert gate             FAILURE   ← the run went red here
 *   Re-pin appImageTags               skipped   (only because the job had failed)
 *   Provision                         skipped
 *
 * So a run that declared it would measure nothing MUTATED the estate (the ACR
 * lease sets publicNetworkAccess=Enabled) and then failed. That is both halves
 * of deploy-integrity R7: the summary asserted something the run did not do,
 * and the red asserted a deploy problem on a deploy that never happened.
 *
 * ── WHY A DISPOSITION TABLE AND NOT A REGEX COUNT ──────────────────────────
 * scripts/ci/__tests__/estate-preflight.test.mjs already counts step-level
 * gates (`stepGates.length >= 3`). A COUNT cannot see the defect: at the head
 * this file was written against, three gates existed and three steps were
 * unguarded, and the count was satisfied. Population accounting is the fix —
 * EVERY step after the declaration is named below with a disposition, and an
 * unlisted step FAILS. A new step cannot slip past by being new.
 *
 * ── ROUND 2: THE POPULATION WAS THE WRONG POPULATION ───────────────────────
 * The first version of this file accounted for every STEP of `deploy-validate`
 * and then asserted, in the run summary, that the stand-down was complete. It
 * was not. `build-gov-images` is a separate JOB with no `estate_paused` clause
 * and no approval environment, and it calls gov-provision-streaming-migrate.yml
 * in `build-only` mode, which acquires the ACR firewall lease
 * (`publicNetworkAccess=Enabled` on the sovereign GCC-High registry) and
 * `az acr build`s loom-migrate + loom-risingwave into it. Measured on the
 * declared-paused schedule:
 *
 *   run 34138038567 (2026-09-07)  Build both images on the Gov ACR      success
 *                                 Release the ACR firewall lease        success
 *   run 33111419147 (2026-08-27)  same two steps                        success
 *
 * A step census cannot see a job. So `judgeJobs` accounts for the JOB
 * population too, and `build-gov-images` now carries the declaration-only gate
 * from the `pause-declaration` job. The lesson is the one this repo keeps
 * relearning: a complete enumeration of the wrong set reads exactly like a
 * complete enumeration.
 *
 * ── SEAM ───────────────────────────────────────────────────────────────────
 * LOOM_GCCH_WORKFLOW_PATH overrides the workflow read, so the RED half of this
 * ratchet is reproducible against any commit:
 *   git show <sha>:.github/workflows/deploy-fiab-gcch.yml > /tmp/head.yml
 *   LOOM_GCCH_WORKFLOW_PATH=/tmp/head.yml node --test <this file>
 *
 * Run: node --test scripts/ci/__tests__/gcch-standdown-completeness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, loadRegister, parseArgs } from '../estate-pause-declared.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_WF = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-gcch.yml');

/** The estate-pause stand-down clause, verbatim. */
const GUARD = "steps.adx_preflight.outputs.estate_paused != 'true'";
/** The JOB-level clause, which reads the declaration alone (no Azure). */
const JOB_GUARD = "needs.pause-declaration.outputs.declared != 'true'";
/** The declaration step every disposition below is measured relative to. */
const DECLARATION_STEP = 'Estate is DECLARED paused — this run measures nothing';

function workflowText() {
  // NORMALISED. `.github/workflows/**` is checked in CRLF here (measured: 1544
  // CRLF, 0 bare LF), and a `\n`-anchored regex silently matches nothing
  // against it — a guard that reads as "compliant" because it found no lines
  // at all is the shape this repo keeps re-finding.
  return readFileSync(process.env.LOOM_GCCH_WORKFLOW_PATH || DEFAULT_WF, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Steps of the `deploy-validate` job, in order.
 *
 * Hand-rolled because this repo's `node --test scripts/ci/__tests__/*.test.mjs`
 * lane (loom-guardrails.yml) runs on a bare node with no dependency install —
 * there is no YAML parser to import. Indentation is fixed and asserted: steps
 * are `      - name:` (6) and their keys `        <key>:` (8). Comment lines
 * are dropped FIRST, because this workflow quotes old `if:` conditions inside
 * its own comment blocks and a naive scan would read one as live config (the
 * exact false positive recorded in check-required-lane-concurrency.mjs).
 *
 * @param {string} src
 * @returns {{name:string, if:string, body:string}[]}
 */
export function parseSteps(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => /^  deploy-validate:\s*$/.test(l));
  assert.ok(start >= 0, 'deploy-validate job not found');
  let i = lines.findIndex((l, n) => n > start && /^    steps:\s*$/.test(l));
  assert.ok(i > start, 'deploy-validate has no steps: block');

  const steps = [];
  let cur = null;
  for (i += 1; i < lines.length; i += 1) {
    const raw = lines[i];
    // A line at 2-space indent that is not blank ends the job.
    if (/^ {0,3}\S/.test(raw)) break;
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const stepStart = raw.match(/^ {6}- (?:name: (.*)|(uses|id|if|run): .*)$/);
    if (/^ {6}- /.test(raw)) {
      if (cur) steps.push(cur);
      cur = { name: stepStart && stepStart[1] ? stepStart[1].trim() : '(unnamed)', if: '', body: raw };
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {8}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
  }
  if (cur) steps.push(cur);
  return steps;
}

/**
 * Top-level jobs, in order, with their `if:` and `needs:` as written.
 *
 * A STEP census could never have caught the round-2 defect: `build-gov-images`
 * is a JOB, it is not inside `deploy-validate`, and it opened the sovereign ACR
 * firewall on every declared-paused scheduled run while the step census said the
 * stand-down was complete. The population being accounted for has to be BOTH.
 *
 * Same hand-rolled parse as parseSteps, same reason (no YAML parser on the
 * `node --test` lane). Jobs are `  <name>:` at 2-space indent inside `jobs:`.
 *
 * @param {string} src
 * @returns {{name:string, if:string, needs:string, body:string}[]}
 */
export function parseJobs(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no top-level jobs: block');
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\S/.test(raw)) break; // back to column 0 => out of `jobs:`
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const head = raw.match(/^ {2}([\w-]+):\s*$/);
    if (head) {
      if (cur) jobs.push(cur);
      cur = { name: head[1], if: '', needs: '', body: raw };
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {4}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
    const needsKey = raw.match(/^ {4}needs: (.*)$/);
    if (needsKey) cur.needs = needsKey[1].trim();
  }
  if (cur) jobs.push(cur);
  return jobs;
}

/**
 * Disposition for EVERY top-level job.
 *
 *   'job-guard'  — must carry JOB_GUARD (the declaration-only clause) in `if:`.
 *   'out-guard'  — must carry the `deploy-validate` estate_paused OUTPUT clause.
 *   'internal'   — stands down step-by-step; DISPOSITIONS below is its census.
 *   'exempt'     — reaches no estate resource, with the reason recorded.
 */
const JOB_DISPOSITIONS = new Map([
  [
    'precheck',
    {
      mode: 'exempt',
      why: 'tests four repository secrets for emptiness. No checkout, no network, no az — and it is the gate every other job reads, so adding a failure surface to it would take the lane down for an unrelated reason.',
    },
  ],
  [
    'pause-declaration',
    {
      mode: 'exempt',
      why: 'IS the declaration gate. scripts/ci/estate-pause-declared.mjs is a checkout + a pure file read; _estate-pause-declaration.mjs has no az, fetch, https or child_process. Gating it on itself is not a thing.',
    },
  ],
  ['build-gov-images', { mode: 'job-guard' }],
  [
    'deploy-validate',
    {
      mode: 'internal',
      why: 'runs on always() because it owns the stand-down summary; every one of its steps after the declaration is dispositioned in DISPOSITIONS.',
    },
  ],
  ['post-deploy-bootstrap', { mode: 'out-guard' }],
]);

/**
 * @param {{name:string, if:string, needs:string}[]} jobs
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judgeJobs(jobs) {
  const problems = [];
  for (const job of jobs) {
    const d = JOB_DISPOSITIONS.get(job.name);
    if (!d) {
      problems.push(
        `job '${job.name}' has no disposition. A new job in this workflow runs on the declared-paused schedule ` +
          `unless it says otherwise — add it to JOB_DISPOSITIONS, or gate it on \`${JOB_GUARD}\`.`,
      );
      continue;
    }
    if (d.mode === 'job-guard') {
      if (!job.if.includes(JOB_GUARD)) {
        problems.push(
          `job '${job.name}' must carry \`${JOB_GUARD}\` in its if: — it MUTATES the sovereign estate ` +
            '(ACR firewall lease + az acr build) and runs before the approval gate. Its if: is ' +
            `\`${job.if || '(none)'}\``,
        );
      }
      if (!/pause-declaration/.test(job.needs)) {
        problems.push(
          `job '${job.name}' reads needs.pause-declaration but does not declare it in needs: — the expression ` +
            `would evaluate to empty and never suppress. Its needs: is \`${job.needs || '(none)'}\``,
        );
      }
    }
    if (d.mode === 'out-guard' && !job.if.includes("needs.deploy-validate.outputs.estate_paused != 'true'")) {
      problems.push(
        `job '${job.name}' must carry \`needs.deploy-validate.outputs.estate_paused != 'true'\` in its if: — ` +
          `found \`${job.if || '(none)'}\``,
      );
    }
  }
  return problems;
}

/**
 * Disposition for EVERY step that follows the declaration step.
 *
 *   'guard'          — must carry GUARD in its own `if:`.
 *   'refuse'         — must NOT skip; must fail loudly on a paused estate.
 *                      Used only for Teardown: skipping a requested teardown
 *                      would leave the operator believing a sovereign estate
 *                      was destroyed when it was not.
 *   'via-provision'  — cannot run when `Provision` skipped, because its own
 *                      condition reads a Provision result. Transitively guarded.
 *   'exempt'         — touches no estate resource. Reason recorded, and the
 *                      reason is the point: an exemption with no reason is how
 *                      this table would rot into an allowlist.
 */
const DISPOSITIONS = new Map([
  ['Bicep what-if', { mode: 'guard' }],
  ['Deploy-verification evidence receipt (§7)', { mode: 'guard' }],
  ['Upload GCC-High verification receipt', { mode: 'guard' }],
  ['Image preflight — Gov ACR must already hold every referenced tag', { mode: 'guard' }],
  ['Image-tag revert gate — never flatten a pinned app to the default', { mode: 'guard' }],
  ['Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)', { mode: 'guard' }],
  ['Provision (with full Gov dispatch)', { mode: 'guard' }],
  [
    'Apply ACR compliance tags (merge-patch, out-of-band — #3714)',
    { mode: 'via-provision', needle: "steps.provision.conclusion == 'success'" },
  ],
  ['Approve the Front Door -> ACA private-endpoint connection', { mode: 'guard' }],
  [
    'Export bootstrap coordinates (for the chained Gov bootstrap)',
    {
      mode: 'exempt',
      why: '`az account show` reads the SUBSCRIPTION, not the estate — no Loom resource is read or written. Its only consumer, the post-deploy-bootstrap job, carries its own `needs.deploy-validate.outputs.estate_paused != \'true\'`.',
    },
  ],
  ['Publish DLZ template + wire deploy env (Gov)', { mode: 'guard' }],
  [
    'Smoke test (Gov-specific)',
    { mode: 'via-provision', needle: "steps.provision.outputs.console_url != ''" },
  ],
  ['Teardown', { mode: 'refuse' }],
  [
    'Note dry-run completion',
    { mode: 'exempt', why: 'echoes a line on `run_mode == whatif-only`; no az call, no network.' },
  ],
  [
    'Notify on failure (dedicated, OPEN issue - never a closed one)',
    {
      mode: 'exempt',
      why: 'the `failure()` notifier. Gating it on the pause verdict is the precise way 47 days of silent daily failure happened before (deploy-integrity R3) — it must always run.',
    },
  ],
]);

/**
 * @param {{name:string, if:string, body:string}[]} steps
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judge(steps) {
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  if (at < 0) return [`the declaration step '${DECLARATION_STEP}' is gone — the stand-down has no anchor at all`];
  const problems = [];
  for (const step of steps.slice(at + 1)) {
    const d = DISPOSITIONS.get(step.name);
    if (!d) {
      problems.push(
        `step '${step.name}' runs AFTER the declaration and has no disposition. ` +
          'Add it to DISPOSITIONS with a mode, or gate it on the estate_paused verdict.',
      );
      continue;
    }
    if (d.mode === 'guard' && !step.if.includes(GUARD)) {
      problems.push(`step '${step.name}' must carry \`${GUARD}\` in its if:, but its if: is \`${step.if || '(none)'}\``);
    }
    if (d.mode === 'via-provision' && !step.if.includes(d.needle)) {
      problems.push(
        `step '${step.name}' is dispositioned as transitively guarded through Provision, ` +
          `which requires \`${d.needle}\` in its if: — found \`${step.if || '(none)'}\``,
      );
    }
    if (d.mode === 'refuse') {
      if (step.if.includes(GUARD)) {
        problems.push(
          `step '${step.name}' must REFUSE on a paused estate, not skip: a silently skipped teardown ` +
            'leaves the operator believing a sovereign estate was destroyed when it was not',
        );
      }
      if (!/ESTATE_PAUSED/.test(step.body) || !/::error::/.test(step.body)) {
        problems.push(
          `step '${step.name}' must read the estate_paused verdict into its body and fail with an ::error:: ` +
            'naming the action that authorises the destruction',
        );
      }
    }
  }
  return problems;
}

test('every step after the declaration stands down, refuses, or is dispositioned', () => {
  const problems = judge(parseSteps(workflowText()));
  assert.deepEqual(problems, [], `deploy-fiab-gcch stand-down is incomplete:\n  - ${problems.join('\n  - ')}`);
});

test('the parser sees the real step list and is not matching comment text', () => {
  const steps = parseSteps(workflowText());
  assert.ok(steps.length >= 20, `expected the full deploy-validate step list, parsed ${steps.length}`);
  assert.ok(
    steps.some((s) => s.name === DECLARATION_STEP),
    'the declaration step must be found by NAME, not by a substring of a comment',
  );
  // The workflow quotes a retired condition inside a comment block above
  // Teardown; if that leaked into a step's `if:` this would trip.
  const teardown = steps.find((s) => s.name === 'Teardown');
  assert.ok(teardown, 'Teardown step not parsed');
  assert.equal(
    teardown.if,
    "success() && github.event_name != 'schedule' && inputs.run_mode == 'full' && !inputs.keep_resources",
    'Teardown if: parsed from the live mapping, not from the commented-out condition above it',
  );
});

test('MUTATION: dropping the guard from the revert gate is caught', () => {
  const steps = parseSteps(workflowText());
  const mutated = steps.map((s) =>
    s.name === 'Image-tag revert gate — never flatten a pinned app to the default'
      ? { ...s, if: "github.event_name == 'schedule' || inputs.run_mode == 'full'" }
      : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got ${problems.length}`);
  assert.match(problems[0], /Image-tag revert gate/);
});

test('MUTATION: the #4233 head shape — three steps gated only on schedule/full — is caught', () => {
  const scheduleOnly = "github.event_name == 'schedule' || inputs.run_mode == 'full'";
  const regressed = new Set([
    'Image preflight — Gov ACR must already hold every referenced tag',
    'Image-tag revert gate — never flatten a pinned app to the default',
    'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)',
  ]);
  const mutated = parseSteps(workflowText()).map((s) => (regressed.has(s.name) ? { ...s, if: scheduleOnly } : s));
  const problems = judge(mutated);
  assert.equal(problems.length, 3, `expected 3 problems, got ${problems.length}: ${problems.join(' | ')}`);
});

test('MUTATION: a NEW step added after the declaration must be dispositioned', () => {
  const steps = parseSteps(workflowText());
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  const mutated = [...steps];
  mutated.splice(at + 1, 0, { name: 'Reconcile something new', if: '', body: '        run: az group delete' });
  const problems = judge(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no disposition/);
});

test('MUTATION: turning Teardown into a silent skip is caught', () => {
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown' ? { ...s, if: `${s.if} && ${GUARD}` } : s,
  );
  const problems = judge(mutated);
  assert.ok(
    problems.some((p) => /must REFUSE on a paused estate, not skip/.test(p)),
    `expected the silent-skip refusal, got: ${problems.join(' | ')}`,
  );
});

test('every JOB is dispositioned, and the image phase stands down on the declaration', () => {
  const problems = judgeJobs(parseJobs(workflowText()));
  assert.deepEqual(problems, [], `deploy-fiab-gcch job-level stand-down is incomplete:\n  - ${problems.join('\n  - ')}`);
});

test('the job parser sees the real job list and is not matching comment text', () => {
  const names = parseJobs(workflowText()).map((j) => j.name);
  assert.deepEqual(
    names,
    ['precheck', 'pause-declaration', 'build-gov-images', 'deploy-validate', 'post-deploy-bootstrap'],
    'the parsed job list must be the workflow\'s real jobs, in order',
  );
});

test('MUTATION: the round-2 head shape — build-gov-images ungated — is caught', () => {
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === 'build-gov-images'
      ? {
          ...j,
          needs: 'precheck',
          if: "needs.precheck.outputs.configured == 'true' && (github.event_name == 'schedule' || inputs.run_mode == 'full')",
        }
      : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 2, `expected the if: and the needs: problem, got: ${problems.join(' | ')}`);
  assert.ok(problems.every((p) => /build-gov-images/.test(p)));
});

test('MUTATION: reading the gate without declaring the need is caught', () => {
  // `needs.pause-declaration.outputs.declared` evaluates to empty when the job
  // is not in `needs:`, so the clause is always true and never suppresses — a
  // guard that is present and unreachable.
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === 'build-gov-images' ? { ...j, needs: 'precheck' } : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /does not declare it in needs:/);
});

test('MUTATION: a NEW job must be dispositioned', () => {
  const mutated = [...parseJobs(workflowText()), { name: 'roll-something', if: '', needs: '', body: '' }];
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /job 'roll-something' has no disposition/);
});

test('the stand-down summary claims only what the run established (R7)', () => {
  const summary = parseSteps(workflowText()).find((s) => s.name === DECLARATION_STEP);
  assert.ok(summary, 'the declaration summary step is gone');
  // The parent copy said the run skipped "the image preflight (which would have
  // opened this boundary's ACR firewall)" and that nothing "should touch an
  // estate this run has declared it will not measure" — while build-gov-images
  // opened that firewall in the same run. The summary must NAME the job it is
  // making a claim about, so the claim is checkable against the run's job list.
  assert.match(
    summary.body,
    /build-gov-images/,
    'the summary asserts this run did not touch the estate; it must name the image-phase JOB that would otherwise have, so the claim can be checked against the run',
  );
  for (const skipped of ['evidence receipt', 'artifact upload']) {
    assert.ok(
      summary.body.toLowerCase().includes(skipped),
      `the summary enumerates what was skipped and omits the ${skipped} — an incomplete enumeration reads as a complete one`,
    );
  }
});

test('CLOUD PARITY: no sibling deploy lane has an UNGATED image phase on a cron', () => {
  // cloud-parity.md: a defect fixed in one boundary and left in another is not
  // fixed. Measured at this head, so the claim is a MEASUREMENT and not a
  // memory — if someone gives deploy-fiab-il5 a cron, or gives deploy-fiab-gcc
  // an image phase, this goes red instead of the sovereign firewall opening.
  //
  // HONEST LIMIT, because a green assertion over an empty population is the
  // shape this repo keeps re-finding. Measured over the four lanes below:
  //   deploy-fiab-gcch        cron=yes  image phase=yes  -> EXAMINED
  //   deploy-fiab-gcc         cron=yes  image phase=NO   -> nothing to gate
  //   deploy-fiab-il5         cron=NO   image phase=yes  -> dispatch-only, so a
  //                                                         deliberate operator
  //                                                         act, never unattended
  //   deploy-fiab-commercial  cron=yes  image phase=NO   -> nothing to gate
  // So ONE lane is actually examined today. The negative control that says the
  // predicate discriminates rather than passing vacuously: run this same check
  // against the pre-fix deploy-fiab-gcch and it reports cron=true, guarded=false.
  const lanes = ['deploy-fiab-gcch', 'deploy-fiab-gcc', 'deploy-fiab-il5', 'deploy-fiab-commercial'];
  const unguarded = [];
  for (const lane of lanes) {
    const src = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', `${lane}.yml`), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    // A cron-capable lane runs UNATTENDED; that is what makes an ungated
    // estate mutation different in kind from one an operator dispatched.
    const hasCron = /^ {4}- cron:/m.test(src);
    const imagePhase = parseJobs(src).find((j) => j.name === 'build-gov-images');
    if (!hasCron || !imagePhase) continue;
    if (!imagePhase.if.includes(JOB_GUARD)) unguarded.push(`${lane}: if=\`${imagePhase.if || '(none)'}\``);
  }
  assert.deepEqual(
    unguarded,
    [],
    'a cron-triggered lane has an image phase that acquires the boundary ACR firewall lease with no ' +
      `estate-pause declaration clause:\n  - ${unguarded.join('\n  - ')}`,
  );
});

test('the daily cron cannot stack at the approval gate, and cannot cancel a live apply', () => {
  const wf = workflowText();
  const block = /\nconcurrency:\n((?: {2}.*\n)+)/.exec(wf);
  assert.ok(block, 'deploy-fiab-gcch has no top-level concurrency: block — scheduled runs stack at gcc-high-deploy');
  const body = block[1]
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1').trimEnd())
    .join('\n');
  assert.match(body, /group:\s*\S/, 'concurrency needs a group');
  assert.match(
    body,
    /group:[^\n]*github\.event_name/,
    'the group must be keyed by event_name, or an operator dispatch queues behind a cron run waiting for an approval nobody intends to give',
  );
  assert.match(
    body,
    /cancel-in-progress:\s*false\s*$/m,
    'cancel-in-progress must be literally false: this lane holds an ACR firewall lease (publicNetworkAccess=Enabled) inside a step, and a cancel there leaves the sovereign registry open until the 75m lease TTL plus acr-firewall-sweeper re-lock it',
  );
});

// ── The gate the image phase reads ────────────────────────────────────────────
// scripts/ci/estate-pause-declared.mjs is the whole reason `build-gov-images`
// can stand down without an Azure credential. Its contract has two halves and
// both are load-bearing: SUPPRESS only on positive evidence, and NEVER fail the
// job — a crash here would take a P0 sovereign deploy lane down for a JSON
// parse error.

test('the declaration gate suppresses only on a real, owned, unexpired entry', () => {
  const register = {
    paused: [
      {
        boundary: 'GCC-High',
        owner: 'fgarofalo56',
        declaredOn: '2026-08-26',
        reviewBy: '2026-11-24',
        reason: 'x'.repeat(80),
      },
    ],
  };
  assert.equal(decide({ register, readError: null, boundary: 'GCC-High', today: '2026-09-07' }).declared, true);
  // A different boundary's declaration never covers this one.
  assert.equal(decide({ register, readError: null, boundary: 'IL5', today: '2026-09-07' }).declared, false);
  // Expiry is the teeth: past reviewBy the image phase runs again.
  assert.equal(decide({ register, readError: null, boundary: 'GCC-High', today: '2026-11-25' }).declared, false);
});

test('every uncertain outcome resolves to NOT-suppressing, and says why', () => {
  for (const [label, args] of [
    ['no register at all', { register: null, readError: null }],
    ['unreadable register', { register: null, readError: 'EACCES' }],
    ['register is an array', { register: [], readError: null }],
    ['register has no paused array', { register: {}, readError: null }],
  ]) {
    const v = decide({ ...args, boundary: 'GCC-High', today: '2026-09-07' });
    assert.equal(v.declared, false, `${label} must NOT suppress`);
    assert.ok(v.lines.join('|').length > 0, `${label} must print a reason`);
  }
  // An unreadable register is an UNKNOWN and must be visible, not swallowed:
  // the operator would otherwise believe the estate is declared paused and be
  // unable to see why the image phase ran anyway (deploy-integrity R7).
  const unread = decide({ register: null, readError: 'EACCES', boundary: 'GCC-High', today: '2026-09-07' });
  assert.match(unread.lines.join('|'), /::warning::/);
});

test('loadRegister never throws, and tells an absent file apart from a broken one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pausereg-'));
  // ENOENT is the ordinary "no estate is paused" case, not a warning.
  assert.deepEqual(loadRegister(path.join(dir, 'nope.json')), { register: null, readError: null });
  // Unparseable is an UNKNOWN and must be reported.
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  const broken = loadRegister(bad);
  assert.equal(broken.register, null);
  assert.match(String(broken.readError), /not parseable JSON/);
});

test('parseArgs ignores what it does not understand rather than failing', () => {
  assert.deepEqual(parseArgs(['--boundary', 'GCC-High', '--today', '2026-09-07']), {
    boundary: 'GCC-High',
    today: '2026-09-07',
  });
  // A flag with no value must not swallow the next flag.
  assert.deepEqual(parseArgs(['--boundary', '--today', '2026-09-07']), { today: '2026-09-07' });
  assert.deepEqual(parseArgs([]), {});
});

test('the gate exits 0 and writes a value even with no boundary at all', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'estate-pause-declared.mjs');
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'pauseout-')), 'gh-output');
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, `the gate must never fail the job; stderr: ${r.stderr}`);
  assert.match(r.stdout, /declared_paused=false/);
  assert.equal(readFileSync(out, 'utf8').trim(), 'declared_paused=false');
});
