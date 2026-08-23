#!/usr/bin/env node
/**
 * gov-deploy-lanes.test.mjs — structural guards for the three deploy-lane
 * defects fixed under #3844 / #3416 / #3346.
 *
 * Run: node --test .github/scripts/__tests__/gov-deploy-lanes.test.mjs
 * CI:  discovered automatically by scripts/ci/check-node-test-suites.mjs, which
 *      `loom-guardrails.yml` runs as a REQUIRED check. `.github` is not in that
 *      discoverer's SKIP_DIRS, and its sibling
 *      `.github/scripts/__tests__/deploy-notify-failure.test.mjs` is already in
 *      the discovered set — verified, not assumed.
 *
 * WHY A SUITE AND NOT THREE ASSERTIONS
 *
 *   All three defects are the same shape: a deploy lane that LOOKS wired and is
 *   not. gov-console-roll rolled Gov on every merge and filed nothing when it
 *   reverted; gov-provision-runner-images built with `--no-logs` and threw the
 *   only copy of the failure away; loom-dataplane-roll existed to give three
 *   Container Apps a roll path and was itself reachable only by hand. None of
 *   the three would ever go red on its own — that is what makes them a class.
 *
 * EVERY GUARD HERE DECLARES ITS POPULATION
 *
 *   A guard over an empty set is green and blind, and this repository has been
 *   burned by that specific shape repeatedly. So each ratchet below asserts a
 *   FLOOR on the number of files it matched before it asserts anything about
 *   them, and each has a SELF-DEFENCE test proving the predicate still fires on
 *   the verbatim before-shape.
 *
 * THE COMMENT TRAP IS REAL HERE, NOT HYPOTHETICAL
 *
 *   Three workflows in this tree mention `--no-logs` ONLY inside comments —
 *   console-bluegreen-roll.yml, gov-console-roll.yml and loom-guardrails.yml.
 *   gov-console-roll's two mentions are the sentence "the `--no-logs` opt-out is
 *   gone", i.e. the exact opposite of the defect. A matcher written as
 *   `src.includes('--no-logs')` reports a population of 12 and flags three
 *   compliant files; the comment-stripped matcher reports 9 and flags none of
 *   them. Those three files are kept as LIVE negative controls below rather than
 *   as fixtures, because a fixture cannot rot the way the tree can.
 *
 * CRLF
 *
 *   The workflow blobs are LF in git but CRLF in a Windows working tree. Every
 *   matcher here splits on /\r?\n/ and rejoins with \n, so no needle in this
 *   file can silently match zero because of a line terminator.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const WF_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Raw source of a workflow, newline-normalised to \n. */
export function readWorkflow(name) {
  return fs.readFileSync(path.join(WF_DIR, name), 'utf8').split(/\r?\n/).join('\n');
}

