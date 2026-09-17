/**
 * Self-tests for check-bicepparam-compiled.mjs (#4466).
 *
 * WHAT VALUE WOULD MAKE EACH OF THESE FAIL — stated per test, per
 * `.claude/rules/assertion-design.md`. Every control below is chosen to DIE
 * under a specific, named mutation of the guard, and the two that have no kill
 * power are labelled as such rather than counted.
 *
 * The anchor control is not synthetic: it is the REAL `validate.yml` blob at
 * `origin/main` — the tree #4466 was filed against — read out of git rather
 * than by editing the working tree. The guard must be RED on it and GREEN on
 * the tree this PR ships. If those two ever agree, the guard is measuring
 * nothing and this file says so.
 *
 * Run: node --test scripts/ci/__tests__/bicepparam-compiled.test.mjs
 * (Auto-discovered by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  analyze,
  exclusionRegExp,
  globToRegExp,
  jobsOf,
  pushTriggerPaths,
  stripComments,
  trackedBicepParams,
  NEGATIVE_CONTROL_SENTINEL,
  REPO_ROOT,
  WORKFLOW,
} from '../check-bicepparam-compiled.mjs';

const LIVE = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');
/**
 * The same text, LF-normalised, used ONLY as the substrate for the mutation
 * controls below.
 *
 * `validate.yml` is CRLF in a Windows checkout and LF in CI, so a mutation
 * anchor written with `\n` matches on one platform and not the other. That is
 * the "a LINE guard no-ops on CRLF" trap, and it bit this file: the R3 and R6
 * controls were initially green-by-not-running on Linux and hard-failed on
 * Windows. `mutateLive` asserts its anchor was found precisely so that a
 * silently-unapplied mutation can never masquerade as a passing control.
 *
 * `analyze` strips `\r` itself, so LF substrate and CRLF substrate are
 * equivalent inputs to it; the POSITIVE control above deliberately feeds it the
 * RAW file so the real line endings are exercised at least once.
 */
const LIVE_LF = LIVE.replace(/\r/g, '');
const PARAMS = trackedBicepParams();

/** Violation codes present in a verdict, e.g. ['R2', 'R6']. */
const codesOf = (violations) => violations.map((v) => v.slice(0, 2));

// ---------------------------------------------------------------------------
// POSITIVE CONTROL. Without this, every negative control below is satisfied by
// a guard that flags everything unconditionally (assertion-design.md §4).
// ---------------------------------------------------------------------------

test('POSITIVE: the shipped validate.yml passes every rule', () => {
  const { violations, job } = analyze(LIVE, PARAMS);
  // FAILS IF: the `bicep-params` job is deleted, gated, narrowed, given an
  // exclusion, or loses its negative control — i.e. any regression of this PR.
  assert.deepEqual(violations, [], `expected a clean verdict, got:\n${violations.join('\n')}`);
  assert.equal(job, 'bicep-params');
});

