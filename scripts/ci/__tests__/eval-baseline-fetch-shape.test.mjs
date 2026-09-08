#!/usr/bin/env node
/**
 * #4277 — the eval DELTA baseline fetch may not fail open.
 *
 * WHAT WAS WRONG. `.github/workflows/copilot-quality-evals.yml`'s baseline step
 * ran under `set +e` and ended in `exit 0`. Three distinct outcomes collapsed
 * into one green step whose loudest output was a `::notice`:
 *
 *   (a) there is genuinely no prior successful run on main   — no delta to run
 *   (b) `gh run list` itself failed (token / API / rate)     — (a) NOT established
 *   (c) a prior run exists, its artifact would not download  — pipeline broken
 *
 * In (b) and (c) the gate quietly degraded to FLOORS ONLY and reported success.
 * Downstream, `check-eval-regression.mjs` enabled the delta half on the mere
 * existence of `prev/eval-run.json`, and its summary markdown said nothing at
 * all about the delta — so nothing the reader opens distinguished "the delta
 * passed" from "the delta never ran".
 *
 * The two halves of the ratchet:
 *   1. SCRIPT — with no baseline the summary carries a `Delta: NOT evaluated`
 *      line, and it never renders an absence the caller did not assert.
 *   2. WORKFLOW SHAPE — the step has no `set +e`/`exit 0` pair, captures `$?`
 *      on the line after `gh run list`, and turns (b) and (c) into `::error` +
 *      exit 1.
 *
 * Run: node --test scripts/ci/__tests__/eval-baseline-fetch-shape.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const GATE = join(REPO, 'scripts', 'csa-loom', 'check-eval-regression.mjs');
const WORKFLOW = join(REPO, '.github', 'workflows', 'copilot-quality-evals.yml');

/** A minimal run artifact in the shape the E2 HTTP trigger returns. */
function runArtifact(passRate) {
  return {
    ok: true,
    surfaces: [
      {
        surface: 'help',
        startedAt: '2026-09-01T00:00:00Z',
        totals: {
          questions: 10,
          rowsAttempted: 10,
          judged: 10,
          retrievalHitRate: 0.9,
          groundingAvg: 4.2,
          passRate,
        },
      },
    ],
  };
}