/** Every workflow filename in .github/workflows, sorted. */
export function workflowNames() {
  return fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

/**
 * Drop whole-line comments. Deliberately NOT a trailing-`#` stripper: a `#`
 * inside a shell string on a `run:` line is not a comment, and removing it would
 * make this guard lie in the other direction.
 */
export function stripComments(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * Split a workflow into its named steps, in file order. Comments are stripped
 * first so a step name quoted inside a comment cannot invent a step.
 * Un-named steps (`- uses:`) fold into the preceding step's body, which is fine:
 * every step these guards reason about is named.
 */
export function namedSteps(src) {
  const lines = stripComments(src).split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1], body: [line] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out.map((s, index) => ({ name: s.name, index, text: s.body.join('\n') }));
}

/** The top-level `permissions:` block body, or null when there is none. */
export function topLevelPermissions(src) {
  const m = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(`${stripComments(src)}\n`);
  return m ? m[1] : null;
}

/** The top-level trigger keys under `on:`. */
export function triggerKeys(src) {
  const code = stripComments(src);
  const m = /^on:\n((?:[ \t].*\n|\n)+?)(?=^\S)/m.exec(`${code}\n`);
  if (!m) return [];
  return [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// #3844 — gov-console-roll must file a notice when it reverts
// ─────────────────────────────────────────────────────────────────────────────

const GOV_ROLL = 'gov-console-roll.yml';

/** True when the workflow grants itself the permission the filer needs. */
export function grantsIssuesWrite(src) {
  const perms = topLevelPermissions(src);
  return perms !== null && /^\s+issues:\s*write\s*$/m.test(perms);
}

/** True when SOME `if: failure()` step invokes the shared filer with --result. */
export function filesOnFailure(src, workflowArg) {
  // THE ARG IS MATCHED WITH A RIGHT BOUNDARY, NOT AS A SUBSTRING. `includes()`
  // was the first cut and a mutation walked straight through it: changing
  // `--workflow gov-console-roll` to `--workflow gov-console-rolls` left the
  // substring intact, so the guard stayed green over a lane filing into an issue
  // titled for a workflow that does not exist. `[\w-]` is the right class
  // because every real value here is kebab-case.
  const argRe = new RegExp(`--workflow\\s+${workflowArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  return namedSteps(src).some(
    (s) =>
      /^\s+if:\s*failure\(\)\s*$/m.test(s.text) &&
      s.text.includes('.github/scripts/deploy-notify-failure.mjs') &&
      argRe.test(s.text) &&
      /--result\b/.test(s.text),
  );
}

test('#3844 — gov-console-roll grants issues:write AND files on failure', () => {
  const src = readWorkflow(GOV_ROLL);
  // The lane still has to BE the continuous-deploy lane, or this guard is
  // protecting something that no longer exists.
  assert.ok(triggerKeys(src).includes('push'), 'gov-console-roll no longer fires on push — this guard is guarding the wrong lane');
  assert.ok(grantsIssuesWrite(src), 'gov-console-roll has no `issues: write`; the filer would 403 and the revert would stay silent (#3844)');
  assert.ok(filesOnFailure(src, 'gov-console-roll'), 'gov-console-roll has no `if: failure()` step invoking deploy-notify-failure.mjs with --workflow gov-console-roll --result (#3844)');
});

test('#3844 SELF-DEFENCE — both predicates fire on the verbatim before-shape', () => {
  // The permissions block exactly as it stood at the merge-base.
  const before = [
    'permissions:',
    '  contents: read',
    '  # SC1: keyless cosign signing exchanges the Actions OIDC token for a',
    '  # short-lived Fulcio certificate.',
    '  id-token: write',
    '',
    'concurrency:',
    '  group: x',
  ].join('\n');
  assert.equal(grantsIssuesWrite(before), false, 'the permissions matcher must NOT pass a block with no issues: write');
  assert.equal(grantsIssuesWrite(`${before.replace('  id-token: write', '  id-token: write\n  issues: write')}`), true, 'and MUST pass once it is added');

  // A notifier is not enough on its own: it has to be gated on failure() AND
  // carry --result, because `if: always()` + no --result is how #3368's false
  // P0 was manufactured.
  const step = (guard, flags) =>
    [
      '      - name: Notify on failure',
      `        if: ${guard}`,
      '        run: |',
      `          node .github/scripts/deploy-notify-failure.mjs --workflow gov-console-roll ${flags}`,
    ].join('\n');
  assert.equal(filesOnFailure(step('failure()', '--result "x"'), 'gov-console-roll'), true, 'the compliant shape must pass');
  assert.equal(filesOnFailure(step('always()', '--result "x"'), 'gov-console-roll'), false, 'an always() notifier must NOT count as failure notification');
  assert.equal(filesOnFailure(step('failure()', '--failure-json f.json'), 'gov-console-roll'), false, 'a notifier without --result must NOT count (#3368)');
  assert.equal(filesOnFailure(step('failure()', '--result "x"'), 'some-other-lane'), false, 'the matcher must be keyed to THIS lane, not to any notifier in the file');
  assert.equal(filesOnFailure('jobs:\n  roll:\n    steps:\n      - name: Roll\n        run: echo hi\n', 'gov-console-roll'), false, 'a lane with no notifier at all must NOT pass');

  // REGRESSION PIN — the substring hole a mutation found. `includes()` on
  // `--workflow gov-console-roll` is satisfied by `--workflow gov-console-rolls`,
  // so the guard stayed green while the lane filed into an issue titled for a
  // workflow that does not exist. The right boundary is what closes it.
  assert.equal(
    filesOnFailure(step('failure()', '--result "x"').replace('gov-console-roll ', 'gov-console-rolls '), 'gov-console-roll'),
    false,
    'a --workflow value with THIS lane as a prefix must NOT satisfy the matcher',
  );
  assert.equal(
    filesOnFailure(step('failure()', '--result "x"').replace('gov-console-roll ', 'xgov-console-roll '), 'gov-console-roll'),
    false,
    'and neither must one with this lane as a suffix',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #3844 (second half) — a notification gated on an UNSET repo variable is inert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lanes whose failure notice degrades to `core.warning` when a repo variable is
 * unset. Measured 2026-08-23: `gh variable list` returns 10 variables and
 * FIAB_GOV_DEPLOY_TRACKING_ISSUE is not among them, so every lane below posts
 * NOTHING today.
 *
 * deploy-fiab-il5.yml is recorded, not fixed, for one reason and it is checkable:
 * this batch does not own that file (batch L0-B owns gov-console-roll.yml,
 * gov-provision-runner-images.yml, loom-dataplane-roll.yml and
 * deploy-notify-failure.mjs). The routing request is #3844. If the entry is
 * still here when that file has moved onto the deploy-notify-failure chokepoint,
 * the shrink assertion below goes red and forces its removal — the entry cannot
 * outlive its reason.
 */
export const VARIABLE_GATED_NOTIFIER_BASELINE = ['deploy-fiab-il5.yml'];

export function usesVariableGatedNotifier(src) {
  const code = stripComments(src);
  return /vars\.FIAB_GOV_DEPLOY_TRACKING_ISSUE/.test(code) && /core\.warning\(/.test(code);
}

test('#3844 RATCHET — no NEW lane may gate its only failure notice on a repo variable', () => {
  const found = workflowNames().filter((f) => usesVariableGatedNotifier(readWorkflow(f)));
  assert.ok(found.length >= 1, `expected >=1 variable-gated notifier (the known deploy-fiab-il5 one), found ${found.length} — the matcher drifted, it is not that the debt was paid`);
  const unexpected = found.filter((f) => !VARIABLE_GATED_NOTIFIER_BASELINE.includes(f));
  assert.deepEqual(unexpected, [], 'a lane notifies failure only when a repo variable happens to be set; when it is not, the step logs a warning and posts nothing. Use .github/scripts/deploy-notify-failure.mjs instead');
  const stale = VARIABLE_GATED_NOTIFIER_BASELINE.filter((f) => !found.includes(f));
  assert.deepEqual(stale, [], 'a baseline entry no longer matches — delete it rather than leaving a reason that is no longer true');
});

// ─────────────────────────────────────────────────────────────────────────────
// #3416 — an `az acr build --no-logs` failure must fetch the ACR task log
// ─────────────────────────────────────────────────────────────────────────────

const RUNNER_IMAGES = 'gov-provision-runner-images.yml';

/** A lane that builds server-side with logs suppressed. */
export function buildsWithSuppressedLogs(src) {
  const code = stripComments(src);
  return /\baz acr build\b/.test(code) && /--no-logs\b/.test(code);
}

/**
 * An INVOCATION of `az acr task logs`, not a mention of one.
 *
 * The first cut of this was `/\baz acr task logs\b/`, and a mutation walked
 * straight through it: replacing the actual fetch with `echo "skipping"` left
 * the guard GREEN, because the step's own remediation messages say
 * "read it manually with: az acr task logs -r $ACR --run-id <id>". The guard was
 * matching the ADVICE, not the command — the same shape as a gate keyed to the
 * string it is supposed to forbid.
 *
 * So the command must START a line (allowing the usual shell and YAML wrappers:
 * a one-line `run:`, an `if !` test, a `VAR=$(` capture, a `!` negation). A
 * `az acr task logs` sitting inside `echo "..."` never does.
 */
const ACR_TASK_LOGS_INVOCATION =
  /^[ \t]*(?:-[ \t]+)?(?:run:[ \t]*\|?[ \t]*)?(?:(?:if|elif|while)[ \t]+)?(?:![ \t]*)?(?:[A-Za-z_][A-Za-z0-9_]*=)?\$?\(?[ \t]*az[ \t]+acr[ \t]+task[ \t]+logs\b/m;

/** A lane that reads the suppressed log back off the registry. */
export function fetchesAcrTaskLog(src) {
  return ACR_TASK_LOGS_INVOCATION.test(stripComments(src));
}

/**
 * The eight lanes that suppress build logs and do NOT fetch them back, measured
 * 2026-08-23 across all 90+ workflows. Every one of them will produce the same
 * unclassifiable failure gov-provision-runner-images produced in run
 * 32595754052; none is owned by this batch. Shrink-only: a lane that gains
 * coverage must be removed from this list, and a NEW suppressed-log lane that
 * never appears here fails immediately.
 */
export const NO_LOG_FETCH_BASELINE = [
  'gov-build-images.yml',
  'gov-provision-dataplane-images.yml',
  'gov-provision-dbt.yml',
  'gov-provision-dbx-sql-invnet.yml',
  'gov-provision-streaming-migrate.yml',
  'gov-provision-trino.yml',
  'gov-provision-wrangler.yml',
  'gov-uc-purview-wire.yml',
];

test('#3416 — the runner-images lane fetches the ACR task log on failure, before the lease is released', () => {
  const src = readWorkflow(RUNNER_IMAGES);
  assert.ok(buildsWithSuppressedLogs(src), 'gov-provision-runner-images no longer builds with --no-logs — this guard is guarding the wrong lane');

  const steps = namedSteps(src);
  // `fetchesAcrTaskLog`, not a bare substring: the step's own remediation
  // messages quote the command, so a substring match finds the ADVICE even after
  // the actual fetch has been deleted. Measured — that mutation stayed green.
  const diag = steps.find((s) => fetchesAcrTaskLog(s.text));
  assert.ok(diag, 'no step INVOKES `az acr task logs`, so an ACR-side build failure is still unclassifiable from the run alone (#3416)');
  assert.match(diag.text, /^\s+if:\s*failure\(\)\s*$/m, 'the diagnostic must be gated on failure()');

  const release = steps.find((s) => s.name.startsWith('Release the ACR firewall lease'));
  assert.ok(release, 'the lease-release step vanished — the ordering assertion below would be vacuous');
  assert.ok(diag.index < release.index, `the log fetch (step ${diag.index}) must run BEFORE the lease release (step ${release.index}) or it fetches through a re-locked firewall`);

  // A measurement wrapped in a swallow is a decoration. Assert on the step's own
  // body rather than the whole file, so an unrelated `|| true` elsewhere neither
  // fails this nor hides a regression here.
  for (const swallow of ['2>/dev/null', '|| true', 'continue-on-error']) {
    assert.equal(diag.text.includes(swallow), false, `the diagnostic step contains ${swallow}, which turns the fetch into a decoration`);
  }
  // And it must not publish an Azure log to a public run log unredacted.
  assert.match(diag.text, /_azure-redact\.mjs/, 'the fetched ACR log must pass through scripts/ci/_azure-redact.mjs before it is printed — this repository is public');
});

test('#3416 RATCHET — no NEW suppressed-log build lane may ship without a log fetch', () => {
  const all = workflowNames().map((f) => ({ f, src: readWorkflow(f) }));
  const population = all.filter((x) => buildsWithSuppressedLogs(x.src)).map((x) => x.f);
  // FLOOR, not equality: a new COVERED lane must not fail this, but a matcher
  // that has drifted to zero must.
  assert.ok(population.length >= 9, `expected >=9 workflows building with --no-logs, found ${population.length} — the matcher drifted`);

  const uncovered = population.filter((f) => !fetchesAcrTaskLog(readWorkflow(f)));
  const unexpected = uncovered.filter((f) => !NO_LOG_FETCH_BASELINE.includes(f));
  assert.deepEqual(unexpected, [], 'a lane runs `az acr build --no-logs` with no `az acr task logs` fetch on failure, so an ACR-side failure arrives as an unclassifiable pointer (#3416)');

  const stale = NO_LOG_FETCH_BASELINE.filter((f) => !uncovered.includes(f));
  assert.deepEqual(stale, [], 'a baseline entry is now covered (or gone) — remove it, so the list keeps shrinking');

  assert.equal(NO_LOG_FETCH_BASELINE.includes(RUNNER_IMAGES), false, 'gov-provision-runner-images must never be excused by the baseline; it is the lane this fix covers');
});

test('#3416 SELF-DEFENCE — the matcher ignores comment-only mentions (live in-tree controls)', () => {
  // These three files mention `--no-logs` and are NOT part of the population.
  // gov-console-roll's mentions are the sentence "the `--no-logs` opt-out is
  // gone" — a naive src.includes() would flag the file that FIXED this defect.
  const controls = ['console-bluegreen-roll.yml', 'gov-console-roll.yml', 'loom-guardrails.yml'];
  for (const f of controls) {
    const src = readWorkflow(f);
    assert.ok(/--no-logs\b/.test(src), `${f} no longer mentions --no-logs at all; pick a different negative control rather than deleting this assertion`);
    assert.equal(buildsWithSuppressedLogs(src), false, `${f} is a comment-only mention and must NOT enter the population — the comment stripper regressed`);
  }

  // And the predicate must still say YES to the real shape.
  const real = [
    'jobs:',
    '  b:',
    '    steps:',
    '      - name: Build',
    '        run: |',
    '          az acr build --registry "$ACR" --no-logs --image x:1 .',
  ].join('\n');
  assert.equal(buildsWithSuppressedLogs(real), true, 'the predicate must catch a genuine suppressed-log build');
  assert.equal(fetchesAcrTaskLog(real), false, 'and must report it uncovered');
  assert.equal(fetchesAcrTaskLog(`${real}\n      - name: Diag\n        run: az acr task logs -r "$ACR" --run-id "$ID"\n`), true, 'and covered once the fetch is added');

  // REGRESSION PIN — the mention-vs-invocation hole a mutation found. Replacing
  // the real fetch with `echo "skipping"` left the step's remediation text
  // quoting the command, and a substring matcher called that COVERED.
  const adviceOnly = [
    '      - name: Diag',
    '        if: failure()',
    '        run: |',
    '          echo "skipping" > "$LOG"',
    '          echo "::error::could not diagnose. Read it manually with: az acr task logs -r $ACR --run-id $ID"',
  ].join('\n');
  assert.equal(fetchesAcrTaskLog(adviceOnly), false, 'a step that only QUOTES `az acr task logs` inside a message must NOT count as fetching it');
  assert.equal(fetchesAcrTaskLog('          # az acr task logs -r "$ACR" --run-id "$ID"'), false, 'and neither must a commented-out invocation');
  // The wrapper shapes that ARE invocations.
  assert.equal(fetchesAcrTaskLog('          if ! az acr task logs -r "$ACR" --run-id "$ID"; then'), true, 'an `if !` guarded invocation counts');
  assert.equal(fetchesAcrTaskLog('          OUT=$(az acr task logs -r "$ACR" --run-id "$ID")'), true, 'a command-substitution capture counts');
});

// ─────────────────────────────────────────────────────────────────────────────
// #3346 — a roll lane nothing can trigger is not a roll lane
// ─────────────────────────────────────────────────────────────────────────────

const DATAPLANE_ROLL = 'loom-dataplane-roll.yml';

/** Triggers that a machine can fire. `workflow_dispatch` is not one. */
export const AUTOMATIC_TRIGGERS = ['push', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch'];

export function hasAutomaticTrigger(src) {
  return triggerKeys(src).some((k) => AUTOMATIC_TRIGGERS.includes(k));
}

/** `if:` conditions that read a dispatch input directly — empty on every other event. */
export function ifConditionsReadingRawInputs(src) {
  return stripComments(src)
    .split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /^\s*if:\s.*\binputs\./.test(l))
    .map(({ l, n }) => `${n}: ${l.trim()}`);
}

test('#3346 — loom-dataplane-roll has an automatic trigger and no `if:` reads a raw input', () => {
  const src = readWorkflow(DATAPLANE_ROLL);

  const keys = triggerKeys(src);
  assert.ok(keys.length > 0, 'the trigger block could not be parsed at all — the matcher drifted');
  assert.ok(hasAutomaticTrigger(src), `loom-dataplane-roll's only triggers are ${JSON.stringify(keys)}; a rebuilt loom-unity / iceberg-catalog / loom-trino tag can therefore only ever land by hand (#3346)`);
  assert.ok(keys.includes('workflow_run'), 'the automatic trigger must be the workflow_run chain off the image producer');
  assert.match(src, /workflows: \['build-fiab-images-acr-tasks'\]/, 'the producer must be build-fiab-images-acr-tasks — full-app-deploy-commercial is itself dispatch-only, so chaining to it would inherit the defect');

  // THE HALF THAT IS EASY TO FORGET. `inputs.*` is '' on a workflow_run, so
  // `if: inputs.boundary != 'commercial'` is TRUE and an automatic COMMERCIAL
  // roll would authenticate against the sovereign boundary.
  assert.deepEqual(ifConditionsReadingRawInputs(src), [], 'an `if:` reads `inputs.*` directly; on the automatic path that value is the empty string and the branch taken is the WRONG one');

  // The resolve step is what makes the above safe rather than merely absent.
  const steps = namedSteps(src);
  const resolve = steps.find((s) => /^\s+id:\s*resolve\s*$/m.test(s.text));
  assert.ok(resolve, 'no step carries `id: resolve`; the `if:` conditions have nothing to read');
  assert.match(resolve.text, /EVENT_NAME:\s*\$\{\{\s*github\.event_name\s*\}\}/, 'the resolve step must know which event it is on');
  assert.match(resolve.text, /PRODUCER_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/, 'the resolve step must take its tag from the producer run it is chained to');

  // The producer's conclusion must be asserted POSITIVELY. `!= 'success'` is
  // true for cancelled and skipped, which is the #3368 shape.
  const jobGate = /^\s{4}if: >-\n((?:\s{6}.*\n)+)/m.exec(`${stripComments(src)}\n`);
  assert.ok(jobGate, 'the job-level gate is missing; a `completed` producer run includes failure and cancelled');
  assert.match(jobGate[1], /conclusion == 'success'/, 'the job gate must require the producer run to have SUCCEEDED');
  assert.equal(/conclusion != 'success'/.test(jobGate[1]), false, "the job gate must not be written as `!= 'success'` — that is true for cancelled and skipped (#3368)");

  // And the serialization key must not collapse on the automatic path.
  assert.match(src, /group: loom-dataplane-roll-\$\{\{ inputs\.boundary \|\| 'commercial' \}\}/, 'the concurrency group must carry a fallback, or automatic runs form a separate group from dispatched ones and stop serializing against them');
});

test('#3346 SELF-DEFENCE — the predicates fire on the verbatim before-shapes', () => {
  // The trigger block exactly as it stood: dispatch and nothing else.
  const beforeTriggers = ['on:', '  workflow_dispatch:', '    inputs:', '      tag:', '        required: true', '', 'permissions:', '  contents: read'].join('\n');
  assert.deepEqual(triggerKeys(beforeTriggers), ['workflow_dispatch'], 'the trigger parser must see exactly the one dispatch key');
  assert.equal(hasAutomaticTrigger(beforeTriggers), false, 'the before-shape must be reported as having NO automatic trigger');
  const afterTriggers = beforeTriggers.replace('\npermissions:', "\n  workflow_run:\n    workflows: ['x']\n\npermissions:");
  assert.equal(hasAutomaticTrigger(afterTriggers), true, 'and the fixed shape must be reported as having one');

  // The four `if:` lines that were live at the merge-base.
  const beforeIfs = [
    '      - name: Azure login (Commercial)',
    "        if: inputs.boundary == 'commercial'",
    '      - name: Azure login (Gov)',
    "        if: inputs.boundary != 'commercial'",
    '      - name: Set Azure cloud to Gov',
    "        if: inputs.boundary != 'commercial'",
    "        if: inputs.pin_deploy_tag && steps.preflight.outputs.digests_complete == 'true'",
  ].join('\n');
  assert.equal(ifConditionsReadingRawInputs(beforeIfs).length, 4, 'the raw-input matcher must catch all four before-shape conditions');

  const afterIfs = beforeIfs
    .replaceAll("if: inputs.boundary", 'if: steps.resolve.outputs.boundary')
    .replace('if: inputs.pin_deploy_tag &&', "if: steps.resolve.outputs.pin == 'true' &&");
  assert.deepEqual(ifConditionsReadingRawInputs(afterIfs), [], 'and must catch none of the fixed ones');

  // LIVE in-tree control: loom-dataplane-roll still QUOTES the old line inside a
  // comment explaining the trap. A matcher that did not strip comments would
  // report that as a live violation of the very rule it documents.
  const src = readWorkflow(DATAPLANE_ROLL);
  assert.ok(
    src.split('\n').some((l) => /^\s*#.*if: inputs\.boundary/.test(l)),
    'the explanatory comment quoting the old `if: inputs.boundary` line is gone; this control no longer proves the stripper works — restore it or replace the control',
  );
  assert.deepEqual(ifConditionsReadingRawInputs(src), [], 'the comment stripper regressed: a commented-out `if: inputs.` is being counted as live code');
});
