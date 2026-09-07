/*
 * #3857 — the Copilot eval gate must not fail a PR on a measurement the same
 * run explicitly disclaims.
 *
 * THE DEFECT, MEASURED
 *
 *   `copilot-quality-evals.yml` runs the eval sweep against the console, and the
 *   console indexes the corpus BAKED INTO ITS IMAGE — so on a `pull_request` the
 *   scores are produced against the DEPLOYED corpus, not the diff (#3085). The
 *   workflow knows this: a "Corpus provenance" step compares what the console
 *   SERVED against what the checkout carries and prints, verbatim, "**This eval
 *   did NOT measure this diff.**"
 *
 *   That step ran AFTER the gate. So the order of events on a corpus PR was:
 *   gate decides, PR goes red, and only then does the run explain that the
 *   verdict was never about the PR. And provenance is UNRESOLVED on every
 *   current run — the eval-probe answers HTTP 403 (runs 33670827038:435,
 *   33696595668:640) — so EVERY PR-attached verdict was an estate verdict.
 *
 *   Asserting a verdict about a diff while the same run states it is not about
 *   that diff is deploy-integrity R7 at the workflow level.
 *
 * WHY A STRUCTURAL TEST AND NOT A COMMENT
 *
 *   Step ORDER is the fix. Order is exactly the property that gets undone by an
 *   unrelated edit — a step inserted, a block moved during a merge — with no
 *   review signal at all, because nothing about the YAML looks wrong afterwards.
 *   So the order is asserted mechanically, together with the branch that makes
 *   it matter. Reverting either half fails a NAMED test here.
 *
 * DEPENDENCY-FREE ON PURPOSE. This suite runs under
 * `node --test scripts/ci/__tests__/*.test.mjs` in loom-guardrails.yml with no
 * install step, so there is no YAML parser available. Steps are located by their
 * `- name:` lines at the job's step indent, and every anchor is asserted to
 * exist before anything is concluded from its position — a locator that found
 * nothing must not read as "the order is fine".
 *
 * Run: node --test scripts/ci/__tests__/copilot-eval-gate-provenance.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WF = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'copilot-quality-evals.yml',
);
const SRC = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

/**
 * The `evals` job's step list: `{name, body}` in file order.
 *
 * The job region is bounded by the next top-level job key so a step in
 * `report-outcome` can never be mistaken for one here.
 */
function evalsSteps() {
  const start = SRC.indexOf('\n  evals:\n');
  assert.ok(start > 0, 'the `evals` job was renamed — this suite lost its subject');
  const after = SRC.indexOf('\n  report-outcome:\n', start);
  assert.ok(after > start, 'the `report-outcome` job was renamed — the job region is unbounded');
  const region = SRC.slice(start, after);

  const out = [];
  const re = /^ {6}- name: (.+)$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(region)) !== null) marks.push({ name: m[1].trim(), at: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : region.length;
    out.push({ name: marks[i].name, body: region.slice(marks[i].at, end) });
  }
  return out;
}

const steps = evalsSteps();
const indexOfStep = (needle) => steps.findIndex((s) => s.name.includes(needle));

test('#3857 — provenance is established BEFORE the gate decides', () => {
  // Non-degenerate first: both anchors exist. A findIndex of -1 on both would
  // otherwise satisfy `<` in one direction and prove nothing in either.
  assert.ok(steps.length >= 8, `only ${steps.length} steps found in the evals job — the locator drifted`);
  const prov = indexOfStep('Corpus provenance');
  const gate = indexOfStep('Gate — check-eval-regression');
  assert.notEqual(prov, -1, 'the "Corpus provenance" step is gone — #3085 disclosure lost');
  assert.notEqual(gate, -1, 'the "Gate — check-eval-regression" step is gone');
  assert.ok(
    prov < gate,
    `the corpus-provenance step (index ${prov}) runs AFTER the gate (index ${gate}). The gate then ` +
      'decides — and on a PR goes red — before anything has established which corpus was measured, ' +
      'and the very next step prints "This eval did NOT measure this diff" over an already-red ' +
      'check (#3857).',
  );

  // The banner still reaches the sticky comment, which is what made the old
  // ordering tolerable. Moving provenance up without moving the merge would
  // silently drop it: eval-summary.md does not exist yet when provenance runs.
  const fold = indexOfStep('Fold the provenance banner');
  assert.notEqual(fold, -1, 'nothing folds corpus-provenance.md into eval-summary.md — the sticky comment lost the disclosure');
  assert.ok(fold > gate, 'the fold step runs before the gate produced eval-summary.md');
});

