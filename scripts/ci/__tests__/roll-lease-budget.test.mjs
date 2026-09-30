/**
 * Teeth for #4823 — loom-dataplane-roll's lease waits outgrew its job timeout,
 * and the resulting timeout-cancel was silent.
 *
 * ── WHAT HAPPENED, MEASURED (run 36665140502, 2026-09-30) ──────────────────
 *
 *   03:36:32  job starts (`timeout-minutes: 45`)
 *   03:40:07  step 16 (digest re-assertion) starts its lease acquire with the
 *             helper's default bounded wait of 25 minutes; the lease is held by
 *             build-fiab-images-acr-tasks run 36665091682 (a 120-minute lease)
 *   04:05:24  step 16 gives up, `verdict=unknown`, exit 0 — as designed
 *   04:05:24  step 19 (:v0.1 pin) starts a SECOND 25-minute wait
 *   04:21:45  the job is killed at its limit; conclusion `cancelled`, so
 *             `Notify on failure` (`if: failure()`) and `Durability NOT
 *             established` (`success() && …`) are both `skipped`. `Summary`
 *             (`always()`) ran — so steps DO run after a timeout-cancel; these
 *             two simply had conditions that excluded it.
 *
 *   4 of the last 10 rolls ended this way.
 *
 * ── WHAT IS UNDER TEST ─────────────────────────────────────────────────────
 *
 *   BUDGET      the values are READ from the workflow and the helper, never
 *               restated here: timeout-minutes, LOOM_ROLL_LEASE_BUDGET_MINUTES,
 *               and the per-acquire wait each lease step passes. The arithmetic
 *               is then run through the REAL remainingWaitMinutes().
 *   VISIBILITY  the `if:` of the timeout notifier and of the durability report,
 *               evaluated over the step outcomes a timeout-cancel produces; and
 *               the notifier step's own script EXECUTED in a sandbox.
 *   TRUTH       what is said about the lease holder, with fixtures built from
 *               the helper's own `status` printf formats (lifted from source).
 *
 * Run: node --test scripts/ci/__tests__/roll-lease-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLogicalLines } from '../_logical-lines.mjs';
import {
  TIMEOUT_MARGIN_SECONDS,
  cliMain,
  describeUnacquired,
  leaseDeadline,
  notifyResult,
  parseLeaseStatus,
  remainingWaitMinutes,
  selfOwner,
} from '../roll-lease-budget.mjs';
import { buildIssueBody } from '../../../.github/scripts/deploy-notify-failure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WF_PATH = join(REPO_ROOT, '.github', 'workflows', 'loom-dataplane-roll.yml');
const HELPER_PATH = join(REPO_ROOT, 'scripts', 'csa-loom', 'acr-firewall-lease.sh');

// CRLF-normalised on read: a Windows checkout hands these back CRLF, and a `$`
// anchor or a `\n` needle would otherwise silently match nothing.
const wf = () => readFileSync(WF_PATH, 'utf8').replace(/\r\n/g, '\n');
const helper = () => readFileSync(HELPER_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * The non-wait work the budget must leave room for, in minutes. Not a bound on
 * every pathological run — the roll's own deploy-retry wall-clocks (up to 15m
 * per app) are not bounded by this, and a job that times out on THOSE is what
 * the timeout notifier below is for. It is sized from what a roll measurably
 * spends outside lease waits: run 36665140502 reached step 16 at 3m35s
 * (preflight included), a successful pin takes ~1.5m, and each lease step can
 * add one helper backoff (<=30s) + a firewall open (35s) + a verified re-lock
 * (<=6x20s). ~12 minutes; 15 is the floor this test enforces.
 */
const MIN_NON_WAIT_MINUTES = 15;

const LEASE_STEPS = [
  'Preflight — resolve the requested tag to a digest',
  'Re-assert the tag still resolves to the preflighted digest',
  'Pin the verified digest onto :v0.1 (deploy durability)',
];
const NOTIFY_CANCEL_STEP = 'Notify on a timeout-cancel';
const NOTIFY_FAILURE_STEP = 'Notify on failure';
const DURABILITY_STEP = 'Durability NOT established (state it plainly)';
const RESOLVE_STEP = 'Resolve + validate inputs';

// ── Reading the workflow (no YAML library: the guardrails job installs none) ──

