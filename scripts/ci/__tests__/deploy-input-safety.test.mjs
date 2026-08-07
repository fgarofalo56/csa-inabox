/**
 * deploy-input-safety.test.mjs — the runtime refusal and the static shape guard
 * for deploy-fiab-commercial.yml's inputs (refs #3028, #3029, #3022).
 *
 * MUTATION-PROVED THROUGHOUT. Every guard here is exercised twice: once against
 * the real repo / a safe input set, where it must PASS, and once against a
 * mutant, where it must FAIL naming the defect. A guard that has only ever been
 * observed passing is not a guard — this repo has shipped several
 * (`csa_loom_gates_that_cannot_fail`), and the two defects under test were both
 * found by an operator, not by CI.
 *
 * The mutants change the CONTROL — the workflow's own YAML, the inputs the
 * workflow would pass — not the assertion.
 *
 * Run: node --test scripts/ci/__tests__/deploy-input-safety.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInputSafety, adminRgFor, formatSafetyReport } from '../deploy-input-safety.mjs';
import {
  checkInputs,
  checkSteps,
  run as runShapeGuard,
  WORKFLOW,
} from '../check-deploy-input-safety.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'ci', 'deploy-input-safety.mjs');
const YAML = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

/** The estate as it actually is: one hub, in centralus. */
const LIVE = {
  eventName: 'workflow_dispatch',
  resolvedRegion: 'centralus',
  resolvedRegionSource: 'input',
  requestedRegion: 'centralus',
  hubPresent: 'true',
  deployAppsEnabled: 'true',
};

/** Run the gate as CI would, and report its exit code. */
function runGate(env) {
  try {
    const stdout = execFileSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// ===========================================================================
// #3028 — keep_resources=false is a TEARDOWN, and must be refused unconfirmed
// ===========================================================================

test('#3028 MUTANT: run_mode=full with the old default (keep_resources=false) and no confirmation is REFUSED', () => {
  const v = resolveInputSafety({ ...LIVE, runMode: 'full', keepResources: 'false' });
  assert.equal(v.decision, 'refuse');
  assert.equal(v.teardownArmed, false);
  const text = v.violations.join(' ');
  assert.match(text, /TEARDOWN run/);
  assert.match(text, /every `rg-csa-loom-\*` resource group/i, 'the refusal must state the true blast radius');
  assert.match(text, /rg-csa-loom-admin-centralus/, 'it must name the RG the operator would have to type');
});

test('#3028 CONTROL: the same run with keep_resources=true proceeds', () => {
  const v = resolveInputSafety({ ...LIVE, runMode: 'full', keepResources: 'true' });
  assert.equal(v.decision, 'proceed');
  assert.equal(v.teardownArmed, false);
});

test('#3028 a deliberate teardown, confirmed with the EXACT resource group, proceeds and is armed', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'false', confirmTeardownRg: 'rg-csa-loom-admin-centralus',
  });
  assert.equal(v.decision, 'proceed');
  assert.equal(v.teardownArmed, true);
  assert.match(v.notes.join(' '), /TEARDOWN ARMED/);
});

test('#3028 a confirmation for a DIFFERENT resource group does not authorise this one', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'false', confirmTeardownRg: 'rg-csa-loom-admin-eastus2',
  });
  assert.equal(v.decision, 'refuse');
  assert.match(v.violations.join(' '), /does not match the resource group this run resolved/);
});

test('#3028 keep_resources=true AND a teardown confirmation is contradictory, not resolved silently', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'true', confirmTeardownRg: 'rg-csa-loom-admin-centralus',
  });
  assert.equal(v.decision, 'refuse');
  assert.match(v.violations.join(' '), /contradictory/);
});

test('#3028 a whatif-only run applies nothing, so a teardown confirmation on it is refused as a mistake', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'whatif-only', keepResources: 'true', confirmTeardownRg: 'rg-csa-loom-admin-centralus',
  });
  assert.equal(v.decision, 'refuse');
});

test('#3028 a scheduled run has no teardown decision to make and proceeds', () => {
  const v = resolveInputSafety({
    eventName: 'schedule', runMode: '', keepResources: '',
    resolvedRegion: 'centralus', resolvedRegionSource: 'adopted', hubPresent: 'true',
    deployAppsEnabled: 'true',
  });
  assert.equal(v.decision, 'proceed');
  assert.equal(v.teardownArmed, false);
});

