/**
 * Teeth for loom-roll-and-validate's "which SHA did this run actually roll?"
 * guarantees (#2963, refs #2775).
 *
 * WHAT WENT WRONG. The roll is `workflow_run`-triggered on the image build.
 * GitHub stamps such a run's `head_sha` with the DEFAULT-BRANCH HEAD at trigger
 * time, not with `workflow_run.head_sha` (the SHA it rolls). With no
 * `run-name`, every automatic roll advertised a commit it never touched — live
 * on 2026-08-04, run 30961850347 was stamped 75e7bf48 and rolled 57c01e95;
 * run 30963436640 was stamped 8935fa43 and rolled 75e7bf48. Both deploys were
 * correct; both READ as deploying the wrong image, and the resulting bug report
 * was then auto-closed by the workflow's own green run.
 *
 * WHAT THIS FILE IS AND IS NOT. These are regression teeth on the *contract*:
 * the guards exist, are ordered before the mutation, are not skippable, and
 * keep "absent" apart from "could not ask". They are deliberately NOT the
 * proof that the gate refuses — a test that re-implements its own subject can
 * never disagree with it (csa_loom_gates_that_cannot_fail). The behavioural
 * proof is a LIVE dispatch of the workflow at a SHA with no image in ACR,
 * recorded in the PR. What lives here is the part a live dispatch cannot
 * cheaply re-check on every commit.
 *
 * The one genuinely behavioural pair below (T2/T3) drives the REAL
 * scripts/ci/assert-acr-image-tags.sh with a stubbed `az` and pins the exact
 * marker string the roll step greps. That coupling is invisible to both files
 * on their own: reword the helper's "could not READ registry" error and the
 * roll silently reclassifies every unreachable registry as a confirmed
 * absence, turning a locked ACR into a false RED on every roll — the shape
 * that gets a guard switched off. Fixtures here emit nothing themselves; the
 * strings come from the real producer (csa_loom_fixtures_that_model_the_code).
 *
 * Each assertion is chosen to die under an obvious mutation:
 *   - delete `run-name:`                        → T1 red
 *   - point run-name at github.sha instead      → T1 red
 *   - reword the helper's unreachable error     → T3 red
 *   - drop the roll's unreachable branch        → T3/T4 red
 *   - add `if: … skip_verify != 'true'` to the
 *     image-exists gate (make it skippable)     → T5 red
 *   - move the gate after "Roll Container App"  → T6 red
 *   - restore the health loop with no verdict   → T7 red
 *   - drop the revision-image equality check    → T8 red
 *   - drop `health` from the rollback condition → T9 red
 *   - restore the unconditional auto-close      → T10 red
 *   - drop the EXPECTED-from-TAG derivation     → T11 red
 *
 * Run: node --test scripts/ci/__tests__/roll-image-attribution.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'loom-roll-and-validate.yml');
// Normalised: the repo is checked out with CRLF on Windows, and these
// assertions are about workflow SEMANTICS, not line endings.
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
const HELPER = path.join(REPO_ROOT, 'scripts', 'ci', 'assert-acr-image-tags.sh');

/** The exact substring the roll step branches on to mean "unreachable". */
const UNREACHABLE_MARKER = 'could not READ registry';

/**
 * Body of the named step, from its `- name:` line to the next step at the same
 * indentation. Text-scoped on purpose: these are assertions about one step, and
 * a whole-file `includes()` would pass on a match anywhere in a 900-line file.
 */
