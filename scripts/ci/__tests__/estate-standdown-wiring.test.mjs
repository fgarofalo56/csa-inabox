// The deploy lanes that wake or rescale paused resources must call the estate
// pause gate and honour its verdict (PRP-02 step 6, #5111). Each assertion names
// the edit that would break it (assertion-design.md). Workflow text is read, not
// transcribed: lane names and job names come from the files themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const wf = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n');

/** The text of one top-level job (2-space-indented key under `jobs:`). */
function jobBlock(text, job) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(start >= 0, `job ${job} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** The (possibly folded) `if:` expression of a job, comments stripped. */
function jobIf(block) {
  const lines = block.split('\n').filter((l) => !/^\s*#/.test(l));
  const i = lines.findIndex((l) => /^    if:/.test(l));
  if (i < 0) return '';
  const out = [lines[i].replace(/^    if:\s*/, '')];
  for (let k = i + 1; k < lines.length && /^      /.test(lines[k]); k += 1) out.push(lines[k].trim());
  return out.join(' ');
}

/**
 * Lift the (paren-free) schedule/gate-result sub-expression out of a lane's `if:`.
 * It is the parenthesised group that mentions needs.estate-gate.result.
 */
function gateFragment(cond) {
  const m = cond.match(/\(([^()]*needs\.estate-gate\.result[^()]*)\)/);
  return m ? m[1] : null;
}

/** Evaluate the lifted fragment: only ==, !=, &&, || over three contexts, so a JS eval is faithful. */
function evalGate(frag, { event, result, standdown }) {
  const js = frag
    .replace(/github\.event_name/g, JSON.stringify(event))
    .replace(/needs\.estate-gate\.result/g, JSON.stringify(result))
    .replace(/needs\.estate-gate\.outputs\.standdown/g, JSON.stringify(standdown))
    .replace(/ == /g, ' === ')
    .replace(/ != /g, ' !== ');
  assert.ok(!/[A-Za-z_]\w*\.[A-Za-z_]/.test(js.replace(/"[^"]*"|'[^']*'/g, '')), `unevaluated context left in: ${js}`);
  return Function(`return (${js});`)();
}

/**
 * Top-level `||` operators in a full `if:` (paren depth 0, string literals skipped). The
 * fragment test above only evaluates the inner group, so it is blind to precedence: GitHub
 * binds && tighter than ||, and `!cancelled() && x && A || B` lets B bypass !cancelled() and x.
 */
function topLevelOrs(cond) {
  const s = cond.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replace(/'[^']*'/g, "''");
  let depth = 0;
  let ors = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    else if (depth === 0 && s.startsWith('||', i)) { ors += 1; i += 1; }
  }
  return ors;
}

// lane file, boundary the gate is called with, the job that must stand down
const DEDICATED_LANES = ['deploy-health.yml'];
const LANES = [
  ['deploy-fiab-commercial.yml', 'Commercial', 'deploy-validate'],
  ['deploy-fiab-gcch.yml', 'GCC-High', 'deploy-validate'],
  ['deploy-fiab-gcc.yml', 'GCC', 'deploy-validate'],
  ['deploy-fiab-il5.yml', 'IL5', 'deploy-validate'],
  ['full-app-deploy-commercial.yml', 'Commercial', 'redeploy-with-apps'],
  ['loom-dataplane-roll.yml', null, 'roll'],
];

for (const [file, boundary, target] of LANES) {
  test(`${file}: calls the gate and stands ${target} down on standdown == 'true'`, () => {
    const text = wf(file);
    const gate = jobBlock(text, 'estate-gate');
    assert.match(gate, /uses: \.\/\.github\/workflows\/estate-pause-gate\.yml/, 'estate-gate must be the reusable gate');
    assert.match(gate, /secrets: inherit/);
    if (boundary) assert.match(gate, new RegExp(`boundary: ${boundary}\\b`), `boundary must be ${boundary}`);
    else assert.match(gate, /GCC-High[\s\S]*IL5[\s\S]*Commercial/, 'boundary must be derived from inputs.boundary for all three');

    const block = jobBlock(text, target);
    assert.match(block, /needs:.*estate-gate/, `${target} must need estate-gate`);
    const cond = jobIf(block);
    // `!= 'true'` is the fail-open spelling (non-schedule): an unrun gate leaves the output empty.
    assert.ok(cond.includes("needs.estate-gate.outputs.standdown != 'true'"), `${target} if: must test standdown != 'true' (got: ${cond.slice(0, 200)})`);
    // `== 'false'` is allowed ONLY inside the schedule branch, which also requires the gate to have succeeded.
    const frag = gateFragment(cond);
    assert.ok(frag, `${target} if: must carry the schedule/gate-result expression`);
    assert.ok(cond.replace(frag, '').indexOf("standdown == 'false'") < 0, "== 'false' outside the schedule branch would FREEZE a dispatch when the gate fails to run");
  });

  test(`${file}: ${target} gate expression is fail-CLOSED on schedule, fail-OPEN elsewhere (evaluated, not pattern-matched)`, () => {
    const frag = gateFragment(jobIf(jobBlock(wf(file), target)));
    assert.ok(frag, 'expression missing');
    // schedule: only (gate success AND standdown 'false') proceeds. The breaking values for the
    // 2026-10-24 incident are result 'cancelled'/'failure' with standdown '' (no outputs).
    for (const result of ['cancelled', 'failure', 'skipped']) {
      assert.equal(evalGate(frag, { event: 'schedule', result, standdown: '' }), false, `schedule + gate ${result} + no outputs must STAND DOWN`);
    }
    assert.equal(evalGate(frag, { event: 'schedule', result: 'success', standdown: 'true' }), false, 'schedule + paused must stand down');
    assert.equal(evalGate(frag, { event: 'schedule', result: 'success', standdown: '' }), false, 'schedule + success but EMPTY standdown must stand down');
    assert.equal(evalGate(frag, { event: 'schedule', result: 'failure', standdown: 'false' }), false, 'schedule + failed gate must stand down even if a stale false is visible');
    assert.equal(evalGate(frag, { event: 'schedule', result: 'success', standdown: 'false' }), true, 'positive: a healthy gate on a schedule must proceed');
    // everything else keeps today's fail-open behaviour
    for (const event of ['workflow_dispatch', 'push', 'workflow_run']) {
      assert.equal(evalGate(frag, { event, result: 'cancelled', standdown: '' }), true, `${event} + gate cancelled/no outputs must PROCEED (fail-open)`);
      assert.equal(evalGate(frag, { event, result: 'success', standdown: 'true' }), false, `${event} + paused must stand down`);
    }
  });

  // Breaks if any edit drops the parentheses around the gate expression (e.g. `!cancelled() && x && A || B`):
  // the || branch would then bypass every other precondition of the lane (review of #5114, non-blocking 1).
  test(`${file}: ${target} if: has NO top-level || (the gate expression cannot bypass the lane's other terms)`, () => {
    const cond = jobIf(jobBlock(wf(file), target));
    assert.equal(topLevelOrs(cond), 0, `top-level || in ${target} if: ${cond.slice(0, 240)}`);
    // Positive control: the detector does see a top-level || (and ignores one inside parentheses).
    assert.equal(topLevelOrs("${{ !cancelled() && inputs.x && a == 'b' || c != 'd' }}"), 1);
    assert.equal(topLevelOrs("${{ !cancelled() && (a == 'b' || c != 'd') }}"), 0);
    assert.equal(topLevelOrs("${{ a == '(x || y' }}"), 0, 'a || inside a string literal is not an operator');
  });

  test(`${file}: override_estate_pause is a boolean input defaulting to false`, () => {
    const text = wf(file);
    const m = text.match(/^ {6}override_estate_pause:\n([\s\S]*?)(?=^ {6}\S|^\S|^ {2}\S)/m);
    assert.ok(m, 'input override_estate_pause missing');
    assert.match(m[1], /type: boolean/);
    assert.match(m[1], /default: false/, 'the override must be OFF by default');
    // The value handed to the gate comes from the input only; nothing forces it true.
    assert.match(jobBlock(text, 'estate-gate'), /override_estate_pause: \$\{\{ inputs\.override_estate_pause == true \}\}/);
  });
}