// ===========================================================================
// #3029 — the region must be measured, never assumed or silently overridden
// ===========================================================================

test('#3029 MUTANT: an empty resolved region is REFUSED rather than producing malformed names', () => {
  const v = resolveInputSafety({ ...LIVE, resolvedRegion: '', requestedRegion: '', runMode: 'full', keepResources: 'true' });
  assert.equal(v.decision, 'refuse');
  assert.match(v.violations.join(' '), /EMPTY STRING/);
});

test('#3029 MUTANT: a region input the resolver silently overrode is REFUSED', () => {
  const v = resolveInputSafety({
    ...LIVE, requestedRegion: 'eastus2', resolvedRegion: 'centralus', runMode: 'full', keepResources: 'true',
  });
  assert.equal(v.decision, 'refuse');
  assert.match(v.violations.join(' '), /silently overrides/);
});

test('#3029 an ADOPTED region says so out loud, so the operator can see which estate was chosen', () => {
  const v = resolveInputSafety({
    ...LIVE, requestedRegion: '', resolvedRegionSource: 'adopted', runMode: 'full', keepResources: 'true',
  });
  assert.equal(v.decision, 'proceed');
  assert.match(v.notes.join(' '), /ADOPTED from the estate: centralus/);
});

test('adminRgFor derives exactly the name fiab-teardown.sh is pointed at', () => {
  assert.equal(adminRgFor('centralus'), 'rg-csa-loom-admin-centralus');
  assert.equal(adminRgFor(' centralus '), 'rg-csa-loom-admin-centralus');
});

test('every violation is reported, not just the first', () => {
  const v = resolveInputSafety({
    eventName: 'workflow_dispatch', runMode: 'full', keepResources: 'false',
    requestedRegion: 'eastus2', resolvedRegion: 'centralus', resolvedRegionSource: 'adopted',
  });
  assert.equal(v.decision, 'refuse');
  assert.ok(v.violations.length >= 2, `expected the region AND the teardown violation, got ${v.violations.length}`);
});

// ===========================================================================
// The gate as CI actually runs it — exit codes, not just return values
// ===========================================================================

test('EXECUTED: the gate exits NON-ZERO on the accept-every-default teardown', () => {
  const r = runGate({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_RUN_MODE: 'full',
    INPUT_KEEP_RESOURCES: 'false',
    INPUT_CONFIRM_TEARDOWN_RG: '',
    INPUT_REGION: 'centralus',
    RESOLVED_REGION: 'centralus',
    RESOLVED_REGION_SOURCE: 'input',
    DEPLOY_APPS_ENABLED: 'true',
    HUB_PRESENT: 'true',
  });
  assert.equal(r.code, 1, 'the gate must FAIL the job, not merely print a warning');
  assert.match(r.out, /REFUSED/);
});

test('EXECUTED: the gate exits ZERO on the same run with the safe default', () => {
  const r = runGate({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_RUN_MODE: 'full',
    INPUT_KEEP_RESOURCES: 'true',
    INPUT_CONFIRM_TEARDOWN_RG: '',
    INPUT_REGION: 'centralus',
    RESOLVED_REGION: 'centralus',
    RESOLVED_REGION_SOURCE: 'input',
    DEPLOY_APPS_ENABLED: 'true',
    HUB_PRESENT: 'true',
  });
  assert.equal(r.code, 0, r.out);
});

test('EXECUTED: the gate exits NON-ZERO when the resolver overrode an explicit region', () => {
  const r = runGate({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_RUN_MODE: 'full',
    INPUT_KEEP_RESOURCES: 'true',
    INPUT_REGION: 'eastus2',
    RESOLVED_REGION: 'centralus',
    RESOLVED_REGION_SOURCE: 'adopted',
    DEPLOY_APPS_ENABLED: 'true',
    HUB_PRESENT: 'true',
  });
  assert.equal(r.code, 1);
});

test('the report names the target resource group and the teardown state', () => {
  const ctx = { ...LIVE, runMode: 'full', keepResources: 'true' };
  const text = formatSafetyReport(resolveInputSafety(ctx), ctx);
  assert.match(text, /rg-csa-loom-admin-centralus/);
  assert.match(text, /teardown: \*\*NOT armed\*\*/);
});

