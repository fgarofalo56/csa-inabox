// The deploy lanes that wake or rescale paused resources must call the estate
// pause gate and honour its verdict (PRP-02 step 6, #5111). Each assertion names
// the edit that would break it (assertion-design.md). Workflow text is read, not
// transcribed: lane names and job names come from the files themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// lane file, boundary the gate is called with, the job that must stand down
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
    // `!= 'true'` is the fail-open spelling: an unrun gate leaves the output empty.
    assert.ok(cond.includes("needs.estate-gate.outputs.standdown != 'true'"), `${target} if: must test standdown != 'true' (got: ${cond.slice(0, 200)})`);
    assert.ok(!cond.includes("standdown == 'false'"), "== 'false' would FREEZE the lane when the gate fails to run");
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
