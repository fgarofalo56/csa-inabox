/**
 * Self-tests for check-bicepparam-env-reaches-deploy.mjs (#3161).
 *
 * WHY THESE EXIST. The guard shipped with #3303 had NO test at all, and it
 * passed on a tree with three live blind spots — every one of them the same
 * shape as the bug it was written for. A guard nobody can show FAILING is not
 * evidence; it is a second thing to trust.
 *
 * Every CONTROL below is the REAL pre-fix workflow shape, embedded, and is
 * chosen to DIE under an obvious mutation of the guard:
 *
 *   - delete the indent check in envKeysAtIndent()  -> the #3161 control passes
 *     (that is the ORIGINAL bug: LOOM_UNITY_TAG was set on the image-preflight
 *     step at indent 10 while the deploying step had no env: at all).
 *   - revert paramFilesUsedIn() to `body.includes(name)` -> the mention control
 *     goes red (gov-uc-purview-wire.yml names il5.bicepparam inside an echo).
 *   - drop `azd provision` from DEPLOY_VERBS -> the azd control goes red.
 *   - drop the what-if verbs -> the preview control goes red.
 *   - drop the $GITHUB_ENV crediting -> the Commercial control goes red.
 *   - make forcesAppsDisabled() always false -> the apps-disabled control goes red.
 *   - drop the fallback-mismatch rule -> the IL5 v3.0 control goes red.
 *   - narrow attribution back to step scope -> the composed-args control goes red.
 *
 * Run: node --test scripts/ci/__tests__/bicepparam-env-reaches-deploy.test.mjs
 * (Auto-discovered by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyzeWorkflow,
  tagReads,
  paramFilesUsedIn,
  envKeysAtIndent,
  envFallbacks,
  githubEnvExports,
  deployVerbsIn,
  forcesAppsDisabled,
  jobsOf,
  loadParams,
  NO_AUTOMATED_DEPLOYER,
} from '../check-bicepparam-env-reaches-deploy.mjs';

/** One tag-reading param file, standing in for gcc-high.bicepparam. */
const PARAMS = new Map([['gcc-high.bicepparam', new Map([['LOOM_UNITY_TAG', 'v0.1'], ['LOOM_TRINO_TAG', 'v0.1']])]]);

const wf = (jobBody) => `name: t\non:\n  workflow_dispatch:\njobs:\n${jobBody}`;

// ---------------------------------------------------------------------------
// THE #3161 CONTROL — verbatim shape of the bug, reduced
// ---------------------------------------------------------------------------

test('CONTROL #3161: the tag is set on the PREFLIGHT step and the DEPLOYING step has no env at all', () => {
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Image preflight
        env:
          LOOM_UNITY_TAG: \${{ vars.LOOM_UNITY_TAG || 'v0.1' }}
          LOOM_TRINO_TAG: \${{ vars.LOOM_TRINO_TAG || 'v0.1' }}
        run: echo preflight
      - name: Provision
        run: |
          az deployment sub create \\
            --parameters platform/fiab/bicep/params/gcc-high.bicepparam
`);
  const r = analyzeWorkflow('t.yml', text, PARAMS);
  assert.equal(r.violations.length, 2, 'both tags must be reported missing on the DEPLOYING step');
  assert.ok(r.violations.every((v) => v.step === 'Provision'));
  assert.ok(r.violations.every((v) => v.rule === 'not-in-scope' && v.kind === 'apply'));
});

test('the same workflow PASSES once the deploying step carries the env (the #3303 fix)', () => {
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Provision
        env:
          LOOM_UNITY_TAG: \${{ vars.LOOM_UNITY_TAG || 'v0.1' }}
          LOOM_TRINO_TAG: \${{ vars.LOOM_TRINO_TAG || 'v0.1' }}
        run: az deployment sub create --parameters platform/fiab/bicep/params/gcc-high.bicepparam
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 0);
});

// ---------------------------------------------------------------------------
// BLIND SPOT 1 — job-scoped attribution (composed argument lists)
// ---------------------------------------------------------------------------

test('CONTROL: a deploy step whose param file is composed in a SIBLING step is still checked', () => {
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Compose deploy args
        run: |
          add --parameters platform/fiab/bicep/params/gcc-high.bicepparam
      - name: Provision
        run: az deployment sub create $DEPLOY_ARGS
`);
  const r = analyzeWorkflow('t.yml', text, PARAMS);
  assert.equal(r.violations.length, 2, 'step-scoped attribution silently SKIPPED this — the shape Commercial uses');
  assert.ok(r.violations.every((v) => v.step === 'Provision'));
});