/** The raw text of one step, from its `- name:` line to the next sibling. */
function stepText(name) {
  const lines = wf().split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found in loom-dataplane-roll.yml — renamed or removed?`);
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent && !l.trim().startsWith('#')) break;
    out.push(l);
  }
  return out.join('\n');
}

/** A step's `if:` as one line (folded `>-` scalars joined). */
function stepIf(name) {
  const lines = stepText(name).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)if:\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    if (rest !== '>-' && rest !== '>' && rest !== '') return rest;
    const parts = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^\s*/)[0].length <= m[1].length) break;
      parts.push(lines[j].trim());
    }
    return parts.join(' ');
  }
  assert.fail(`no if: on step "${name}"`);
}

/** A step's `run: |` body, de-indented. */
function stepRun(name) {
  const lines = stepText(name).split('\n');
  const at = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(at >= 0, `no "run: |" under "${name}"`);
  const ind = lines[at].match(/^\s*/)[0].length;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (lines[i].match(/^\s*/)[0].length <= ind) break;
    body.push(lines[i].slice(ind + 2));
  }
  return body.join('\n');
}

/** The one job's `timeout-minutes`. Exactly one must exist, or this reads the wrong number. */
function jobTimeoutMinutes() {
  const hits = [...wf().matchAll(/^ {4}timeout-minutes:\s*([0-9]+)\s*$/gm)];
  assert.equal(hits.length, 1, `expected ONE job-level timeout-minutes, found ${hits.length}`);
  return Number(hits[0][1]);
}

/** The job-level `env:` value of LOOM_ROLL_LEASE_BUDGET_MINUTES. */
function jobLeaseBudgetMinutes() {
  const m = wf().match(/^ {4}env:\n((?: {6}.*\n)+)/m);
  assert.ok(m, 'the job has no job-level env: block — the budget is not declared where every step can read it');
  const v = m[1].match(/^ {6}LOOM_ROLL_LEASE_BUDGET_MINUTES:\s*'?([0-9]+)'?\s*$/m);
  assert.ok(v, 'LOOM_ROLL_LEASE_BUDGET_MINUTES is not in the job-level env: block');
  return Number(v[1]);
}

/** The helper's default wait, lifted from its source. */
function helperDefaultWaitMinutes() {
  const m = helper().match(/wait_min="\$\{LOOM_ACR_LEASE_WAIT_MINUTES:-([0-9]+)\}"/);
  assert.ok(m, 'acr-firewall-lease.sh no longer reads LOOM_ACR_LEASE_WAIT_MINUTES with a default — the budget below is passed to nothing');
  return Number(m[1]);
}

/**
 * Every lease ACQUIRE in the workflow, on LOGICAL lines (a `\`-continued
 * command is one line here, so a wait variable split onto a continuation is
 * still seen), with the step that contains it.
 */
function acquireSites() {
  const src = wf();
  const lines = src.split('\n');
  const stepAt = (lineNo) => {
    for (let i = lineNo - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s*- name:\s*(.*)$/);
      if (m) return m[1].trim();
    }
    return null;
  };
  return readLogicalLines(src)
    .filter((l) => !/^\s*#/.test(l.text) && /acr-firewall-lease\.sh\s+acquire\b/.test(l.text))
    .map((l) => ({ line: l.line, step: stepAt(l.line), text: l.text }));
}

// ── 1. THE BUDGET ARITHMETIC ─────────────────────────────────────────────────

test('BUDGET: the job-level lease budget plus non-wait headroom is strictly below timeout-minutes', () => {
  const timeout = jobTimeoutMinutes();
  const budget = jobLeaseBudgetMinutes();
  // Breaks on: LOOM_ROLL_LEASE_BUDGET_MINUTES >= timeout - 15 (i.e. >= 30 at
  // today's 45), or timeout-minutes <= budget + 15 (i.e. <= 35 at today's 20).
  assert.ok(
    budget + MIN_NON_WAIT_MINUTES < timeout,
    `lease budget ${budget}m + ${MIN_NON_WAIT_MINUTES}m of non-wait work = ${budget + MIN_NON_WAIT_MINUTES}m, ` +
      `which does not fit strictly inside timeout-minutes ${timeout}m — a roll that meets a held lease will be ` +
      'killed by the timeout mid-wait, concluding `cancelled` instead of failing with its own error (#4823)',
  );
  assert.ok(budget > 0, `a ${budget}m budget makes every acquire a single attempt`);
});

test('DOCUMENTATION (not coverage): the pre-fix arrangement could never fit', () => {
  // Pins the ISSUE's arithmetic against the live helper default, so the story in
  // the headers stays true. It cannot fail on any change to the workflow, and it
  // is NOT counted as coverage of the fix — the test above and below are.
  const perStep = helperDefaultWaitMinutes();
  assert.ok(3.5 + perStep + perStep > jobTimeoutMinutes(),
    `3.5m setup + two ${perStep}m default waits fits in ${jobTimeoutMinutes()}m — the #4823 premise changed; re-read the issue`);
});