/** Run the real gate over a temp artifact and return its summary markdown. */
function gate(extraArgs, { withPrevious = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
  const artifact = join(dir, 'eval-run.json');
  const summary = join(dir, 'eval-summary.md');
  const floors = join(dir, 'floors.json');
  writeFileSync(artifact, JSON.stringify(runArtifact(0.9)));
  // No floors declared, so the FLOOR half cannot fail the run and the assertions
  // below are about the DELTA half alone.
  writeFileSync(floors, JSON.stringify({ floors: {} }));
  const args = ['--artifact', artifact, '--summary', summary, '--floors', floors];
  if (withPrevious) {
    const prev = join(dir, 'prev.json');
    writeFileSync(prev, JSON.stringify(runArtifact(0.88)));
    args.push('--previous', prev);
  }
  const r = spawnSync(process.execPath, [GATE, ...args, ...extraArgs], { encoding: 'utf8' });
  let md = '';
  try {
    md = readFileSync(summary, 'utf8');
  } catch {
    md = '';
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', md };
}

/* ── 1. the script says, in the artifact the reader opens, whether it ran ─── */

test('#4277 with a stated-ABSENT baseline the summary says Delta: NOT evaluated, and why', () => {
  const r = gate(['--delta-status', 'absent']);
  assert.equal(r.code, 0);
  assert.match(r.md, /Delta: NOT evaluated/);
  assert.match(r.md, /no prior successful main run/);
  // and it must say what that COSTS, not merely that it did not happen
  assert.match(r.md, /Only the FLOOR half of this gate ran/);
});

test('#4277 with NO --delta-status the summary says UNSTATED, never asserts absence', () => {
  const r = gate([]);
  assert.equal(r.code, 0);
  assert.match(r.md, /Delta: NOT evaluated/);
  assert.match(r.md, /did not state whether a baseline exists/);
  assert.doesNotMatch(
    r.md,
    /no prior successful main run/,
    'the gate cannot know there is no prior run — only the caller can (deploy-integrity R7)',
  );
});

test('#4277 with a real baseline the summary says the delta WAS evaluated', () => {
  const r = gate([], { withPrevious: true });
  assert.equal(r.code, 0);
  assert.match(r.md, /Delta: evaluated/);
  assert.doesNotMatch(r.md, /Delta: NOT evaluated/);
});

test('#4277 --previous is ground truth: a stated-absent status cannot mute a real delta', () => {
  const r = gate(['--delta-status', 'absent'], { withPrevious: true });
  assert.match(r.md, /Delta: evaluated/);
});

test('#4277 a --previous that does not exist is a REFUSAL, not a silent floor-only run', () => {
  // The path must not exist AND must not be pre-creatable by another local user,
  // so it is a name under a private mkdtemp dir rather than a constant under the
  // world-writable temp root (check-temp-artifact-safety.mjs).
  const scratch = mkdtempSync(join(tmpdir(), 'eval-baseline-4277-'));
  const r = gate(['--previous', join(scratch, 'no-such-baseline.json')]);
  assert.equal(r.code, 2, 'exit 2 = usage; running floors-only here would disable half the gate silently');
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /FLOOR-ONLY/);
});

test('#4277 an unknown --delta-status is rejected rather than silently treated as unstated', () => {
  const r = gate(['--delta-status', 'skipped']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--delta-status must be one of/);
});

/* ── 1b. `evaluated` may never come from the caller's word alone ──────────── */

test('#4277 --delta-status evaluated with NO baseline is REFUSED, never rendered as a comparison', () => {
  // The regression this pins: `previous ? 'evaluated' : (arg ?? 'unstated')`
  // made --previous SUFFICIENT but not NECESSARY, so this exact invocation
  // exited 0 and wrote "**Delta: evaluated** against the previous run." while
  // the delta half had not run — the same R7 shape #4277 exists to remove.
  const r = gate(['--delta-status', 'evaluated']);
  assert.equal(r.code, 2, 'a claim the process cannot corroborate is a refusal, not a render');
  assert.match(r.stderr, /no baseline was loaded/);
  assert.match(r.stderr, /did NOT run/);
  assert.doesNotMatch(r.md, /Delta: evaluated/, 'the false claim must not reach the summary at all');
});

test('#4277 --delta-status evaluated WITH a real baseline is still accepted', () => {
  // The refusal above must be narrow: it fires on the contradiction, not on the
  // word. The workflow passes `evaluated` alongside `--previous` on every
  // healthy run, and that path must stay green.
  const r = gate(['--delta-status', 'evaluated'], { withPrevious: true });
  assert.equal(r.code, 0);
  assert.match(r.md, /Delta: evaluated/);
});

test('#4277 the refusal names which of the two evidence gaps applies', () => {
  // R7 in the refusal itself: "no --previous was given" and "--previous yielded
  // nothing" are different operator actions and must not share a sentence.
  const r = gate(['--delta-status', 'evaluated']);
  assert.match(r.stderr, /no --previous argument was given/);
  assert.doesNotMatch(r.stderr, /yielded nothing/);
});

/* ── 2. the workflow shape that made the above reachable ─────────────────── */

/** Extract one `- name: …` step block from the workflow YAML, verbatim. */
function stepBlock(yaml, nameFragment) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s*-\s+name:/.test(l) && l.includes(nameFragment));
  assert.ok(start >= 0, `no step whose name contains ${JSON.stringify(nameFragment)}`);
  const indent = lines[start].match(/^(\s*)-/)[1].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*-\s+name:/.test(lines[i]) && lines[i].match(/^(\s*)-/)[1].length <= indent) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('#4277 the baseline step has NO set +e, and no TERMINAL exit 0 swallowing the verdict', () => {
  const step = stepBlock(readFileSync(WORKFLOW, 'utf8'), 'Fetch the previous run artifact');
  assert.doesNotMatch(step, /^\s*set \+e\s*$/m, '`set +e` is what let both failure modes pass');
  const body = step.split('\n').filter((l) => l.trim() !== '');
  assert.doesNotMatch(
    body[body.length - 1],
    /^\s*exit 0\s*$/,
    'a TERMINAL `exit 0` discards every verdict above it; the absent-baseline path must exit 0 '
    + 'from its own branch, leaving the failure branches able to exit 1',
  );
  assert.match(step, /set -uo pipefail/);
});

test('#4277 the baseline step captures $? on the line AFTER gh run list', () => {
  const step = stepBlock(readFileSync(WORKFLOW, 'utf8'), 'Fetch the previous run artifact');
  const lines = step.split('\n');
  const i = lines.findIndex((l) => l.includes('gh run list'));
  assert.ok(i >= 0, 'expected the baseline step to still list previous runs');
  assert.match(
    lines[i + 1],
    /RC=\$\?/,
    'the exit code must be captured on the NEXT line — anywhere later and it belongs to a different command',
  );
  // …and the captured code must actually be acted on.
  assert.match(step, /if \[ "\$RC" -ne 0 \]/);
});