function stepBody(name) {
  const start = WORKFLOW.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" not found in ${WORKFLOW_PATH}`);
  const next = WORKFLOW.indexOf('\n      - name: ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? WORKFLOW.length : next);
}

/** Index of a step's `- name:` line, for ordering assertions. */
function stepIndex(name) {
  const i = WORKFLOW.indexOf(`      - name: ${name}`);
  assert.notEqual(i, -1, `step "${name}" not found`);
  return i;
}

const STEP_IMAGE_EXISTS = 'Gate — the image must EXIST in ACR (unskippable)';
const STEP_ROLL = 'Roll Container App to new image';
const STEP_HEALTH = 'Wait for revision health';

// ── T1 — the run must advertise the SHA it rolls ────────────────────────────
test('run-name names the rolled SHA, not the stamped head_sha', () => {
  const m = WORKFLOW.match(/^run-name:[\s\S]*?\n\n/m);
  assert.ok(m, 'workflow has no `run-name:` — `gh run list` would show only the misleading head_sha (#2963)');
  const runName = m[0];

  // The rolled SHA on the automatic path IS workflow_run.head_sha. Naming the
  // run after `github.sha` is precisely the bug.
  assert.match(
    runName,
    /github\.event\.workflow_run\.head_sha/,
    'run-name must interpolate github.event.workflow_run.head_sha (the SHA being rolled)',
  );
  assert.match(runName, /inputs\.image_tag/, 'run-name must cover the manual-dispatch path too');
  assert.doesNotMatch(
    runName.replace(/github\.event\.workflow_run\.head_sha/g, ''),
    /github\.sha/,
    'run-name must not fall back to github.sha — that is the default-branch HEAD, not the rolled commit',
  );
});

// ── T2/T3 — the real helper's verdicts, and the roll's reading of them ──────
const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/** Run the REAL preflight helper against a stubbed `az`. */
function runHelper({ mode, presentRef, refs }) {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'roll-acr-stub-'));
  try {
    // Stub shape lifted from the helper's own vetted self-test
    // (scripts/ci/test-assert-acr-image-tags.sh) so the two agree on what `az`
    // looks like. Only `az` is faked; every string this test asserts on is
    // produced by the real helper.
    writeFileSync(
      path.join(stubDir, 'az'),
      [
        '#!/usr/bin/env bash',
        'case "$1 $2" in',
        '  "acr show") exit 0 ;;',
        '  "acr login") exit 0 ;;',
        '  "acr repository")',
        '     if [ "$3" = "show" ]; then',
        '       if [ "${MODE}" = "unreachable" ]; then',
        '         echo "denied: client with IP is not allowed access" >&2; exit 1',
        '       fi',
        '       REF=""; i=1',
        '       for a in "$@"; do',
        '         if [ "$a" = "--image" ]; then j=$((i+1)); eval "REF=\\${$j}"; fi',
        '         i=$((i+1))',
        '       done',
        '       if [ "$REF" = "${PRESENT_REF:-}" ]; then echo \'{"digest": "sha256:deadbeef"}\'; exit 0; fi',
        '       echo "ManifestUnknown: manifest tagged not found" >&2; exit 1',
        '     fi',
        '     if [ "$3" = "list" ]; then',
        '       if [ "${MODE}" = "unreachable" ]; then exit 1; fi',
        '       exit 0',
        '     fi',
        '     exit 0 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path.join(stubDir, 'az'), 0o755);
    const res = spawnSync('bash', [HELPER, '--acr', 'stubacr', ...refs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MODE: mode,
        PRESENT_REF: presentRef ?? '',
        PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

test('the real preflight refuses an absent tag, and does NOT call it unreachable', { skip: !bashOk && 'bash unavailable' }, () => {
  const { status, out } = runHelper({
    mode: 'ok',
    presentRef: 'loom-console:1111111111111111111111111111111111111111',
    refs: ['loom-console:0000000000000000000000000000000000000000'],
  });
  assert.equal(status, 1, 'a tag the registry says is not there must be a refusal');
  assert.match(out, /MISSING in/, 'refusal must state the tag is missing');
  assert.doesNotMatch(
    out,
    new RegExp(UNREACHABLE_MARKER),
    'a confirmed absence must not be reported as "could not read" — the roll would then downgrade it to a warning and ship',
  );
});

test('the real preflight reports an unreadable registry with the marker the roll greps', { skip: !bashOk && 'bash unavailable' }, () => {
  const { status, out } = runHelper({
    mode: 'unreachable',
    refs: ['loom-console:0000000000000000000000000000000000000000'],
  });
  assert.equal(status, 1, 'unreadable is a non-zero exit from the helper (the roll re-classifies it)');
  assert.ok(
    out.includes(UNREACHABLE_MARKER),
    `the helper's unreachable error must contain "${UNREACHABLE_MARKER}" — loom-roll-and-validate.yml greps for exactly that string to tell "could not ask" from "the answer is no". Reword one side and every locked-registry roll becomes a false RED.`,
  );
  assert.doesNotMatch(out, /MISSING in/, 'unreachable must not be reported as a confirmed absence');
});

// ── T4 — the roll keeps the three states apart ──────────────────────────────
test('the image-exists gate distinguishes absent (refuse) from unreachable (warn)', () => {
  const body = stepBody(STEP_IMAGE_EXISTS);
  assert.ok(
    body.includes(`grep -q '${UNREACHABLE_MARKER}'`),
    `the gate must branch on the helper's "${UNREACHABLE_MARKER}" marker; without it every unreadable registry is treated as a confirmed absence`,
  );
  assert.match(body, /REFUSING TO ROLL/, 'the absent branch must refuse loudly');
  assert.match(body, /exit 1/, 'the absent branch must exit non-zero');
  assert.match(body, /::warning::/, 'the unreachable branch must warn rather than assert absence');
});

// ── T5 — unskippable ────────────────────────────────────────────────────────
test('the image-exists gate has no `if:` — the emergency valves cannot switch it off', () => {
  const body = stepBody(STEP_IMAGE_EXISTS);
  const ifLine = body.match(/^\s{8}if:/m);
  assert.equal(
    ifLine,
    null,
    'the image-exists gate must not carry an `if:`. Its whole reason for existing is that the ONLY previous existence check was a side-effect of the skippable cosign gate (skip_signature_verify / LOOM_ROLL_SKIP_VERIFY).',
  );
  assert.doesNotMatch(body, /skip_verify/, 'the gate must not consult the signature-verification valve');
});

// ── T6 — ordered before anything mutates the estate ─────────────────────────
test('the image-exists gate runs before the Container App is touched', () => {
  assert.ok(
    stepIndex(STEP_IMAGE_EXISTS) < stepIndex(STEP_ROLL),
    'the existence gate must precede "Roll Container App to new image" — refusing after the mutation is not refusing',
  );
});

// ── T7/T8 — the health wait has a verdict, and checks the image ─────────────
test('the health wait fails on an unhealthy revision', () => {
  const body = stepBody(STEP_HEALTH);
  assert.match(
    body,
    /never reached Healthy\+Running/,
    'the health loop must fail when the revision never becomes healthy. It used to run ten probes, break on success, and simply END — an image that can never pull walked through a step named "Wait for revision health" and reported success.',
  );
  assert.match(body, /exit 1/, 'the unhealthy verdict must be non-zero');
});

test('the health wait asserts the revision runs the image this run resolved', () => {
  const body = stepBody(STEP_HEALTH);
  assert.match(
    body,
    /properties\.template\.containers\[0\]\.image/,
    'the health step must read back the revision image',
  );
  assert.match(
    body,
    /\$GOT.*!=.*\$WANT|"\$GOT" != "\$WANT"/,
    'the read-back image must be COMPARED to the requested one — reading it and not comparing is a check whose result is discarded',
  );
});

// ── T9 — a failing health gate must still roll back ─────────────────────────
test('rollback triggers on a health failure, not only validate/uat', () => {
  const body = stepBody('Rollback on validation failure');
  assert.match(
    body,
    /steps\.health\.outcome == 'failure'/,
    'now that the health gate can fail, it must also trigger the revert — otherwise making the gate honest parks the estate on a broken revision with no rollback',
  );
});

// ── T10 — the auto-close must not eat human-filed reports ───────────────────
test('auto-close only closes issues this workflow itself filed', () => {
  const body = stepBody('Auto-close stale deploy-validation issues on success');
  assert.match(
    body,
    /github-actions\[bot\]/,
    'auto-close must require a bot author. #2963 was human-filed, wore the deploy-validation label, and was closed by an unrelated green roll — the workflow dismissing a report about its own reporting.',
  );
  assert.match(body, /SELF_TITLE/, 'auto-close must also match this workflow\'s own issue title shape');
  assert.match(body, /continue;/, 'non-matching issues must be left open');
});

// ── T11 — success requires having proven WHICH image is serving ─────────────
test('a rolled commit SHA always yields an expected SHA to validate against', () => {
  const body = stepBody('Resolve inputs');
  // Pinned to the GUARDED derivation, not to the bare assignment: the
  // workflow_run branch has always carried its own `EXPECTED="${TAG:0:8}"`, so
  // a looser pattern matched that line and passed even with this fix deleted.
  // (Caught by the mutation battery — the first draft of this assertion was
  // itself a check that could not fail.)
  assert.match(
    body,
    /if \[\[ -z "\$EXPECTED" && "\$TAG" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then\s*\n\s*EXPECTED="\$\{TAG:0:8\}"/,
    'EXPECTED must be derived from a 40-hex TAG on the dispatch path too. With expected_sha blank (its default) loom-validate-live.sh skips BOTH SHA assertions and PASSES — the roll reports success having proven nothing about which image is live.',
  );
  assert.match(
    body,
    /Refusing to roll .* with no expected SHA/,
    'a tag that yields no expectation at all must refuse rather than validate nothing',
  );
});