test('BUDGET: EVERY lease acquire in the job waits on the shared deadline — none inherits the 25m default', () => {
  const sites = acquireSites();
  // The ROW SET, not a count: a fourth acquire added elsewhere must show up here
  // and be judged, and a missing one must be named.
  assert.deepEqual(
    [...new Set(sites.map((s) => s.step))].sort(),
    [...LEASE_STEPS].sort(),
    `the steps that take the ACR lease changed: ${JSON.stringify(sites.map((s) => s.step))}`,
  );
  for (const s of sites) {
    // Breaks on: a bare `bash …acr-firewall-lease.sh acquire` (the helper then
    // waits its 25m default), or any literal `LOOM_ACR_LEASE_WAIT_MINUTES=25`.
    assert.match(
      s.text,
      /\bLOOM_ACR_LEASE_WAIT_MINUTES="\$LEASE_WAIT_MIN"/,
      `the acquire in "${s.step}" (line ${s.line}) does not pass the shared-budget wait; it falls back to ` +
        `the helper default (${helperDefaultWaitMinutes()}m) and the waits can again sum past timeout-minutes:\n${s.text}`,
    );
    const body = stepText(s.step);
    const assign = body.indexOf('LEASE_WAIT_MIN=$(node scripts/ci/roll-lease-budget.mjs wait-minutes --deadline "${ROLL_LEASE_DEADLINE:-}")');
    assert.ok(assign >= 0, `"${s.step}" does not compute LEASE_WAIT_MIN from ROLL_LEASE_DEADLINE`);
    assert.ok(assign < body.indexOf('acr-firewall-lease.sh acquire'), `"${s.step}" computes its wait AFTER acquiring`);
  }
});

test('BUDGET: the deadline is written ONCE, by the resolve step, from the job-level budget', () => {
  const run = stepRun(RESOLVE_STEP);
  assert.match(run, /ROLL_LEASE_DEADLINE=\$\(node scripts\/ci\/roll-lease-budget\.mjs deadline --budget-minutes "\$LOOM_ROLL_LEASE_BUDGET_MINUTES"\)/);
  assert.match(run, /echo "ROLL_LEASE_DEADLINE=\$ROLL_LEASE_DEADLINE" >> "\$GITHUB_ENV"/);
  assert.match(run, /echo "ROLL_JOB_STARTED=\$\(date -u \+%s\)" >> "\$GITHUB_ENV"/);
  // Nothing else may reset the deadline — a second writer would hand later steps
  // a fresh budget and the sum would be unbounded again.
  const writers = wf().split('\n').filter((l) => /ROLL_LEASE_DEADLINE=.*GITHUB_ENV/.test(l));
  assert.equal(writers.length, 1, `ROLL_LEASE_DEADLINE is written ${writers.length} times:\n${writers.join('\n')}`);
});

test('BUDGET: the helper waits `wait_min * 60` seconds — the unit this module computes in', () => {
  // If the helper ever switched LOOM_ACR_LEASE_WAIT_MINUTES to seconds, every
  // allowance here would silently become 60x shorter. Lifted from the source.
  assert.match(helper(), /deadline=\$\(\( \$\(_lease_now\) \+ wait_min \* 60 \)\)/);
});

test('MODEL: two sequential worst-case waits through the REAL remainingWaitMinutes never exceed the budget', () => {
  const budget = jobLeaseBudgetMinutes();
  const t0 = 1_800_000_000;
  const deadline = leaseDeadline({ budgetMinutes: budget, nowEpoch: t0 });
  assert.equal(deadline, t0 + budget * 60);
  let cases = 0;
  // s: seconds into the job at which step 16 starts its acquire. gap: non-wait
  // work between the end of step 16's wait and step 19's acquire. Each step is
  // assumed to wait its FULL allowance — the held-lease worst case.
  for (let s = 0; s <= budget * 60 + 180; s += 13) {
    for (const gap of [0, 1, 59, 61, 95, 600]) {
      const w16 = remainingWaitMinutes({ deadlineEpoch: deadline, nowEpoch: t0 + s });
      const t19 = t0 + s + w16 * 60 + gap;
      const w19 = remainingWaitMinutes({ deadlineEpoch: deadline, nowEpoch: t19 });
      // Breaks on: ceil/round instead of floor (61s left -> 2m), a
      // non-clamped negative, or returning a fixed per-step value.
      assert.ok(w16 + w19 <= budget, `s=${s} gap=${gap}: ${w16}m + ${w19}m exceeds the ${budget}m budget`);
      assert.ok(t0 + s + w16 * 60 <= Math.max(deadline, t0 + s), `s=${s}: step 16's wait runs past the deadline`);
      assert.ok(t19 + w19 * 60 <= Math.max(deadline, t19), `s=${s} gap=${gap}: step 19's wait runs past the deadline`);
      cases++;
    }
  }
  assert.ok(cases > 500, `the model evaluated only ${cases} cases`);
});