test('#3857 — provenance PUBLISHES its verdict and the gate CONSUMES it', () => {
  const prov = steps[indexOfStep('Corpus provenance')];
  const gate = steps[indexOfStep('Gate — check-eval-regression')];

  assert.match(prov.body, /^\s*id: prov$/m, 'the provenance step has no id — the gate cannot read its outputs');
  assert.match(prov.body, /echo "state=\$STATE"/, 'the provenance step no longer publishes its state');
  assert.match(prov.body, /STATE=unresolved/, 'the unresolved state is gone');
  assert.match(prov.body, /STATE=differs/, 'the differs state is gone');
  assert.match(prov.body, /STATE=match/, 'the match state is gone');
  // The three states must be DISTINCT, or a single value could satisfy every
  // branch and the gate's decision below would be constant.
  assert.equal(new Set(['unresolved', 'differs', 'match']).size, 3);

  assert.match(
    gate.body,
    /PROV_STATE: \$\{\{ steps\.prov\.outputs\.state \}\}/,
    'the gate no longer reads the provenance state — it is deciding without it again',
  );
});

test('#3857 — a PR whose provenance is NOT a match is REPORTED, not failed', () => {
  const gate = steps[indexOfStep('Gate — check-eval-regression')];

  // The branch itself: PR + not-match -> report only.
  assert.match(
    gate.body,
    /github\.event_name \}\}" = 'pull_request' \] && \[ "\$\{PROV_STATE:-unresolved\}" != 'match' \]/,
    'the PR/non-match branch is gone — an estate verdict can fail a diff again (#3857)',
  );
  assert.match(gate.body, /REPORT_ONLY=1/, 'the report-only flag is gone');

  // …and it really exits 0 on a non-zero gate result, having SAID SO.
  assert.match(gate.body, /GATE_RC=\$\?/, 'the gate result is no longer captured');
  assert.match(
    gate.body,
    /echo "gate_rc=\$GATE_RC"\n\s*echo "gate_reported_only=true"\n\s*\} >> "\$GITHUB_OUTPUT"/,
    'the downgraded result is not recorded to the step output',
  );
  assert.match(gate.body, /ESTATE VERDICT, not a verdict on this diff/, 'the downgrade is no longer explained to the reader');

  // The other direction, which is the half that keeps this from being a
  // weakening: push and schedule, and a PR whose provenance MATCHED, still run
  // the gate under `set -e` with no rc capture, so a real regression is red.
  //
  // Asserted on the BRANCH's contents rather than on one exact spelling of it:
  // the enforcing arm must invoke the gate, and must contain neither an rc
  // capture nor an `set +e`, because either would let a failure through.
  //
  // `REPORT_ONLY` is branched on TWICE — once inside the zero-measured block to
  // pick error-vs-warning, and once at the run block's top level to pick
  // enforce-vs-report. Only the second one is this test's subject, so the arm is
  // located by the top-level indent and the pair is asserted to be exactly that.
  const allBranches = gate.body.match(/^ *if \[ "\$REPORT_ONLY" -eq 0 \]; then$/gm) ?? [];
  assert.equal(allBranches.length, 2, `expected the inner (error/warning) and outer (enforce/report) REPORT_ONLY branches, found ${allBranches.length}`);
  const enforcing = /^ {10}if \[ "\$REPORT_ONLY" -eq 0 \]; then\n([\s\S]*?)\n {10}else\n/m.exec(gate.body);
  assert.ok(enforcing, 'the ENFORCING path is gone — the gate no longer hard-fails on push/schedule or on a matched PR');
  assert.match(
    enforcing[1],
    /node scripts\/csa-loom\/check-eval-regression\.mjs "\$\{ARGS\[@\]\}"/,
    'the enforcing arm no longer runs the gate',
  );
  assert.doesNotMatch(enforcing[1], /set \+e/, 'the enforcing arm disabled `set -e`, so a gate failure cannot reach the job');
  assert.doesNotMatch(enforcing[1], /\$\?/, 'the enforcing arm captures the rc, which is how a failure gets swallowed');
  assert.match(gate.body, /set -euo pipefail/, 'the gate stopped failing on an unset variable or a pipeline error');

  // The result is downgraded deliberately, never DISCARDED. `|| true` and
  // `2>/dev/null` in a gate are the shapes this repo has recorded as a control
  // that cannot fail; `set +e` with the rc read on the next line is not.
  assert.doesNotMatch(gate.body, /\|\| true/, 'the gate discards a result with `|| true`');
  assert.doesNotMatch(gate.body, /2>\/dev\/null/, 'the gate discards stderr');
  assert.doesNotMatch(gate.body, /continue-on-error/, 'the gate was made unable to fail at the step level');
});