// Breaks if the full-app gate reads the state at RUN START (no needs): a pause taken during the 20+ min image build
// would be missed and the roll would undo it (review of #5113). It must also survive a skipped/failed build.
test('full-app-deploy-commercial: the gate reads the state AFTER the build, just before the roll', () => {
  const text = wf('full-app-deploy-commercial.yml');
  const gate = jobBlock(text, 'estate-gate');
  assert.match(gate, /^    needs: \[close-acr, verify-images\]$/m, 'the gate must wait for the build to finish');
  assert.match(jobIf(gate), /!cancelled\(\)/, 'a skipped or failed build must not skip the gate (it would leave standdown empty: proceed)');
  // Positive pair: the roll still waits on the gate and honours its verdict.
  const roll = jobBlock(text, 'redeploy-with-apps');
  assert.match(roll, /needs: \[[^\]]*estate-gate[^\]]*\]/);
  assert.match(jobIf(roll), /needs\.estate-gate\.outputs\.standdown != 'true'/);
  // The summary says "stood down", so a skipped roll never reads as a plain skip.
  assert.match(jobBlock(text, 'notify'), /STOOD DOWN: the estate is paused/);
  assert.match(jobBlock(text, 'notify'), /STOOD DOWN: estate state could not be established on a scheduled run \(fail-closed\)/, 'a fail-closed stand-down must not be reported as "estate is paused"');
});