test('remainingWaitMinutes: floor, clamp at zero, and refuse a missing deadline', () => {
  const now = 1_800_000_000;
  assert.equal(remainingWaitMinutes({ deadlineEpoch: now + 1200, nowEpoch: now }), 20);
  assert.equal(remainingWaitMinutes({ deadlineEpoch: now + 119, nowEpoch: now }), 1, '119s left is 1 whole minute, not 2');
  assert.equal(remainingWaitMinutes({ deadlineEpoch: now + 59, nowEpoch: now }), 0);
  assert.equal(remainingWaitMinutes({ deadlineEpoch: now - 90, nowEpoch: now }), 0, 'past the deadline is 0, never negative');
  assert.throws(() => remainingWaitMinutes({ deadlineEpoch: '', nowEpoch: now }), /deadline must be an integer/);
  assert.throws(() => leaseDeadline({ budgetMinutes: '0', nowEpoch: now }), /positive integer/);
  assert.throws(() => leaseDeadline({ budgetMinutes: 'x', nowEpoch: now }), /positive integer/);
});

// ── 2. A TIMEOUT-CANCEL IS VISIBLE ───────────────────────────────────────────

/** GitHub `if:` → JS, refusing any construct it does not model. */
function ghIf(expr) {
  const js = expr
    .replace(/\bfailure\(\)/g, 'C.failure')
    .replace(/\bsuccess\(\)/g, 'C.success')
    .replace(/\bcancelled\(\)/g, 'C.cancelled')
    .replace(/\balways\(\)/g, 'true')
    .replace(/\bsteps\.([A-Za-z_][\w]*)\.outputs\.([A-Za-z_][\w]*)/g, (_m, id, k) => `C.out(${JSON.stringify(`${id}.${k}`)})`)
    .replace(/\bsteps\.([A-Za-z_][\w]*)\.outcome\b/g, (_m, id) => `C.outcome(${JSON.stringify(id)})`)
    .replace(/!=/g, '!==')
    .replace(/(?<![=!<>])==(?!=)/g, '===');
  const residue = js
    .replace(/C\.(out|outcome)\("[^"]*"\)/g, '')
    .replace(/C\.(failure|success|cancelled)/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\btrue\b/g, '')
    .replace(/[\s()&|!=]/g, '');
  assert.equal(residue, '', `the if: uses a construct this translator does not model: ${JSON.stringify(residue)}`);
  // eslint-disable-next-line no-new-func
  const fn = new Function('C', `return (${js});`);
  return (ctx) =>
    fn({
      failure: ctx.status === 'failure',
      success: ctx.status === 'success',
      cancelled: ctx.status === 'cancelled',
      // An unset step outcome/output is the EMPTY STRING in Actions, not undefined.
      outcome: (id) => ctx.outcome?.[id] ?? '',
      out: (k) => ctx.outputs?.[k] ?? '',
    });
}

/** The measured incident: roll landed, digest `unknown`, pin killed mid-wait. */
const TIMEOUT_CANCEL = {
  status: 'cancelled',
  outcome: { roll: 'success', health: 'success', verify: 'success', digest: 'success', pin: 'cancelled' },
  outputs: { 'resolve.pin': 'true', 'preflight.digests_complete': 'true', 'digest.verdict': 'unknown' },
};

test('VISIBILITY: the timeout notifier fires on the measured timeout-cancel, and not on success or failure', () => {
  const fires = ghIf(stepIf(NOTIFY_CANCEL_STEP));
  // Breaks on: reverting this step's if: to `failure()` (the #4823 silence).
  assert.equal(fires(TIMEOUT_CANCEL), true, 'a timed-out roll (conclusion `cancelled`) reaches no notifier');
  assert.equal(fires({ ...TIMEOUT_CANCEL, status: 'success' }), false, 'the timeout notifier fires on a successful run');
  assert.equal(fires({ ...TIMEOUT_CANCEL, status: 'failure' }), false,
    'the timeout notifier fires on a plain failure — the `Notify on failure` step already files that, so this would file twice');
  // And the failure notifier is unchanged: it still owns `failure`.
  assert.equal(ghIf(stepIf(NOTIFY_FAILURE_STEP))({ ...TIMEOUT_CANCEL, status: 'failure' }), true);
});

test('VISIBILITY: durability-not-established fires on a timeout-cancel after the roll landed', () => {
  const fires = ghIf(stepIf(DURABILITY_STEP));
  // Breaks on: reverting to `success() && (…)`, which is false on every cancel.
  assert.equal(fires(TIMEOUT_CANCEL), true, 'a roll that landed and was then cancelled before the pin completed reports nothing about durability');
  assert.equal(fires({ ...TIMEOUT_CANCEL, outcome: { ...TIMEOUT_CANCEL.outcome, pin: '' } }), true,
    'a cancel before the pin started must report too');
  // Negative controls — each one a value that must NOT fire it:
  assert.equal(fires({ ...TIMEOUT_CANCEL, outcome: { ...TIMEOUT_CANCEL.outcome, roll: 'cancelled' } }), false,
    'a cancel before the roll landed has no live roll whose durability is in question');
  assert.equal(fires({ ...TIMEOUT_CANCEL, outcome: { ...TIMEOUT_CANCEL.outcome, pin: 'success' } }), false,
    'a cancel AFTER the pin succeeded must not claim durability is missing');
  assert.equal(fires({ ...TIMEOUT_CANCEL, status: 'success', outcome: { ...TIMEOUT_CANCEL.outcome, pin: 'success' } }), false);
  // The pre-existing arm is preserved: a SUCCESSFUL run whose pin was not requested.
  assert.equal(fires({ status: 'success', outcome: { roll: 'success' }, outputs: { 'resolve.pin': 'false', 'preflight.digests_complete': 'true' } }), true);
  assert.equal(fires({ status: 'success', outcome: { roll: 'success' }, outputs: { 'resolve.pin': 'true', 'preflight.digests_complete': 'false' } }), true);
});

test('VISIBILITY: the timeout notifier files through the chokepoint with a GENUINE-failure literal and a token', () => {
  const text = stepText(NOTIFY_CANCEL_STEP);
  assert.match(text, /node \.github\/scripts\/deploy-notify-failure\.mjs/);
  assert.match(text, /--workflow loom-dataplane-roll --result timed_out --failure-json deploy-failure\.json/);
  assert.match(text, /^\s+GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m);
  assert.match(text, /^\s+JOB_STATUS:\s*\$\{\{\s*job\.status\s*\}\}\s*$/m);
  // The step's copy of the limit MUST equal the job's. Breaks on changing either
  // one alone: a 60-minute job with a stale '45' here would call a cancel at
  // minute 44 a timeout, and the reverse would never see one.
  const m = text.match(/^\s+ROLL_JOB_TIMEOUT_MINUTES:\s*'?([0-9]+)'?\s*$/m);
  assert.ok(m, 'the timeout notifier does not declare ROLL_JOB_TIMEOUT_MINUTES');
  assert.equal(Number(m[1]), jobTimeoutMinutes(), 'ROLL_JOB_TIMEOUT_MINUTES differs from the job timeout-minutes');
});

// ── notifyResult: the TRUE class for each kind of cancel ───────────────────

test('notifyResult: a cancel at the limit is timed_out; an earlier one stays cancelled; others pass through', () => {
  const started = 1_800_000_000;
  const at = (s) => notifyResult({ jobStatus: 'cancelled', startedEpoch: started, nowEpoch: started + s, timeoutMinutes: 45 });
  // Run 36665140502: job 03:36:32 -> killed 04:21:45; ROLL_JOB_STARTED is written
  // 9s after job start, so the notifier would observe ~45m04s.
  assert.equal(at(45 * 60 + 4).result, 'timed_out');
  assert.equal(at(45 * 60 - TIMEOUT_MARGIN_SECONDS).result, 'timed_out', 'the margin boundary is inclusive');
  assert.equal(at(45 * 60 - TIMEOUT_MARGIN_SECONDS - 1).result, 'cancelled', 'one second earlier is a person, not the limit');
  assert.equal(at(600).result, 'cancelled');
  assert.match(at(600).note, /not superseded/i);
  assert.equal(
    notifyResult({ jobStatus: 'cancelled', startedEpoch: '', nowEpoch: started, timeoutMinutes: 45 }).result,
    'cancelled',
    'with no recorded start, a timeout cannot be established — it must not be CLAIMED',
  );
  assert.equal(notifyResult({ jobStatus: 'failure', startedEpoch: started, nowEpoch: started + 3000, timeoutMinutes: 45 }).result, 'failure');
  assert.throws(
    () => notifyResult({ jobStatus: 'cancelled', startedEpoch: started, nowEpoch: started, timeoutMinutes: '' }),
    /timeout-minutes/,
    'a missing limit must refuse, not classify against 0',
  );
});

// ── The cancel notifier's script, EXECUTED ───────────────────────────────────

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

const NOTIFIER_STUB = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.NOTIFY_LOG, process.argv.slice(2).join(' ') + '\\n');
`;

function runCancelNotifier({ jobStatus, elapsedSeconds }) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-lease-budget-'));
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  // The REAL module (pure) and its one import; a STUB notifier that records how it was invoked.
  for (const f of ['roll-lease-budget.mjs', '_azure-redact.mjs']) {
    writeFileSync(join(dir, 'scripts', 'ci', f),
      readFileSync(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8'), 'utf8');
  }
  writeFileSync(join(dir, '.github', 'scripts', 'deploy-notify-failure.mjs'), NOTIFIER_STUB, 'utf8');
  const log = join(dir, 'notify.log');
  writeFileSync(log, '', 'utf8');
  const script = join(dir, 'step.sh');
  writeFileSync(script, stepRun(NOTIFY_CANCEL_STEP), 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const r = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NOTIFY_LOG: posix(log),
      JOB_STATUS: jobStatus,
      ROLL_JOB_STARTED: String(now - elapsedSeconds),
      ROLL_JOB_TIMEOUT_MINUTES: String(jobTimeoutMinutes()),
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('EXECUTED: a cancel at the time limit FILES, as timed_out', { skip: !bashAvailable }, () => {
  const r = runCancelNotifier({ jobStatus: 'cancelled', elapsedSeconds: jobTimeoutMinutes() * 60 + 4 });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls.length, 1, `expected ONE notifier call, got ${r.calls.length}:\n${r.out}`);
  assert.match(r.calls[0], /--workflow loom-dataplane-roll --result timed_out --failure-json deploy-failure\.json/);
  assert.match(r.out, /::error::.*timeout-minutes limit/);
});

test('EXECUTED: an early cancel (a person) files NOTHING and says why', { skip: !bashAvailable }, () => {
  const r = runCancelNotifier({ jobStatus: 'cancelled', elapsedSeconds: 600 });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [], `a person's cancel was filed as a deploy failure (#3368):\n${r.out}`);
  assert.match(r.out, /::notice::.*before its \d+-minute limit/);
});