test('POSITIVE: the tracked .bicepparam population is non-empty and includes il5', () => {
  // FAILS IF: `git ls-files -- '*.bicepparam'` stops matching, which is the
  // corpus-drift case R1 exists for. Pinned to il5 specifically because it is
  // the file #4466 names as compiled by no gate and executed by no deploy.
  assert.ok(PARAMS.length > 0, 'no tracked .bicepparam files found at all');
  assert.ok(
    PARAMS.includes('platform/fiab/bicep/params/il5.bicepparam'),
    `il5.bicepparam missing from the population: ${PARAMS.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// THE ANCHOR: the real pre-fix tree.
// ---------------------------------------------------------------------------

test('ANCHOR: the guard is RED on the real pre-fix validate.yml at origin/main', (t) => {
  let preFix;
  try {
    preFix = execFileSync('git', ['show', 'origin/main:.github/workflows/validate.yml'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // A shallow clone or a missing remote ref is not a verdict about the guard.
    // SKIP, never silently pass — a swallowed failure here would be exactly the
    // "green over nothing" shape #4466 is about.
    t.skip('origin/main:.github/workflows/validate.yml is not fetchable in this checkout');
    return;
  }
  const { violations } = analyze(preFix, PARAMS);
  // FAILS IF: R2 is deleted, or `analyze` stops requiring an executable
  // build-params invocation. Measured on 0348d3715e6: exactly one violation,
  // R2, because that tree's validate.yml contains the string `build-params`
  // nowhere at all.
  assert.deepEqual(codesOf(violations), ['R2'], `pre-fix verdict was: ${violations.join(' | ')}`);
  assert.match(violations[0], /nothing compiles any \.bicepparam/);
});

// ---------------------------------------------------------------------------
// R2 — a COMMENT must not satisfy the rule (#4467 class).
// ---------------------------------------------------------------------------

/** The #4466 shape verbatim: build-params present, but only ever in comments. */
const COMMENTED_ONLY = [
  'name: t',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths:',
  "      - '**/*.bicepparam'",
  '  pull_request:',
  'jobs:',
  '  bicep-lint:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      # Proven with `az bicep build-params` on an unset env:',
  '      - name: Build every Bicep file',
  '        run: |',
  '          # bicep build-params type-checks the file in isolation',
  "          git ls-files '*.bicep' > /tmp/f.txt",
  '',
].join('\n');

test('R2: build-params mentioned ONLY in comments does not count as a compile', () => {
  const { violations } = analyze(COMMENTED_ONLY, PARAMS);
  // FAILS IF: `analyze` stops routing through stripComments (delete the
  // `stripComments(workflowText)` call and this control goes GREEN, because the
  // two `#` lines above contain the literal string `build-params`). That is the
  // exact defect this repo recorded in #4467 — a guard matching raw source is
  // satisfied by a comment — reproduced here with the real comment text from
  // deploy-fiab-commercial.yml:1114 and loom-guardrails.yml:581.
  assert.ok(codesOf(violations).includes('R2'), `expected R2, got: ${violations.join(' | ')}`);
});

test('stripComments leaves a `#` inside quotes alone', () => {
  // FAILS IF: stripComments is simplified to `line.split('#')[0]` — then the
  // returned string is `echo "a` and this assertion reds.
  assert.equal(stripComments('        run: echo "a#b"'), '        run: echo "a#b"');
  assert.equal(stripComments("        run: echo 'a#b' # gone"), "        run: echo 'a#b' ");
});

test('stripComments normalises CRLF away', () => {
  // `validate.yml` is CRLF in a Windows checkout and LF in CI.
  // FAILS IF: the `.replace(/\r/g, '')` is dropped — the output then still
  // carries the carriage returns.
  //
  // DISCLOSED, NOT COUNTED: a whole-workflow CRLF-vs-LF verdict comparison has
  // NO kill power against that same mutation today, because every regex in the
  // guard uses `\s` or `[^\n]`, both of which already tolerate `\r`. This
  // assertion pins the normalisation itself so that a future line-anchored
  // pattern cannot silently no-op on a Windows checkout.
  assert.ok(!stripComments('a: 1\r\nb: 2\r\n').includes('\r'));
});

// ---------------------------------------------------------------------------
// R3 / R4 / R5 / R6 / R7 — one mutation of the SHIPPED workflow each.
// Each takes the live text and breaks exactly one property, so a control that
// reports a violation is reporting about that property and nothing else.
// ---------------------------------------------------------------------------

/** Replace the first occurrence of `find` in the live workflow, asserting it was there. */
function mutateLive(find, replace) {
  assert.ok(LIVE_LF.includes(find), `mutation anchor not found in ${WORKFLOW}: ${JSON.stringify(find)}`);
  return LIVE_LF.replace(find, replace);
}

test('R3: gating the compile job on the paths-filter job is a violation', () => {
  const mutated = mutateLive(
    '  bicep-params:\n    name: Bicep Params Compile\n',
    "  bicep-params:\n    name: Bicep Params Compile\n    needs: changes\n    if: needs.changes.outputs.bicep == 'true'\n",
  );
  const { violations } = analyze(mutated, PARAMS);
  // FAILS IF: the R3 arm is deleted. This is #4466 "done" #2 in its strongest
  // form — a job carrying `needs: changes` + `if:` reports `skipped` on a PR
  // that changes only a .bicepparam, and a skipped job reads as green.
  assert.ok(codesOf(violations).includes('R3'), `expected R3, got: ${violations.join(' | ')}`);
});

test('R4: a hand-maintained file list instead of git ls-files is a violation', () => {
  const mutated = mutateLive(
    "          git ls-files '*.bicepparam' > /tmp/bicepparam-files.txt",
    '          printf "platform/fiab/bicep/params/il5.bicepparam\\n" > /tmp/bicepparam-files.txt',
  );
  const { violations } = analyze(mutated, PARAMS);
  // FAILS IF: the R4 arm is deleted. A hand list is how the NEXT param file
  // added to the repo silently leaves the population — the same shape as
  // `git ls-files '*.bicep'` never having matched `*.bicepparam`.
  assert.ok(codesOf(violations).includes('R4'), `expected R4, got: ${violations.join(' | ')}`);
});

test('R5: excluding a tracked param file to get green is a violation, and it is NAMED', () => {
  const mutated = mutateLive(
    "          git ls-files '*.bicepparam' > /tmp/bicepparam-files.txt",
    "          git ls-files '*.bicepparam' | grep -vE 'params/il5' > /tmp/bicepparam-files.txt",
  );
  const { violations } = analyze(mutated, PARAMS);
  const r5 = violations.find((v) => v.startsWith('R5'));
  // FAILS IF: the R5 arm is deleted, or exclusionRegExp stops recognising the
  // `grep -vE '…'` shape (it would return null and the exclusion would be
  // invisible). Weakening a guard to make something green is forbidden outright
  // by this repo's operating rules, so the violation must name the file it
  // drops rather than merely counting it.
  assert.ok(r5, `expected R5, got: ${violations.join(' | ')}`);
  assert.match(r5, /platform\/fiab\/bicep\/params\/il5\.bicepparam/);
});

test('R5: an exclusion that drops NOTHING is allowed', () => {
  const mutated = mutateLive(
    "          git ls-files '*.bicepparam' > /tmp/bicepparam-files.txt",
    "          git ls-files '*.bicepparam' | grep -vE '^codeqlDB/' > /tmp/bicepparam-files.txt",
  );
  const { violations } = analyze(mutated, PARAMS);
  // FAILS IF: R5 is implemented as "any `grep -v` at all is a violation"
  // instead of "any `grep -v` that drops a TRACKED param file". The sibling
  // .bicep job legitimately excludes vendored trees, so the rule has to be
  // about the excluded SET, not about the presence of a filter.
  assert.ok(!codesOf(violations).includes('R5'), `unexpected R5: ${violations.join(' | ')}`);
});

test('R6: a typo in the push paths filter is caught, and a substring check would NOT catch it', () => {
  const mutated = mutateLive("      - '**/*.bicepparam'\n", "      - '**/*.bicepparams'\n");
  const { violations } = analyze(mutated, PARAMS);
  const r6 = violations.find((v) => v.startsWith('R6'));
  // FAILS IF: R6 is implemented as `text.includes('**/*.bicepparam')`. The
  // typo'd pattern `**/*.bicepparams` CONTAINS that substring, so a string
  // search passes while the filter matches nothing — which is why R6 glob-
  // MATCHES each declared pattern against each real tracked path instead.
  assert.ok(r6, `expected R6, got: ${violations.join(' | ')}`);
  assert.match(r6, /matches none of \d+ tracked param file\(s\)/);
});

test('R7: deleting the negative control is a violation', () => {
  const mutated = LIVE_LF.split(NEGATIVE_CONTROL_SENTINEL).join('someOtherParamName');
  assert.notEqual(mutated, LIVE_LF, 'the sentinel was not present to remove');
  const { violations } = analyze(mutated, PARAMS);
  // FAILS IF: the R7 arm is deleted. Disclosed at the guard's site and again
  // here: this arm is EXISTENCE-ONLY. It cannot distinguish a working negative
  // control from a broken one, and it is not counted as evidence that the
  // control has kill power — that evidence is produced by the job running the
  // control on every CI execution.
  assert.ok(codesOf(violations).includes('R7'), `expected R7, got: ${violations.join(' | ')}`);
});

test('R1: an empty param population is a hard failure, not a vacuous pass', () => {
  const { violations } = analyze(LIVE, []);
  // FAILS IF: R1 is deleted. With no population, R5 and R6 are both vacuously
  // satisfied (nothing to exclude, nothing to reach), so a guard without R1
  // would report the cleanest possible verdict at the precise moment it had
  // stopped watching anything.
  assert.deepEqual(codesOf(violations), ['R1'], `expected only R1, got: ${violations.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// The primitives, proven on known pairs rather than trusted.
// ---------------------------------------------------------------------------

test('globToRegExp: `**/` matches zero segments as well as many', () => {
  const re = globToRegExp('**/*.bicepparam');
  // FAILS IF: `**/` compiles to `.*/` (requiring at least one separator) — then
  // a repo-root param file is unreachable and R6 would pass a filter that does
  // not actually cover it.
  assert.ok(re.test('root.bicepparam'), 'repo-root file should match');
  assert.ok(re.test('platform/fiab/bicep/params/il5.bicepparam'), 'nested file should match');
  // FAILS IF: the extension were matched as a prefix — `.bicep` must NOT match
  // a `.bicepparam` pattern, and this is the asymmetry #4466 is built on.
  assert.ok(!re.test('platform/fiab/bicep/main.bicep'), '.bicep must not match a .bicepparam glob');
});

test("globToRegExp: the pre-existing '*.bicep' root pattern does not reach nested files", () => {
  const re = globToRegExp('*.bicep');
  // FAILS IF: `*` is compiled to `.*` instead of `[^/]*`. This pins the
  // MEASUREMENT behind the push-trigger widening in this PR: the old
  // `- '*.bicep'` entry reached the repo root only, which is why 198 files
  // under platform/fiab/bicep/ never triggered the workflow on a push to main.
  assert.ok(re.test('main.bicep'));
  assert.ok(!re.test('platform/fiab/bicep/main.bicep'));
});

test('pushTriggerPaths reads the push trigger and stops at pull_request', () => {
  const patterns = pushTriggerPaths(stripComments(LIVE));
  // FAILS IF: the reader walks past `pull_request:` into another trigger's
  // keys, or stops at the first blank line. `pull_request:` in this workflow
  // deliberately has NO `paths:`, so anything it contributed would be a bug.
  assert.ok(patterns.includes('**/*.bicepparam'), `patterns were: ${patterns.join(', ')}`);
  assert.ok(patterns.includes('.github/workflows/**'));
  assert.ok(!patterns.includes('main'), 'branches: entries must not leak into paths');
});

test('jobsOf finds the compile job and does not bleed into the next one', () => {
  const jobs = jobsOf(stripComments(LIVE));
  const body = jobs.get('bicep-params');
  // FAILS IF: jobsOf never flushes on the next `  <id>:` key — the body would
  // then swallow `secret-scan`, and R3's `if:`/`needs:` probes would read
  // another job's keys. (`bicep-lint` carries `needs: changes` + an `if:`, so a
  // bleeding reader would report a false R3 on a correct tree.)
  assert.ok(body, `bicep-params not found; jobs were: ${[...jobs.keys()].join(', ')}`);
  assert.ok(body.includes('build-params'));
  assert.ok(!body.includes('gitleaks'), 'job body bled into secret-scan');
  assert.ok(jobs.has('bicep-lint') && jobs.get('bicep-lint').includes('needs: changes'));
});

test('exclusionRegExp recognises the grep -vE shape and returns null otherwise', () => {
  // FAILS IF: the pattern is anchored to `-v ` with a space, or to `-vE` only —
  // the sibling .bicep step writes `grep -vE '…'` and both spellings appear in
  // this repo's shell.
  assert.ok(exclusionRegExp("git ls-files | grep -vE '^codeqlDB/' > f").test('codeqlDB/x.bicepparam'));
  assert.equal(exclusionRegExp("git ls-files '*.bicepparam' > f"), null);
});