test('every workflow that calls the gate is in LANES (a new caller cannot skip the schedule rule)', () => {
  const called = readdirSync(join(ROOT, '.github', 'workflows'))
    .filter((f) => f.endsWith('.yml') && f !== 'estate-pause-gate.yml' && wf(f).includes('estate-pause-gate.yml'))
    .sort();
  assert.deepEqual(called, [...LANES.map(([f]) => f), ...DEDICATED_LANES].sort(), 'a workflow calls estate-pause-gate.yml but is not covered by the lane tests');
});

// ── deploy-health.yml: dispatch-only, so it has no schedule branch and cannot use the LANES
// expression shape. Its verdict lives in ONE step ("Estate pause verdict"), so these tests EXECUTE
// that step's script under bash with chosen inputs instead of pattern-matching it.
const HEALTH = 'deploy-health.yml';

/** The `run:` script of the named step, lifted from the workflow text (not transcribed). */
function stepScript(text, stepName) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(i >= 0, `step "${stepName}" not found`);
  const r = lines.findIndex((l, k) => k > i && /^ {8}run: \|$/.test(l));
  assert.ok(r > i, `step "${stepName}" has no run: block`);
  const body = [];
  for (let k = r + 1; k < lines.length && (lines[k] === '' || /^ {10}/.test(lines[k])); k += 1) body.push(lines[k].slice(10));
  return body.join('\n');
}

/** Run the verdict script; returns the standdown output it wrote. */
function healthVerdict(env) {
  const dir = mkdtempSync(join(tmpdir(), 'health-verdict-'));
  const out = join(dir, 'out');
  const summary = join(dir, 'summary');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  const script = stepScript(wf(HEALTH), 'Estate pause verdict');
  const r = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, BOUNDARY: 'Commercial', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, OVERRIDE_PAUSE: 'false', ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `verdict script failed: ${r.stderr}`);
  const m = readFileSync(out, 'utf8').match(/^standdown=(.*)$/m);
  assert.ok(m, 'the verdict step wrote no standdown output at all');
  return m[1];
}

const OK = { RUN_MODE: 'full', DECLARED: 'false', GATE_RESULT: 'success', GATE_STANDDOWN: 'false', GATE_STATE: 'RUNNING' };