// ── 3. WHAT IS SAID ABOUT THE HOLDER (R7) ─────────────────────────────────────

/**
 * Build `acr-firewall-lease.sh status` output from the helper's OWN printf
 * formats, lifted out of acr_lease_status() — so a relabelled field breaks this
 * suite instead of leaving the parser matching a format nothing prints.
 */
function statusText({ pna, da = 'Deny', owner, url, since = 'none', state }) {
  const fn = helper().match(/acr_lease_status\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, 'acr_lease_status() not found in the helper');
  const fmt = (label) => {
    const m = fn[1].match(new RegExp(`printf '(${label}\\s*: )%s\\\\n'`));
    assert.ok(m, `the helper no longer prints a '${label}' line`);
    return m[1];
  };
  const stateFmt = (kind) => {
    const m = fn[1].match(new RegExp(`printf '(lease state\\s*: ${kind}[^']*)\\\\n'`));
    assert.ok(m, `the helper no longer prints a '${kind}' lease state`);
    return m[1];
  };
  let stateLine;
  if (state.kind === 'live') stateLine = stateFmt('LIVE').replace('%s', String(state.seconds));
  else if (state.kind === 'stale') stateLine = stateFmt('STALE').replace('%s', String(state.seconds));
  else stateLine = stateFmt('free');
  return [
    `${fmt('acr')}acrloomtest`,
    `${fmt('publicNetworkAccess')}${pna}`,
    `${fmt('defaultAction')}${da}`,
    `${fmt('lease owner')}${owner}`,
    `${fmt('lease holder url')}${url}`,
    `${fmt('lease since \\(utc\\)')}${since}`,
    stateLine,
  ].join('\n');
}

