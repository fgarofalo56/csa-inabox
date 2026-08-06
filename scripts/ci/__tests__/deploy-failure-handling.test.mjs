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
import os from 'node:os';
import path from 'node:path';

import {
  findHardCodedNotifyTargets,
  findHandRolledRetries,
  findAbsenceClaimedFromDiscardedError,
  checkTaxonomyIntegrity,
  inScopeWorkflows,
  isAzureMutatingCommand,
  azInvocations,
  scopeOf,
  assertDiscoveryHealthy,
  runBlocks,
  scan,
  IN_SCOPE,
  REPO_ROOT,
  TAXONOMY_REL,
} from '../check-deploy-failure-handling.mjs';

/** A literal backslash. Written this way because a raw template cannot end in one. */
const BS = String.fromCharCode(92);

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

// ── SCOPE: decided by behaviour, not by filename ─────────────────────────────
//
// The hole this replaces: scope was `/(^|[-_])(deploy|build|roll|rollback)/i`
// over the FILENAME. It matched 27 of 114 workflows and excluded 17 that mutate
// Azure, 11 of them `gov-provision-*` — the Gov path, where this guard is the
// only control. A rename defeats a name-based control; so does simply never
// having used the blessed word.

test('the classifier treats an UNKNOWN az verb as mutating (fail-safe, not fail-open)', () => {
  // The direct successor to the verb ALLOW-LIST that leaked. `az frobnicate`
  // does not exist; the point is that a verb nobody has enumerated lands IN
  // scope rather than slipping out of it.
  assert.equal(isAzureMutatingCommand('az frobnicate widget quantumise'), true);
});

test('the classifier separates mutation from read and from CLI-local, on the real spellings', () => {
  const table = [
    // The two spellings the verb allow-list missed, both measured in-repo.
    ['az keyvault secret set --vault-name "$KV" --name x --value y', true, 'ops-kv-secret-sync.yml'],
    ['az containerapp job start -g "$RG" -n "$JOB"', true, 'copilot-quality-evals.yml'],
    // Mutations.
    ['az acr build --registry "$ACR" --image x .', true, ''],
    ['az deployment group create -g "$RG" -f x.bicep', true, ''],
    ['az group delete -n "$RG" --yes', true, 'teardown'],
    ['az acr import -n "$ACR" --source docker.io/library/mongo:7', true, ''],
    ['az network private-endpoint create -g "$RG" -n "$PE"', true, ''],
    ['az ad app credential reset --id "$ID"', true, ''],
    ['az rest --method POST --url "$GRAPH/v1.0/servicePrincipals"', true, ''],
    ['az storage blob upload -f x -c y', true, ''],
    // Reads — must NOT scope a workflow in on their own.
    ['az group show -n "$RG" -o none 2>/dev/null', false, 'flag VALUE is not the verb'],
    ['az acr repository show-tags -n "$ACR"', false, ''],
    ['az account get-access-token', false, ''],
    ['az ad sp show --id "$ID"', false, ''],
    ['az rest --method GET --url x', false, ''],
    [`az keyvault list ${BS}`, false, 'trailing continuation is not the verb'],
    [`az datafactory pipeline-run query-by-factory ${BS}`, false, ''],
    // CLI-local: changes this runner, not Azure.
    ['az cloud set --name AzureUSGovernment', false, ''],
    ['az account set --subscription "$SUB"', false, ''],
    ['az config set extension.use_dynamic_install=yes_without_prompt', false, ''],
    ['az extension add --name containerapp', false, ''],
    ['az bicep build --file platform/fiab/bicep/main.bicep', false, ''],
    ['az graph query -q "resources | count"', false, ''],
    ['az acr login -n "$ACR"', false, ''],
    ['az group create --help', false, ''],
  ];
  for (const [cmd, want, note] of table) {
    assert.equal(isAzureMutatingCommand(cmd), want, `${cmd}${note ? ` (${note})` : ''}`);
  }
});