test('deploy-health: calls the reusable gate with the dispatched boundary, and the override defaults to false', () => {
  const text = wf(HEALTH);
  const gate = jobBlock(text, 'estate-gate');
  assert.match(gate, /uses: \.\/\.github\/workflows\/estate-pause-gate\.yml/);
  assert.match(gate, /boundary: \$\{\{ inputs\.boundary \}\}/, 'a hard-coded boundary would read the wrong estate for the other one');
  assert.match(gate, /override_estate_pause: \$\{\{ inputs\.override_estate_pause == true \}\}/);
  const m = text.match(/^ {6}override_estate_pause:\n([\s\S]*?)(?=^ {6}\S|^\S|^ {2}\S)/m);
  assert.ok(m && /type: boolean/.test(m[1]) && /default: false/.test(m[1]), 'the override must be a boolean that is OFF by default');
});

test('deploy-health: every mutating step is guarded by the verdict, and the deploy job needs the gate and the declaration', () => {
  const text = wf(HEALTH);
  const deploy = jobBlock(text, 'deploy');
  assert.match(deploy, /needs: \[[^\]]*estate-gate[^\]]*\]/, 'deploy must wait for the observed gate');
  assert.match(deploy, /needs: \[[^\]]*pause-declaration[^\]]*\]/, 'deploy must wait for the declaration');
  // FAILS IF: an apply, hub-discovery or guard step loses its `standdown != 'true'` clause.
  for (const name of ['Discover the hub (registry and Container Apps environment)', 'Image preflight - loom-health-cp tag exists in the registry', 'Bicep what-if', 'Deploy health.bicep']) {
    const i = deploy.split('\n').findIndex((l) => l.trim() === `- name: ${name}`);
    assert.ok(i >= 0, `step ${name} not found`);
    const window = deploy.split('\n').slice(i, i + 6).join('\n');
    assert.match(window, /steps\.verdict\.outputs\.standdown != 'true'/, `${name} must stand down on the verdict`);
  }
});

test('deploy-health: a full run STANDS DOWN when paused (inputs: gate standdown true; declaration true)', () => {
  // FAILS IF: the observed clause is dropped (GATE_STANDDOWN=true would then proceed).
  assert.equal(healthVerdict({ ...OK, GATE_STANDDOWN: 'true', GATE_STATE: 'PAUSED' }), 'true');
  // FAILS IF: the declaration clause is dropped (DECLARED=true would then proceed).
  assert.equal(healthVerdict({ ...OK, DECLARED: 'true' }), 'true');
  // Positive control: the same env with nothing paused proceeds, so the two reds above are not a constant 'true'.
  assert.equal(healthVerdict(OK), 'false');
});

test('deploy-health: a full run FAILS CLOSED on an unknown state (inputs: gate failure, empty standdown, empty declaration)', () => {
  // FAILS IF: the gate-result check is dropped, since a failed gate leaves standdown empty and '' != 'true'.
  for (const GATE_RESULT of ['failure', 'cancelled', 'skipped']) {
    assert.equal(healthVerdict({ ...OK, GATE_RESULT, GATE_STANDDOWN: '' }), 'true', `gate ${GATE_RESULT} with no outputs must stand down`);
  }
  // The gate-result clause is the ONLY thing that catches a failed gate that still shows a stale
  // standdown 'false' (with empty outputs the standdown clause catches it too, so the loop above
  // cannot witness the result clause). FAILS IF: the GATE_RESULT check is dropped.
  assert.equal(healthVerdict({ ...OK, GATE_RESULT: 'failure', GATE_STANDDOWN: 'false' }), 'true');
  // FAILS IF: standdown is compared with != 'true' instead of != 'false' (an empty value from a succeeded gate).
  assert.equal(healthVerdict({ ...OK, GATE_STANDDOWN: '' }), 'true');
  // FAILS IF: an empty declaration is read as "not declared paused".
  assert.equal(healthVerdict({ ...OK, DECLARED: '' }), 'true');
});