test('a param file MENTIONED in an echo is not a deploy (the #2816 false-positive shape)', () => {
  // The real gov-uc-purview-wire.yml line: it deploys loom-unity-app.bicep and
  // merely names il5.bicepparam while explaining its own refusal.
  const line = '            echo "::error::loom-unity:v0.1 is NOT in $ACR — that is the exact tag gcc-high.bicepparam pull. Refusing."';
  assert.deepEqual(paramFilesUsedIn(line, ['gcc-high.bicepparam']), []);
  const text = wf(`  wire:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy the OSS Unity Catalog Container App
        run: |
${line}
          az deployment group create --template-file loom-unity-app.bicep
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 0);
});

test('an indirect reference through a job-level *PARAM* key IS a deploy (loom-drift-check shape)', () => {
  assert.deepEqual(paramFilesUsedIn('      PARAMS_FILE: gcc-high.bicepparam', ['gcc-high.bicepparam']), ['gcc-high.bicepparam']);
  const text = wf(`  drift:
    runs-on: ubuntu-latest
    env:
      PARAMS_FILE: gcc-high.bicepparam
    steps:
      - name: What-if
        run: az deployment sub what-if --parameters "platform/fiab/bicep/params/$PARAMS_FILE"
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 2);
});

// ---------------------------------------------------------------------------
// BLIND SPOT 2 — azd provision
// ---------------------------------------------------------------------------

test('CONTROL: azd provision is a deployment (the GCC-High default branch)', () => {
  assert.deepEqual(deployVerbsIn('          -- azd provision --no-prompt').map((v) => v.name), ['azd provision']);
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Provision
        run: |
          if [ "$T" = "dlz-attach" ]; then
            az deployment sub create --parameters platform/fiab/bicep/params/gcc-high.bicepparam
          else
            azd provision --no-prompt
          fi
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 2);
});

// ---------------------------------------------------------------------------
// BLIND SPOT 3 — what-if is the artifact operators read
// ---------------------------------------------------------------------------

test('CONTROL: a what-if that resolves different tags than the apply is a lying preview', () => {
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Bicep what-if
        run: az deployment sub what-if --parameters platform/fiab/bicep/params/gcc-high.bicepparam
`);
  const r = analyzeWorkflow('t.yml', text, PARAMS);
  assert.equal(r.violations.length, 2);
  assert.ok(r.violations.every((v) => v.kind === 'preview'));
});

test('a what-if that FORCES deployAppsEnabled=false cannot evaluate an image tag, so it is out of scope', () => {
  assert.equal(forcesAppsDisabled('   --parameters deployAppsEnabled=false \\'), true);
  // UNKNOWN stays in scope: an unread value is never spent as a reason to skip.
  assert.equal(forcesAppsDisabled('   --parameters deployAppsEnabled=${{ inputs.apps }} \\'), false);
  const text = wf(`  drift:
    runs-on: ubuntu-latest
    steps:
      - name: What-if
        run: |
          az deployment sub what-if \\
            --parameters platform/fiab/bicep/params/gcc-high.bicepparam \\
            --parameters deployAppsEnabled=false
`);
  const r = analyzeWorkflow('t.yml', text, PARAMS);
  assert.equal(r.violations.length, 0);
  assert.deepEqual([...r.deployedParams], ['gcc-high.bicepparam'], 'still counts as a DEPLOYER for coverage');
});

// ---------------------------------------------------------------------------
// $GITHUB_ENV crediting — how Commercial legitimately passes
// ---------------------------------------------------------------------------

test('CONTROL: a preceding reconcile-resolve.mjs step puts the tags in scope', () => {
  assert.ok(githubEnvExports('        run: node scripts/ci/reconcile-resolve.mjs').has('LOOM_UNITY_TAG'));
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve reconcile target
        run: node scripts/ci/reconcile-resolve.mjs
      - name: Provision
        run: az deployment sub create --parameters platform/fiab/bicep/params/gcc-high.bicepparam
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 0);
});

test('ORDER MATTERS: a $GITHUB_ENV write AFTER the deploy does not reach it', () => {
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Provision
        run: az deployment sub create --parameters platform/fiab/bicep/params/gcc-high.bicepparam
      - name: Resolve reconcile target
        run: node scripts/ci/reconcile-resolve.mjs
`);
  assert.equal(analyzeWorkflow('t.yml', text, PARAMS).violations.length, 2);
});

test('a literal echo into $GITHUB_ENV is credited', () => {
  assert.ok(githubEnvExports('          echo "LOOM_UNITY_TAG=$T" >> "$GITHUB_ENV"').has('LOOM_UNITY_TAG'));
});