test('an az token inside PROSE is not an invocation', () => {
  // Both of these are real workflow lines. Classifying a log message as a
  // mutation scopes a workflow in on its documentation — the mirror image of
  // scoping one out on its filename. Neither decides on behaviour.
  assert.deepEqual(azInvocations('  echo "::warning::az identity show failed (not a divergence)"'), []);
  assert.deepEqual(azInvocations('  echo "az reported success but returned no id for $ag"'), []);
  // …while every real command position is still seen.
  assert.equal(azInvocations('  EXEC=$(az containerapp job start -g "$RG")').length, 1);
  assert.equal(azInvocations('        run: az cloud set --name AzureUSGovernment').length, 1);
  assert.equal(azInvocations('          if az acr login --name "$ACR"; then').length, 1);
});

test('gov-provision-* workflows are IN scope, and by BEHAVIOUR not by name', () => {
  const wfs = inScopeWorkflows();
  const gov = fs
    .readdirSync(path.join(REPO_ROOT, '.github', 'workflows'))
    .filter((f) => f.startsWith('gov-provision-') && f.endsWith('.yml'));
  assert.ok(gov.length >= 10, `expected the gov-provision family, found ${gov.length}`);
  for (const f of gov) {
    assert.ok(wfs.includes(f), `${f} mutates Azure but is out of scope`);
    assert.equal(IN_SCOPE.test(f), false, `${f} must be in scope on behaviour, not on its name`);
  }
  // The two measured exemplars, with the command that puts them in scope.
  assert.match(
    scopeOf('gov-provision-aisearch.yml', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/gov-provision-aisearch.yml'), 'utf8')).reason,
    /^runs `az /,
  );
  assert.match(
    scopeOf('gov-provision-maps.yml', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/gov-provision-maps.yml'), 'utf8')).reason,
    /az acr build/,
  );
});

test('a workflow whose az lives in a repo shell script is IN scope', () => {
  // teardown-fiab-commercial.yml has no inline `az`; it runs
  // .github/scripts/fiab-teardown.sh, which deletes resource groups. Following
  // the one hop is what stops "move the az into a script" from being an exit.
  const wfs = inScopeWorkflows();
  assert.ok(wfs.includes('teardown-fiab-commercial.yml'));
  const { reason } = scopeOf(
    'teardown-fiab-commercial.yml',
    fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/teardown-fiab-commercial.yml'), 'utf8'),
  );
  assert.match(reason, /invokes .*fiab-teardown\.sh/);
});

test('discovery is broad and non-degenerate', () => {
  const wfs = inScopeWorkflows();
  assert.ok(wfs.length >= 45, `only ${wfs.length} workflows in scope`);
  assert.ok(wfs.includes('full-app-deploy-commercial.yml'));
  assert.ok(wfs.includes('deploy-fiab-commercial.yml'));
  assert.ok(wfs.includes('loom-roll-and-validate.yml'));
  assert.ok(wfs.includes('ops-kv-secret-sync.yml'), 'az keyvault SECRET set was invisible to the verb allow-list');
  assert.ok(wfs.includes('dr-drill.yml'), 'runs az group create');
});

test('ANTI-COLLAPSE — the behavioural arm must keep contributing, or the guard fails loudly', () => {
  // Not a findings check: a DISCOVERY check. If a future edit breaks
  // isAzureMutatingCommand, scope silently reverts to the 27 name-matched files
  // and the guard reports green having looked at less. This is the ratchet that
  // makes that impossible; it cannot be satisfied by tolerating a violation.
  assert.deepEqual(assertDiscoveryHealthy(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scope-'));
  fs.writeFileSync(path.join(dir, 'deploy-thing.yml'), 'jobs:\n  a:\n    steps:\n      - run: echo hi\n');
  const problems = assertDiscoveryHealthy(dir, REPO_ROOT);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /BEHAVIOURAL arm matched nothing/);
});

test('runBlocks finds each `run: |` script and its start line', () => {
  const blocks = runBlocks('a:\n  b:\n    run: |\n      echo one\n      echo two\n  c: 1\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 3);
  assert.equal(blocks[0].body.length, 2);
});

test('runBlocks also finds single-line and folded `run:` (a literal block was not required)', () => {
  const single = runBlocks('    steps:\n      - run: az cloud set --name AzureUSGovernment\n');
  assert.equal(single.length, 1);
  assert.equal(single[0].startLine, 2);
  assert.match(single[0].body[0].text, /az cloud set/);

  const folded = runBlocks('a:\n  b:\n    run: >-\n      echo one\n      echo two\n  c: 1\n');
  assert.equal(folded.length, 1);
  assert.equal(folded[0].body.length, 2);
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