// ===========================================================================
// The STATIC guard — the workflow's shape, mutation-proved against the real file
// ===========================================================================

test('the shape guard is clean on the real workflow', () => {
  const problems = runShapeGuard();
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('MUTANT: keep_resources back to `default: false` -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /(keep_resources:[\s\S]*?)default: true/,
    '$1default: false',
  );
  assert.notEqual(mutant, YAML, 'the mutation did not apply — the test would prove nothing');
  const problems = checkInputs(mutant);
  assert.ok(
    problems.some((p) => /does not default to TRUE/.test(p)),
    `expected a keep_resources violation, got: ${problems.join(' | ')}`,
  );
});

test('MUTANT: the eastus2 fallback restored in `env:` -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /AZURE_LOCATION: \$\{\{ inputs\.region \}\}/,
    "AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}",
  );
  assert.notEqual(mutant, YAML);
  const problems = checkInputs(mutant);
  assert.ok(
    problems.some((p) => /FALLBACK region/.test(p)),
    `expected the fallback-region violation, got: ${problems.join(' | ')}`,
  );
});

test('MUTANT: region made optional again -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /(region:\n\s+description: 'REQUIRED\.[\s\S]*?\n\s+type: string\n\s+)required: true/,
    '$1required: false',
  );
  assert.notEqual(mutant, YAML);
  const problems = checkInputs(mutant);
  assert.ok(
    problems.some((p) => /not `required: true`/.test(p)),
    `expected the region violation, got: ${problems.join(' | ')}`,
  );
});

test('MUTANT: the teardown confirmation clause removed -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /\n\s+&& inputs\.confirm_teardown_rg == format\('rg-csa-loom-admin-\{0\}', steps\.reconcile\.outputs\.region\)/,
    '',
  );
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /does not require `inputs\.confirm_teardown_rg`/.test(p)),
    `expected the teardown-confirmation violation, got: ${problems.join(' | ')}`,
  );
});

test('MUTANT: the runtime gate given an `if:` -> the shape guard FAILS (a gate with an off switch)', () => {
  const mutant = YAML.replace(
    /(- name: Deploy input safety gate[^\n]*\n\s+id: input_safety\n)/,
    "$1        if: inputs.run_mode == 'full'\n",
  );
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /gate with a condition is a gate with an off switch/.test(p)),
    `expected the conditional-gate violation, got: ${problems.join(' | ')}`,
  );
});

