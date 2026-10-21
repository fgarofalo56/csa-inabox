#!/usr/bin/env node
/**
 * loom-uat-full-suite.yml: the nightly must (a) stand down VISIBLY on a declared
 * paused estate, (b) report the failures that actually failed, and (c) be able
 * to file its tracking issue. (refs #5045)
 *
 * The lane was red 74 of 74 recorded runs (2026-08-10 -> 2026-10-20). Two of the
 * defects were in the lane, not the product, and both hid the real cause:
 *   - the failure-detail query matched the word "axe", so ~22 PASSING a11y
 *     verdict lines filled the 60-row `take` and the CRASH line never surfaced;
 *   - the issue-filing step died with "failed to run git: fatal: not a git
 *     repository" (no checkout), so the detector never alerted anyone.
 *
 * Every assertion below names the input that breaks it. Run the sandbox-copy
 * mutations listed in the PR body to see each go RED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPauseDeclaration } from '../_estate-pause-declaration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.resolve(HERE, '..', '..', '..', '.github', 'workflows', 'loom-uat-full-suite.yml');

/** Overridable so a mutation run can point at a sandbox copy. */
export function workflowText() {
  return fs.readFileSync(process.env.LOOM_UAT_WORKFLOW_FILE || WF, 'utf8').replace(/\r\n/g, '\n');
}

/** Split the single job's steps on the 6-space `- ` list marker. */
export function parseSteps(text) {
  const start = text.indexOf('\n    steps:\n');
  assert.ok(start > 0, 'workflow has no job `steps:` block');
  const body = text.slice(start + '\n    steps:\n'.length);
  const chunks = body.split(/\n(?=      - )/);
  return chunks.map((c) => {
    const name = /^ {6}- (?:name: (.+)|uses: (.+))$/m.exec(c);
    const iff = /^ {8}if: (.+)$/m.exec(c);
    return { text: c, label: (name && (name[1] || name[2])) || '<unnamed>', if: iff ? iff[1].trim() : null };
  });
}

const GUARD = "steps.pause.outputs.declared_paused != 'true'";

test('Azure login and the UAT run are both gated on the declaration (input: remove the `if:` from either)', () => {
  const steps = parseSteps(workflowText());
  for (const label of ['Azure login', 'Run the full UAT suite and wait for a verdict']) {
    const s = steps.find((x) => x.label === label);
    assert.ok(s, `step "${label}" not found; steps: ${steps.map((x) => x.label).join(' | ')}`);
    assert.equal(s.if, GUARD, `"${label}" must carry the stand-down guard, has: ${s.if}`);
  }
});

test('the declaration is read BEFORE anything that touches Azure (input: move the pause step below Azure login)', () => {
  const steps = parseSteps(workflowText());
  const pause = steps.findIndex((s) => /id: pause/.test(s.text) && /estate-pause-declared\.mjs --boundary Commercial/.test(s.text));
  const login = steps.findIndex((s) => s.label === 'Azure login');
  const checkout = steps.findIndex((s) => /actions\/checkout@/.test(s.label));
  assert.ok(pause >= 0, 'no step with id `pause` running estate-pause-declared.mjs --boundary Commercial');
  assert.ok(checkout >= 0 && checkout < pause, 'checkout must precede the pause step (the script lives in the repo)');
  assert.ok(pause < login, `pause step (${pause}) must precede Azure login (${login})`);
});

test('the stand-down is LOUD: a warning annotation and a step summary that say UNMEASURED (input: delete either line)', () => {
  const steps = parseSteps(workflowText());
  const s = steps.find((x) => /^Stand down/.test(x.label));
  assert.ok(s, 'no stand-down step');
  assert.equal(s.if, "steps.pause.outputs.declared_paused == 'true'", 'stand-down must fire exactly when declared');
  assert.match(s.text, /::warning::.*NOT run/, 'stand-down must emit a ::warning:: naming that the suite was NOT run');
  assert.match(s.text, /UNMEASURED/, 'stand-down must say UNMEASURED');
  assert.match(s.text, /GITHUB_STEP_SUMMARY/, 'stand-down must write the job summary');
  assert.doesNotMatch(s.text, /\bPASSED\b/, 'a stand-down must never claim a pass');
});

