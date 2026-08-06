/**
 * deploy-failure-handling.test.mjs — the guard's own teeth.
 *
 * A guard that cannot detect the thing it exists for is worse than none: it
 * reads green and enforces nothing (csa_loom_gates_that_measure_nothing). Each
 * check below is exercised against a workflow fragment carrying the ACTUAL
 * defect it was written for — the verbatim shapes found in
 * full-app-deploy-commercial.yml, deploy-fiab-commercial.yml and
 * gov-build-images.yml before this PR — and against the fixed shape, so the
 * check is proven to distinguish them rather than merely to fire.
 *
 * Run: node --test scripts/ci/__tests__/deploy-failure-handling.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  findHardCodedNotifyTargets,
  findHandRolledRetries,
  findAbsenceClaimedFromDiscardedError,
  checkTaxonomyIntegrity,
  inScopeWorkflows,
  runBlocks,
  scan,
  REPO_ROOT,
  TAXONOMY_REL,
} from '../check-deploy-failure-handling.mjs';

// ── C1 ───────────────────────────────────────────────────────────────────────

const C1_BEFORE = `
      - name: Notify on failure
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: 279,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: \`deploy-fiab-commercial failed in run \${context.runId}. Check workflow logs.\`
            })
`;

const C1_AFTER = `
      - name: Notify on failure (dedicated, OPEN issue)
        if: failure()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          node .github/scripts/deploy-notify-failure.mjs --workflow deploy-fiab-commercial
`;

test('C1 detects the CLOSED-issue notify target that hid 47 days of failure', () => {
  const hits = findHardCodedNotifyTargets(C1_BEFORE, 'x.yml');
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /#279/);
  assert.equal(hits[0].check, 'C1');
});

test('C1 passes the fixed shape', () => {
  assert.deepEqual(findHardCodedNotifyTargets(C1_AFTER, 'x.yml'), []);
});

test('C1 ignores the number when it only appears in a comment', () => {
  assert.deepEqual(findHardCodedNotifyTargets('        # issue_number: 279 was the old target\n', 'x.yml'), []);
});

// ── C2 ───────────────────────────────────────────────────────────────────────

const C2_BEFORE = `
      - name: Build + push via ACR Tasks
        run: |
          for attempt in 1 2 3; do
            if az acr build --registry "$ACR" --image "$APP:$TAG" .; then exit 0; fi
            echo "::warning::attempt $attempt failed — retrying"
            sleep 30
          done
          echo "::error::$APP ACR build failed after 3 attempts"; exit 1
`;

const C2_AFTER = `
      - name: Build + push via ACR Tasks
        run: |
          node scripts/ci/deploy-retry.mjs --class-allow transient --max-attempts 3 \\
            -- az acr build --registry "$ACR" --image "$APP:$TAG" .
`;

test('C2 detects an unclassified retry loop around an az mutation', () => {
  const hits = findHandRolledRetries(C2_BEFORE, 'x.yml');
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /deploy-retry\.mjs/);
});

test('C2 passes once the harness is used', () => {
  assert.deepEqual(findHandRolledRetries(C2_AFTER, 'x.yml'), []);
});

test('C2 does not fire on a loop that mutates nothing (e.g. a readiness poll)', () => {
  const poll = `
      - name: Wait for ACR to open
        run: |
          for i in 1 2 3; do
            if az acr login --name "$ACR"; then break; fi
            sleep 10
          done
`;
  assert.deepEqual(findHandRolledRetries(poll, 'x.yml'), []);
});

// ── C3 ───────────────────────────────────────────────────────────────────────

const C3_BEFORE = `
      - name: Verify images
        run: |
          DIGEST=$(az acr repository show --name "$ACR" --image "$APP:$TAG" --query digest -o tsv 2>/dev/null | tr -d '\\r' || echo "")
          if [[ -z "$DIGEST" ]]; then
            echo "::warning::$APP:$TAG not found in $ACR. Skipping its verification."
            continue
          fi
`;

const C3_AFTER = `
      - name: Verify images
        run: |
          set +e
          SHOW_OUT=$(az acr repository show --name "$ACR" --image "$APP:$TAG" --query digest -o tsv 2>&1)
          SHOW_RC=$?
          set -e
          if [[ $SHOW_RC -ne 0 ]]; then
            if node scripts/ci/deploy-classify.mjs --text "$SHOW_OUT" --assert-signal config.image-tag-absent; then
              echo "::warning::$APP:$TAG — the registry ANSWERED and the tag is absent."
              continue
            fi
            echo "::error::could NOT read $ACR; existence is UNPROVEN."
            exit 1
          fi
`;

test('C3 detects the R7 shape: emptiness from a discarded error stated as absence', () => {
  const hits = findAbsenceClaimedFromDiscardedError(C3_BEFORE, 'x.yml');
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /DIGEST/);
  assert.match(hits[0].detail, /never established/);
});

test('C3 passes the three-state fix', () => {
  assert.deepEqual(findAbsenceClaimedFromDiscardedError(C3_AFTER, 'x.yml'), []);
});

test('C3 also catches the `|| echo ""` spelling of the same defect', () => {
  const variant = C3_BEFORE.replace("2>/dev/null | tr -d '\\r' || echo \"\"", '|| echo ""');
  assert.equal(findAbsenceClaimedFromDiscardedError(variant, 'x.yml').length, 1);
});

test('C3 does not fire when the discarded call and the claim are about different things', () => {
  const unrelated = `
      - name: Something
        run: |
          az extension add --name containerapp --only-show-errors 2>/dev/null
          if [[ ! -f platform/x.json ]]; then
            echo "::warning::platform/x.json not found — skipping."
          fi
`;
  assert.deepEqual(findAbsenceClaimedFromDiscardedError(unrelated, 'x.yml'), []);
});

test('C3 follows the taint through an intermediate variable (a rename must not defeat it)', () => {
  // The exact mutation that walked past the first draft of this check:
  // SHOW_OUT is blind, D is derived from SHOW_OUT, and the claim tests D.
  const indirect = `
      - name: Verify tag
        run: |
          SHOW_OUT=$(az acr repository show --name "$ACR" --image "$APP:$T" --query digest -o tsv 2>/dev/null || echo "")
          SHOW_RC=$?
          D=$(echo "$SHOW_OUT" | tr -d '\\r')
          if [ -z "$D" ]; then
            echo "::error::$APP:$T is NOT in $ACR after the build."
            exit 1
          fi
`;
  const hits = findAbsenceClaimedFromDiscardedError(indirect, 'x.yml');
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /\$D traces back/);
});

test('C3 has NO helper escape hatch — a classifier fed a discarded error proves nothing', () => {
  // Calling deploy-classify.mjs does not launder a `2>/dev/null` capture: the
  // error text it needed was thrown away before it ran, so it sees "" and
  // returns `unknown`, and the code falls through to the absence claim anyway.
  const laundered = C3_BEFORE.replace(
    'if [[ -z "$DIGEST" ]]; then',
    'node scripts/ci/deploy-classify.mjs --text "$DIGEST" --assert-signal config.image-tag-absent\n          if [[ -z "$DIGEST" ]]; then',
  );
  assert.equal(findAbsenceClaimedFromDiscardedError(laundered, 'x.yml').length, 1);
});

// ── C4 ───────────────────────────────────────────────────────────────────────

test('C4 passes against the real repository', () => {
  assert.deepEqual(checkTaxonomyIntegrity(REPO_ROOT), []);
});

test('C4 fails when the taxonomy is unreachable', () => {
  const hits = checkTaxonomyIntegrity(path.join(REPO_ROOT, 'scripts'));
  assert.ok(hits.length > 0);
  assert.equal(hits[0].file, TAXONOMY_REL);
});

// ── discovery + the whole-repo state ─────────────────────────────────────────

test('discovery matches real workflows (zero matches would measure nothing)', () => {
  const wfs = inScopeWorkflows();
  assert.ok(wfs.length >= 20, `only ${wfs.length} workflows in scope`);
  assert.ok(wfs.includes('full-app-deploy-commercial.yml'));
  assert.ok(wfs.includes('deploy-fiab-commercial.yml'));
  assert.ok(wfs.includes('loom-roll-and-validate.yml'));
});

test('runBlocks finds each `run: |` script and its start line', () => {
  const blocks = runBlocks('a:\n  b:\n    run: |\n      echo one\n      echo two\n  c: 1\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 3);
  assert.equal(blocks[0].body.length, 2);
});

test('the repository is clean — this guard has no baseline and no allow-list', () => {
  const findings = scan(REPO_ROOT);
  assert.deepEqual(
    findings.map((f) => `${f.check} ${f.file}:${f.line}`),
    [],
    'a new violation landed; fix it rather than adding an exception',
  );
});

test('the guard file itself contains no result-discarding constructs', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'ci', 'check-deploy-failure-handling.mjs'), 'utf8');
  assert.doesNotMatch(src, /continue-on-error/);
  assert.doesNotMatch(src, /\|\| true/);
});