const BUILD_OWNER = 'gha:fgarofalo56/csa-inabox:36665091682:1';
const BUILD_URL = 'https://github.com/fgarofalo56/csa-inabox/actions/runs/36665091682';
const SELF = selfOwner({ GITHUB_REPOSITORY: 'fgarofalo56/csa-inabox', GITHUB_RUN_ID: '36665140502', GITHUB_RUN_ATTEMPT: '1' });
const describe = (text) =>
  describeUnacquired({ status: parseLeaseStatus(text), self: SELF, step: 'pin :v0.1', acr: 'acrloomtest', waitMinutes: 0, budgetMinutes: 20 });

test('selfOwner mirrors the helper\'s own holder id', () => {
  assert.equal(SELF, 'gha:fgarofalo56/csa-inabox:36665140502:1');
  // Lifted: if the helper changes how it names a GHA holder, the self-check below
  // would stop recognising THIS run and start blaming it on "another holder".
  assert.ok(helper().includes('"gha:${GITHUB_REPOSITORY:-unknown}:${GITHUB_RUN_ID:-0}:${GITHUB_RUN_ATTEMPT:-1}"'));
  assert.equal(selfOwner({ LOOM_ACR_LEASE_OWNER: 'me here!' }), 'me_here_');
});

test('HOLDER: a LIVE lease held by another run is named, and classified as transient contention', () => {
  const d = describe(statusText({ pna: 'Enabled', owner: BUILD_OWNER, url: BUILD_URL, state: { kind: 'live', seconds: 5400 } }));
  assert.equal(d.verdict, 'held-by-other');
  assert.match(d.message, new RegExp(`held by '${BUILD_OWNER}' \\(${BUILD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.match(d.message, /LIVE for another 5400s/);
  assert.equal(d.failure.class, 'transient', 'lease contention is not a defect, permission or quota failure');
  assert.equal(d.failure.retryable, true);
  assert.match(d.failure.whyStopped, new RegExp(BUILD_OWNER));
});

test('HOLDER: an UNREADABLE registry is not reported as a free lease (R7)', () => {
  // Exactly what the helper prints when every `az acr show` fails: _lease_acr_q
  // swallows the error and returns '', which prints as owner `none` / state
  // `free` — indistinguishable from a genuinely free lease except for the
  // `<unreadable>` network line. Breaks on: parseLeaseStatus ignoring that line.
  const d = describe(statusText({ pna: '<unreadable>', da: '<unreadable>', owner: 'none', url: 'none', state: { kind: 'free' } }));
  assert.equal(d.verdict, 'holder-unreadable');
  assert.equal(d.failure, null, 'no cause may be classified from a read that did not happen');
  assert.match(d.message, /NOT named here and no cause is asserted/);
  assert.equal(describe('').verdict, 'holder-unreadable', 'empty status output is unreadable, not free');
});

test('HOLDER: free, stale, and held-by-THIS-run are NOT blamed on another holder', () => {
  for (const [label, text] of [
    ['free', statusText({ pna: 'Disabled', owner: 'none', url: 'none', state: { kind: 'free' } })],
    ['stale', statusText({ pna: 'Disabled', owner: BUILD_OWNER, url: BUILD_URL, state: { kind: 'stale', seconds: 30 } })],
    ['self', statusText({ pna: 'Enabled', owner: SELF, url: 'x', state: { kind: 'live', seconds: 1200 } })],
  ]) {
    const d = describe(text);
    assert.equal(d.verdict, 'not-held-by-other', `${label}: ${d.message}`);
    assert.equal(d.failure, null, `${label}: classified as contention with no contending holder`);
    assert.match(d.message, /did NOT fail by waiting behind another holder/);
  }
});

test('SEAM: the CLI writes deploy-failure.json ONLY for contention, and the notifier renders its class', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-lease-budget-cli-'));
  const status = join(dir, 'status.txt');
  const art = join(dir, 'deploy-failure.json');
  const env = { GITHUB_REPOSITORY: 'fgarofalo56/csa-inabox', GITHUB_RUN_ID: '36665140502', GITHUB_RUN_ATTEMPT: '1' };
  const args = ['unacquired', '--status-file', status, '--acr', 'acrloomtest', '--step', 'pin :v0.1',
    '--wait-minutes', '0', '--budget-minutes', '20', '--out', art];

  writeFileSync(status, statusText({ pna: '<unreadable>', da: '<unreadable>', owner: 'none', url: 'none', state: { kind: 'free' } }));
  let printed = '';
  cliMain(args, env, (s) => { printed += s; });
  assert.equal(existsSync(art), false, 'an artifact was written for an unreadable lease — the notifier would then assert a cause');
  assert.match(printed, /^::error::Could not read the ACR firewall lease/);

  writeFileSync(status, statusText({ pna: 'Enabled', owner: BUILD_OWNER, url: BUILD_URL, state: { kind: 'live', seconds: 5400 } }));
  printed = '';
  cliMain(args, env, (s) => { printed += s; });
  assert.ok(existsSync(art), 'no deploy-failure.json for a genuine held-lease refusal');
  const body = buildIssueBody({ workflow: 'loom-dataplane-roll', runId: '1', sha: 'abc', failure: JSON.parse(readFileSync(art, 'utf8')) });
  assert.match(body, /\*\*Classification: transient\*\* \(`acr-lease\.held-past-roll-budget`\)/);
  assert.doesNotMatch(body, /No classification was captured/, 'the notifier still renders the unclassified body');
  assert.match(body, new RegExp(`lease owner '${BUILD_OWNER}'`));
});

test('SINKS: both publication sinks redact — the lease tags are text another workflow wrote', () => {
  // Spawned, not called: the subject is the DEFAULT `out` and the stderr catch,
  // which an injected writer (as in the SEAM test above) would bypass.
  // A FAKE id, shaped to hit _azure-redact's `/subscriptions/<36 hex-or-dash>`
  // rule. Breaks on: removing redactedLine() from either sink — the raw id then
  // reaches the output and the absence check goes red; the paired positive
  // assertions go red if the sink is deleted instead of redacted.
  const FAKE = '11111111-2222-3333-4444-555555555555';
  const dir = mkdtempSync(join(tmpdir(), 'roll-lease-budget-sink-'));
  const status = join(dir, 'status.txt');
  const cli = join(REPO_ROOT, 'scripts', 'ci', 'roll-lease-budget.mjs');
  writeFileSync(status, statusText({
    pna: 'Enabled', owner: BUILD_OWNER, url: `https://portal.azure.com/#resource/subscriptions/${FAKE}/x`,
    state: { kind: 'live', seconds: 60 },
  }));
  const out = spawnSync(process.execPath, [cli, 'unacquired', '--status-file', status, '--acr', 'acrloomtest',
    '--step', 'pin :v0.1', '--wait-minutes', '0', '--budget-minutes', '20'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(FAKE) === false, `stdout published the raw id:\n${out.stdout}`);
  assert.match(out.stdout, /held by 'gha:fgarofalo56\/csa-inabox:36665091682:1' \(https:\/\/portal\.azure\.com\/#resource\/subscriptions\/<redacted>\/x\)/);

  const err = spawnSync(process.execPath, [cli, 'wait-minutes', '--deadline', `/subscriptions/${FAKE}`], { encoding: 'utf8' });
  assert.equal(err.status, 2);
  assert.ok(err.stderr.includes(FAKE) === false, `stderr published the raw id:\n${err.stderr}`);
  assert.match(err.stderr, /^::error::roll-lease-budget: deadline must be an integer epoch in seconds, got '\/subscriptions\/<redacted>'/);
});

test('the lease steps read the holder back with the helper\'s own `status`, never a raw az call', () => {
  // The helper's status is the one reader whose output format this suite lifts;
  // a second, private reader would be free to drift from it.
  for (const step of LEASE_STEPS) {
    const run = stepRun(step);
    assert.match(run, /bash scripts\/csa-loom\/acr-firewall-lease\.sh status --acr "\$ACR" > \.roll\/lease-status\.txt/, step);
    assert.match(run, /node scripts\/ci\/roll-lease-budget\.mjs unacquired --status-file \.roll\/lease-status\.txt/, step);
  }
  // Only the two steps that FAIL on a refusal hand the notifier an artifact; the
  // digest step's refusal is `verdict=unknown`, which is not a failure (#4196).
  assert.match(stepRun(LEASE_STEPS[0]), /--out deploy-failure\.json/);
  assert.doesNotMatch(stepRun(LEASE_STEPS[1]), /--out deploy-failure\.json/);
  assert.match(stepRun(LEASE_STEPS[1]), /--severity warning/);
  assert.match(stepRun(LEASE_STEPS[2]), /--out deploy-failure\.json/);
});