test("the boundary the workflow passes is one the classifier can match (input: change 'Commercial' to a name the register does not use)", () => {
  const m = /estate-pause-declared\.mjs --boundary (\S+)/.exec(workflowText());
  assert.ok(m, 'boundary argument not found');
  const boundary = m[1];
  const register = {
    paused: [{
      boundary: 'Commercial', owner: 'someone', declaredOn: '2026-10-01', reviewBy: '2026-12-01',
      reason: 'The Commercial estate is held stopped under the pause mandate; measured stopped on 2026-10-01; resume by deleting this entry.',
    }],
  };
  const hit = classifyPauseDeclaration({ register, boundary, today: '2026-10-21' });
  assert.equal(hit.declared, true, `boundary '${boundary}' must match a Commercial entry: ${hit.reason}`);
  // Negative control: the SAME register must not stand the lane down for another boundary.
  const miss = classifyPauseDeclaration({ register, boundary: 'GCC-High', today: '2026-10-21' });
  assert.equal(miss.declared, false);
  // Fail-open control: an expired review date must NOT suppress.
  const expired = classifyPauseDeclaration({ register, boundary, today: '2027-01-01' });
  assert.equal(expired.declared, false, 'an expired reviewBy must re-arm the lane');
});

/** Lift the failure-detail KQL out of the workflow and evaluate its `where` against a log line. */
function liftFailureFilter() {
  const m = /FQ="ContainerAppConsoleLogs_CL[^"\n]*?\| where (Log_s has .+?) \| order by/s.exec(
    workflowText().replace(/\\"/g, '\u0001'),
  );
  assert.ok(m, 'failure-detail FQ query not found');
  const expr = m[1]
    .replace(/Log_s has '([^']*)'/g, (_, lit) => `L.includes(${JSON.stringify(lit.replace(/\u0001/g, '"'))})`)
    .replace(/\bor\b/g, '||')
    .replace(/\band\b/g, '&&');
  assert.doesNotMatch(expr, /Log_s|\bhas\b/, `unconverted KQL left in: ${expr}`);
  return new Function('L', `return (${expr});`);
}

// Shapes copied from run 39425171984 (job 118635800616 log).
const PASSING_A11Y = 'UAT_VERDICT {"ts":"2026-10-20T12:49:57.637Z","surface":"a11y:home","feature":"axe-ratchet","verdict":"B","status":"pass","notes":"http=200; ratchet: measured critical=1 serious=1 vs baseline critical=1 serious=2","durationMs":7900}';
const FAILED_JOURNEY = 'UAT_VERDICT {"ts":"2026-10-20T13:10:00.000Z","surface":"journey:notebook-run-cell","feature":"notebook-run-cell","verdict":"F","status":"fail","notes":"CRASH=[notebook-run-cell] execute 502: {}","durationMs":900}';
const REAL_FAILS = 'UAT_REAL_FAILS app=journey:notebook-run-cell crashes=[journey:notebook-run-cell/notebook-run-cell] empties=[] infraGatedSteps=0';

test('failure-detail filter selects failed verdicts and UAT_REAL_FAILS, and NOT passing a11y lines (input: the old `has axe or has serious` clause)', () => {
  const keep = liftFailureFilter();
  assert.equal(keep(FAILED_JOURNEY), true, 'a status:fail verdict (the CRASH note) must be selected');
  assert.equal(keep(REAL_FAILS), true, 'the UAT_REAL_FAILS summary must be selected');
  assert.equal(keep(PASSING_A11Y), false,
    'a PASSING a11y verdict carries "axe" and "serious" and must not consume the 60-row take');
});

test('the failure-detail filter would have FAILED the old clause (control: prove the probe can go red)', () => {
  // The pre-#5045 clause, applied to the same two lines.
  const old = (L) => L.includes('UAT_REAL_FAILS') || L.includes('axe') || L.includes('serious');
  assert.equal(old(PASSING_A11Y), true, 'control: the old clause DID select the passing a11y line');
  assert.equal(old(FAILED_JOURNEY), false, 'control: the old clause did NOT select the failed journey verdict');
});

test('the issue-filing step names its repo, so it cannot die without a working tree (input: delete GH_REPO)', () => {
  const steps = parseSteps(workflowText());
  const s = steps.find((x) => x.label === 'File or update the failure issue');
  assert.ok(s, 'issue-filing step not found');
  assert.match(s.text, /^ {10}GH_REPO: \$\{\{ github\.repository \}\}$/m);
  assert.equal(s.if, 'failure()', 'the issue step must still run on failure');
});