test('#3857 — the ZERO-MEASURED hard error survives the report-only path', () => {
  // The earlier fix this must not undo: a run that scored nothing at all is a
  // broken pipeline, not a partial run, and adds --strict-missing. Report-only
  // changes who the verdict is ATTACHED to, never whether it is computed.
  const gate = steps[indexOfStep('Gate — check-eval-regression')];
  assert.match(gate.body, /MEASURED=\$\(jq/, 'the measured-surface count is gone');
  assert.match(gate.body, /"\$MEASURED" -eq 0/, 'the zero-measured branch is gone');
  const strict = (gate.body.match(/--strict-missing/g) ?? []).length;
  assert.ok(strict >= 2, `expected --strict-missing on both the schedule and zero-measured paths, found ${strict}`);
});

test('#3857 — no ::error:: is emitted on a branch that ends in success', () => {
  // Measured 2026-09-06: the first cut of the report-only downgrade left the
  // zero-measured `::error::` above a branch that exits 0, and
  // check-annotation-teeth caught it (`the run block ends with a bare exit 0`).
  // A step that prints ::error:: and concludes success reports the opposite of
  // what it says (#2837, recurrence of #2787) — so the report-only arm states
  // the same finding as a ::warning:: that says it is reported, not enforced.
  const gate = steps[indexOfStep('Gate — check-eval-regression')];

  // REPORT_ONLY must be decided BEFORE the first annotation, or an ::error::
  // can be printed without knowing whether the step can still fail. The needle
  // is the `echo`, not the bare token: the rationale comment above the decision
  // NAMES ::error::, and matching that would put the "first error" before the
  // decision and fail this test on prose.
  const decidedAt = gate.body.indexOf('REPORT_ONLY=0');
  const firstError = gate.body.indexOf('echo "::error::');
  assert.ok(decidedAt >= 0, 'the report-only decision is gone');
  assert.ok(firstError >= 0, 'the zero-measured error annotation is gone entirely');
  assert.ok(
    decidedAt < firstError,
    'an ::error:: is emitted before the step knows whether it is allowed to fail',
  );

  // The ::error:: sits on the enforcing side of the branch; the report-only
  // side states the same condition as a warning that discloses its own status.
  assert.match(
    gate.body,
    /if \[ "\$REPORT_ONLY" -eq 0 \]; then\n\s*echo "::error::\$ZERO[^\n]*\n\s*else\n\s*echo "::warning::\$ZERO[^\n]*REPORTED, NOT ENFORCED/,
    'the zero-measured finding no longer splits error/warning by whether the step can fail',
  );

  // And the whole block must not end on a bare `exit 0` — the structural shape
  // check-annotation-teeth refuses.
  const effective = gate.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  assert.notEqual(
    effective[effective.length - 1],
    'exit 0',
    'the gate run block ends on a bare `exit 0`, hard-coding success over every verdict above it',
  );
});