test('#4277 an OBSERVATION failure and a DOWNLOAD failure are both ::error + exit 1', () => {
  const step = stepBlock(readFileSync(WORKFLOW, 'utf8'), 'Fetch the previous run artifact');
  const errors = step.split('\n').filter((l) => l.includes('::error::'));
  assert.ok(errors.length >= 2, `expected an ::error for the list failure AND the download failure, found ${errors.length}`);
  // R7 — the list-failure message must not claim there is no baseline.
  const listErr = errors.find((l) => /could not LIST/.test(l));
  assert.ok(listErr, 'expected an explicit "could not LIST previous runs" error');
  assert.match(listErr, /NOT established/);
  // R7 — and the download-failure message must not name a cause it did not
  // establish. The artifact upload is itself conditional
  // (`if: always() && steps.func.outputs.found == 'true'`), so a 404 here is
  // ALSO consistent with a successful run that legitimately uploaded nothing.
  const dlErr = errors.find((l) => /could not be downloaded/.test(l));
  assert.ok(dlErr, 'expected an explicit download-failure error');
  assert.match(dlErr, /does NOT establish which of the two causes applies/);
  assert.doesNotMatch(dlErr, /that is a pipeline failure/);
  assert.match(step, /gh run download/);
  assert.match(step, /exit 1/);
});

test('#4277 the ABSENT case is the only one that passes, and it is stated downstream', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const step = stepBlock(yaml, 'Fetch the previous run artifact');
  assert.match(step, /delta_status=absent/);
  assert.match(step, /Delta: NOT evaluated — no prior successful main run/);
  // and the gate step must actually forward it, or the summary reverts to silent
  const gateStep = stepBlock(yaml, 'check-eval-regression');
  assert.match(gateStep, /--delta-status/);
  assert.match(gateStep, /steps\.baseline\.outputs\.delta_status/);
});

test('#4277 delta_status=evaluated is written on the FILE, not on the download exit code', () => {
  // The download exit code is the wrong evidence. The run artifact is uploaded
  // with two `path:` entries and no `if-no-files-found:`, so the action default
  // `warn` applies: an artifact can exist, download cleanly, and carry only
  // eval-summary.md. The gate step then finds no prev/eval-run.json, omits
  // --previous, and used to still forward --delta-status evaluated.
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const step = stepBlock(yaml, 'Fetch the previous run artifact');
  // Ordering is a claim about EXECUTABLE lines. Comments in this step quote the
  // very strings being searched for, and a predicate that matches its own
  // rationale prose measures the comment, not the code — which is how the first
  // draft of this test located the "claim" nine lines above the guard.
  const lines = step.split('\n').filter((l) => !/^\s*#/.test(l));
  const guard = lines.findIndex((l) => /\[\s*!\s*-f\s+prev\/eval-run\.json\s*\]/.test(l));
  assert.ok(guard >= 0, 'the step must test for the baseline FILE before claiming a baseline');
  const claim = lines.findIndex((l) => /delta_status=evaluated"?\s*>>/.test(l));
  assert.ok(claim >= 0, 'expected the evaluated claim to still be written on the healthy path');
  assert.ok(
    guard < claim,
    'the file guard must precede the claim — after it, the claim is already in $GITHUB_OUTPUT',
  );
  // and the guard must FAIL the step, not warn
  const guardBlock = lines.slice(guard, claim).join('\n');
  assert.match(guardBlock, /::error::/);
  assert.match(guardBlock, /exit 1/);
  // R7 — it must not assert that there is no prior run, which it did not establish
  assert.match(guardBlock, /NOT established that there is no prior run/);
});

test('#4277 the upload that makes the empty-artifact case reachable is still unconstrained', () => {
  // A premise check, not a requirement: if someone later adds
  // `if-no-files-found: error` to this upload the guard above becomes belt-and-
  // braces rather than load-bearing, and this test says so out loud instead of
  // leaving the rationale stale. It asserts the CURRENT shape.
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const step = stepBlock(yaml, 'Upload the run artifact');
  assert.match(step, /name: copilot-quality-eval-run/);
  assert.match(step, /eval-run\.json/);
  assert.match(step, /eval-summary\.md/);
});