test('MUTANT: the runtime gate removed entirely -> the shape guard FAILS', () => {
  const mutant = YAML.replace('node scripts/ci/deploy-input-safety.mjs', 'true # removed');
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /no step runs `node scripts\/ci\/deploy-input-safety\.mjs`/.test(p)),
    `expected the missing-gate violation, got: ${problems.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// #3022 — the what-if must preview what the apply applies
// ---------------------------------------------------------------------------

test('#3022 MUTANT: the what-if restating its own --parameters -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /az deployment sub what-if "\$\{DEPLOY_ARGS\[@\]\}"/,
    'az deployment sub what-if --template-file platform/fiab/bicep/main.bicep --parameters platform/fiab/bicep/params/commercial.bicepparam',
  );
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /does not expand the shared argument list/.test(p)),
    `expected the parity violation, got: ${problems.join(' | ')}`,
  );
  assert.ok(
    problems.some((p) => /restates `--template-file`/.test(p)),
    'the guard must also name the restated arguments',
  );
});

test('#3022 MUTANT: a SECOND argument-composition step -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /(echo "deploy_args_file=\$ARGS_FILE" >> "\$GITHUB_OUTPUT")/,
    '$1\n          echo "deploy_args_file=$ARGS_FILE.copy" >> "$GITHUB_OUTPUT"',
  );
  // Same step, so the step COUNT is unchanged — assert against the real risk
  // instead: two steps, which is what an edit that re-splits them would create.
  const twoSteps = YAML.replace(
    /(      - name: Bicep what-if \(preview\))/,
    '      - name: Compose deployment arguments (second copy)\n' +
    '        id: params2\n' +
    '        run: |\n' +
    '          echo "deploy_args_file=/tmp/other.txt" >> "$GITHUB_OUTPUT"\n' +
    '$1',
  );
  assert.notEqual(twoSteps, YAML);
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(twoSteps);
  assert.ok(
    problems.some((p) => /expected exactly ONE step to compose/.test(p)),
    `expected the two-composition violation, got: ${problems.join(' | ')}`,
  );
});

test('#3022 MUTANT: the MSAL resolve moved back after the composition -> the shape guard FAILS', () => {
  // Cut the MSAL step out and re-insert it after the what-if, which is exactly
  // the ordering the workflow shipped with.
  const stepRe = /      - name: Resolve the existing MSAL client id[\s\S]*?(?=\n      # ── ONE PARAMETER SOURCE)/;
  const m = stepRe.exec(YAML);
  assert.ok(m, 'could not locate the MSAL step — the mutation would prove nothing');
  const without = YAML.replace(stepRe, '');
  const mutant = without.replace(
    /(      - name: Image preflight)/,
    `${m[0]}\n$1`,
  );
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /runs AFTER the deployment arguments are composed/.test(p)),
    `expected the MSAL-ordering violation, got: ${problems.join(' | ')}`,
  );
});

test('#3022 MUTANT: the MSAL resolve gated on the trigger again -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /(- name: Resolve the existing MSAL client id[^\n]*\n\s+id: msal\n)/,
    "$1        if: github.event_name == 'schedule' || inputs.run_mode == 'full'\n",
  );
  assert.notEqual(mutant, YAML);
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /gated on the trigger/.test(p)),
    `expected the MSAL-gating violation, got: ${problems.join(' | ')}`,
  );
});

// ===========================================================================
// The apps-enabled image hazard, measured live on 2026-08-06
// ===========================================================================

test('an apps-enabled DISPATCH with an UNKNOWN running tag is REFUSED (it would roll the app backwards)', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'true', deployAppsEnabled: 'true',
    unknownImageKeys: 'unity',
  });
  assert.equal(v.decision, 'refuse');
  const text = v.violations.join(' ');
  assert.match(text, /unity/);
  assert.match(text, /REWRITES/);
  assert.match(text, /az containerapp update/, 'the refusal must carry a remediation the operator can run');
});

test('the same UNKNOWN key is only a NOTE on an infra-only run — nothing is re-imaged', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'true', deployAppsEnabled: 'false',
    unknownImageKeys: 'unity',
  });
  assert.equal(v.decision, 'proceed');
  assert.match(v.notes.join(' '), /no running image is at risk/);
});

test('an apps-enabled run with NO unknown keys proceeds', () => {
  const v = resolveInputSafety({
    ...LIVE, runMode: 'full', keepResources: 'true', deployAppsEnabled: 'true', unknownImageKeys: '',
  });
  assert.equal(v.decision, 'proceed');
});

test('EXECUTED: the gate exits NON-ZERO on an apps-enabled dispatch with an UNKNOWN tag', () => {
  const r = runGate({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_RUN_MODE: 'full',
    INPUT_KEEP_RESOURCES: 'true',
    INPUT_REGION: 'centralus',
    RESOLVED_REGION: 'centralus',
    RESOLVED_REGION_SOURCE: 'input',
    DEPLOY_APPS_ENABLED: 'true',
    UNKNOWN_IMAGE_KEYS: 'unity',
    HUB_PRESENT: 'true',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /unity/);
});

// ---------------------------------------------------------------------------
// CONTROLS — the guard must be capable of failing, and of parsing
// ---------------------------------------------------------------------------

test('CONTROL: the shape guard fails closed when the workflow cannot be parsed into steps', () => {
  const problems = checkSteps('name: x\non:\n  workflow_dispatch:\n');
  assert.ok(
    problems.some((p) => /DISCOVERY FLOOR/.test(p)),
    'an unparseable workflow must be an error, never silence',
  );
});

test('CONTROL: a missing input is a violation, not silence', () => {
  const mutant = YAML.replace(/      confirm_teardown_rg:\n/, '      confirm_teardown_rg_renamed:\n');
  const problems = checkInputs(mutant);
  assert.ok(problems.some((p) => /no `confirm_teardown_rg` input/.test(p)));
});