// ---------------------------------------------------------------------------
// fallback-mismatch — the defect the #3161 FIX introduced
// ---------------------------------------------------------------------------

test('CONTROL: an env fallback that differs from the param default is an invisible override', () => {
  const il5 = new Map([['il5.bicepparam', new Map([['LOOM_CONSOLE_TAG', 'v3.0']])]]);
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Provision
        env:
          LOOM_CONSOLE_TAG: \${{ vars.LOOM_CONSOLE_TAG || 'v0.1' }}
        run: az deployment sub create --parameters platform/fiab/bicep/params/il5.bicepparam
`);
  const r = analyzeWorkflow('t.yml', text, il5);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].rule, 'fallback-mismatch');
  assert.equal(r.violations[0].forced, 'v0.1');
  assert.equal(r.violations[0].fallback, 'v3.0');
});

test('the SAME workflow passes when the literal matches the param file', () => {
  const il5 = new Map([['il5.bicepparam', new Map([['LOOM_CONSOLE_TAG', 'v3.0']])]]);
  const text = wf(`  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Provision
        env:
          LOOM_CONSOLE_TAG: \${{ vars.LOOM_CONSOLE_TAG || 'v3.0' }}
        run: az deployment sub create --parameters platform/fiab/bicep/params/il5.bicepparam
`);
  assert.equal(analyzeWorkflow('t.yml', text, il5).violations.length, 0);
});

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

test('envKeysAtIndent distinguishes step-level env from job/workflow level', () => {
  const job = `  deploy:
    runs-on: ubuntu-latest
    env:
      JOB_LEVEL: x
    steps:
      - name: s
        env:
          STEP_LEVEL: y
        run: echo
`;
  assert.ok(envKeysAtIndent(job, 4).has('JOB_LEVEL'));
  assert.ok(!envKeysAtIndent(job, 4).has('STEP_LEVEL'), 'a step env must NOT read as job-wide — the #3161 shape');
  assert.ok(envKeysAtIndent(job, 8).has('STEP_LEVEL'));
});

test('tagReads captures the default, which is what makes the bug silent', () => {
  const reads = tagReads("  unity: readEnvironmentVariable('LOOM_UNITY_TAG', 'v0.1')\n");
  assert.equal(reads.get('LOOM_UNITY_TAG'), 'v0.1');
});

test('envFallbacks only matches the vars-with-default shape', () => {
  assert.equal(envFallbacks("          LOOM_UNITY_TAG: ${{ vars.LOOM_UNITY_TAG || 'v9' }}").get('LOOM_UNITY_TAG'), 'v9');
  assert.equal(envFallbacks('          LOOM_UNITY_TAG: ${{ steps.x.outputs.t }}').size, 0);
});

test('CRLF does not blind the indent-anchored matchers', () => {
  const crlf = "  deploy:\r\n    env:\r\n      LOOM_UNITY_TAG: v1\r\n";
  assert.ok(envKeysAtIndent(crlf, 4).has('LOOM_UNITY_TAG'));
});

test('jobsOf splits on job ids at indent 2 only', () => {
  const ids = jobsOf(wf('  a:\n    runs-on: x\n    steps:\n      - name: s\n        run: echo\n  b:\n    runs-on: y\n')).map((j) => j.id);
  assert.deepEqual(ids, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// The guard against the guard: the real tree must stay green, and the
// declaration list must stay honest.
// ---------------------------------------------------------------------------

test('every NO_AUTOMATED_DEPLOYER entry still names a real, tag-reading param file', () => {
  const real = loadParams();
  for (const name of Object.keys(NO_AUTOMATED_DEPLOYER)) {
    assert.ok(real.has(name), `${name} is declared as undeployed but is no longer a tag-reading param file — stale declaration`);
  }
});

test('the shipped Gov lanes carry the tag env on BOTH the what-if and the apply', () => {
  const real = loadParams();
  for (const [file, param] of [
    ['.github/workflows/deploy-fiab-gcch.yml', 'gcc-high.bicepparam'],
    ['.github/workflows/deploy-fiab-il5.yml', 'il5.bicepparam'],
  ]) {
    const r = analyzeWorkflow(file, readFileSync(file, 'utf8'), real);
    assert.equal(
      r.violations.length, 0,
      `${file} regressed: ${r.violations.map((v) => `${v.step}/${v.missing}/${v.rule}`).join(', ')}`,
    );
    assert.ok(r.deployedParams.has(param), `${file} must still be attributed ${param}`);
    assert.ok(r.deployingSteps >= 2, `${file} should have both a what-if and an apply in scope`);
  }
});