test('deploy-health: whatif-only never stands down, and the override is honoured only on a full run', () => {
  // A what-if is read-only, so it must run on a paused estate. FAILS IF: the RUN_MODE guard is dropped.
  assert.equal(healthVerdict({ ...OK, RUN_MODE: 'whatif-only', DECLARED: 'true', GATE_STANDDOWN: 'true', GATE_RESULT: 'failure' }), 'false');
  // The explicit operator override proceeds past a paused estate. FAILS IF: the override is ignored.
  assert.equal(healthVerdict({ ...OK, OVERRIDE_PAUSE: 'true', DECLARED: 'true', GATE_STANDDOWN: 'true' }), 'false');
});

test('commercial: a schedule cannot reach the override and whatif-only still runs', () => {
  const cond = jobIf(jobBlock(wf('deploy-fiab-commercial.yml'), 'deploy-validate'));
  assert.ok(cond.includes("github.event_name == 'workflow_dispatch' && inputs.run_mode != 'full'"), 'only a dispatched whatif-only run may bypass the stand-down');
  assert.ok(!/override/.test(cond), 'the job condition must not read the override: the script alone decides (dispatch-only)');
});

test('gcch: a scheduled run never calls the gate (it never applies) and the stand-down precedes the approval gate', () => {
  const text = wf('deploy-fiab-gcch.yml');
  assert.ok(jobIf(jobBlock(text, 'estate-gate')).includes("github.event_name != 'schedule'"));
  assert.match(jobBlock(text, 'deploy-validate'), /environment: gcc-high-deploy/, 'control: the approval environment is still on the job whose if: now stands down');
});

test('the gate workflow: fail-closed marker job exists only on a scheduled unreadable/failed gate and says so', () => {
  const text = wf('estate-pause-gate.yml');
  const u = jobBlock(text, 'stood-down-unknown');
  const cond = jobIf(u);
  // Breaks if `always()` is dropped (a failed/timed-out gate would skip the marker job: silent stand-down).
  assert.ok(cond.includes('always()'), 'must run after a FAILED gate job');
  assert.ok(cond.includes("github.event_name == 'schedule'"), 'must exist only on a scheduled run (a dispatch proceeds)');
  assert.ok(cond.includes("needs.gate.result != 'success'"), 'must fire when the gate job failed/timed out (no outputs)');
  assert.ok(cond.includes("needs.gate.outputs.state == 'UNKNOWN'"), 'must fire when the script read UNKNOWN');
  assert.match(u, /name: Stood down - estate state unknown/);
  assert.match(u, /Stood down: estate state could not be established on a scheduled run \(fail-closed\)/);
  // The paused marker must NOT also claim "estate paused" for an UNKNOWN stand-down.
  assert.ok(jobIf(jobBlock(text, 'stood-down')).includes("needs.gate.outputs.state != 'UNKNOWN'"), 'an UNKNOWN stand-down must not be reported as a paused estate');
  assert.ok(!/continue-on-error|\|\| true|2>\/dev\/null/.test(u));
});

test('the gate workflow: fail-open, marker job only on standdown, no result-discarding', () => {
  const text = wf('estate-pause-gate.yml');
  const gate = jobBlock(text, 'gate');
  assert.ok(!/continue-on-error|\|\| true|2>\/dev\/null/.test(gate), 'deploy-integrity.md forbids discarding results in a deploy path');
  assert.match(gate, /node scripts\/ci\/estate-pause-state\.mjs --boundary "\$BOUNDARY"/);
  const sd = jobBlock(text, 'stood-down');
  assert.ok(jobIf(sd).includes("needs.gate.outputs.standdown == 'true'"), 'the marker job must exist ONLY on a stand-down');
  assert.match(sd, /name: Stood down - estate paused/);
  assert.match(text, /Stood down: estate paused/, 'job summary must say so plainly');
});

test('the lanes that stay running do NOT call the gate: console-only rolls', () => {
  // loom-roll-and-validate and gov-console-roll roll only loom-console, which Estate Power never pauses.
  for (const f of ['loom-roll-and-validate.yml', 'gov-console-roll.yml']) {
    assert.ok(!wf(f).includes('estate-pause-gate.yml'), `${f} rolls only the console and must keep running while paused`);
  }
});
