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
  ENV_BINDS_REGION_INPUT,
  WORKFLOW,
} from '../check-deploy-input-safety.mjs';
import { parseWorkflowSteps } from '../check-reconcile-safety.mjs';

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

// S7 — the shape that slipped past S5. #3067 assembled the dlz-attach hub
// coordinates into a HUB_PARAMS *variable* inside BOTH az steps: two copies of
// a parameter list, invisible to a guard that only looks for `--parameters`.
test('#3067 MUTANT: hub params re-assembled inside the apply step -> the shape guard FAILS', () => {
  const mutant = YAML.replace(
    /(          echo "::notice::Applying deployment arguments sha256=)/,
    '          HUB_PARAMS=""\n' +
    '          if [ "$CSA_LOOM_TOPOLOGY" = "dlz-attach" ]; then\n' +
    '            HUB_PARAMS="hubAdminSubscriptionId=$HUB_ADMIN_SUB hubVnetId=$HUB_VNET_ID"\n' +
    '          fi\n' +
    '$1',
  );
  assert.notEqual(mutant, YAML, 'the mutation did not apply — the test would prove nothing');
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /assembles bicep parameter\(s\).*hubAdminSubscriptionId/.test(p)),
    `expected the second-assembly violation, got: ${problems.join(' | ')}`,
  );
});

test('S7 CONTROL: a parameter merely NAMED in a diagnostic is not an assembly', () => {
  // Several steps legitimately mention a parameter in an ::error:: / ::warning::
  // string. The real workflow contains four such mentions; if the guard counted
  // them it would be unusable and would be switched off.
  const problems = checkSteps(YAML);
  assert.deepEqual(
    problems.filter((p) => /assembles bicep parameter/.test(p)), [],
    'the real workflow must be clean — mentions are not assemblies',
  );
});

test('S7 CONTROL: the parameter-name set is derived, and is not empty', () => {
  // If the extraction regex stops matching, S7 silently watches nothing. The
  // floor turns that into an error instead.
  const mutant = YAML.replace(/--parameters "/g, '--parameters $');
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /DISCOVERY FLOOR: extracted \d+ bicep parameter name/.test(p)),
    `expected the extraction floor to fire, got: ${problems.join(' | ')}`,
  );
});

test('the dlz-attach hub coordinates are in the ONE composed vector, before the what-if', () => {
  const steps = parseWorkflowSteps(YAML);
  const code = (s) => s.body.filter((l) => !/^\s*#/.test(l)).join('\n');
  const composeIdx = steps.findIndex((s) => code(s).includes('deploy_args_file='));
  const whatIfIdx = steps.findIndex((s) => /az deployment sub what-if/.test(s.run));
  const applyIdx = steps.findIndex((s) => /az deployment sub create/.test(s.run));

  assert.ok(composeIdx >= 0 && whatIfIdx >= 0 && applyIdx >= 0);
  assert.ok(composeIdx < whatIfIdx, 'the arguments must be composed BEFORE the preview');
  assert.ok(whatIfIdx < applyIdx);

  const compose = code(steps[composeIdx]);
  for (const p of [
    'hubAdminSubscriptionId', 'hubVnetId', 'hubConsolePrincipalId', 'hubConsoleUamiName',
    'hubConsoleUamiAppId', 'hubConsoleUamiId',
    // #2682 / #3067 — optional, appended only when discovery found them.
    'hubAcrLoginServer', 'hubCaeId', 'hubKeyVaultId',
  ]) {
    assert.match(compose, new RegExp(`--parameters "${p}=`), `${p} is not in the composed vector`);
  }
  // The three optional ones keep the SC2015-avoiding `if` form #3067 chose.
  for (const v of ['HUB_ACR_LOGIN', 'HUB_CAE_ID', 'HUB_KV_ID']) {
    assert.match(
      compose, new RegExp(`if \\[ -n "\\$\\{${v}:-\\}" \\]; +then add --parameters`),
      `${v} must be appended by an if-block, not \`[ -n x ] && …\` (SC2015; its exit status leaks under set -e)`,
    );
  }
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
// S8 — #3701: no step may TRUST the raw `region` input
//
// `inputs.region` is EMPTY on a `schedule` event. The DLZ adopt step carried
// `REGION: ${…inputs.region}` in its `env:`, so every nightly ran
// resolve-dlz-coordinates.mjs with `--region ""`, got EXIT.USAGE(2), and a
// trailing `|| echo` rendered that as "found no unambiguous DLZ". The adopt plan
// came out `{}`, `loomStorageAccount` composed to '', and because the lake env
// block is `!empty(loomStorageAccount) ? [ … ] : []` the deploy REMOVED seven
// LOOM_* variables from the running console — and reported success.
//
// Measured, same code, only the trigger differing:
//   31898068403  workflow_dispatch  adopting: databricks,eventhubs,storage-adls,synapse
//   31870181337 / 31932209496 / 32004118361  schedule  adopting: (none), all green
// ---------------------------------------------------------------------------

test('S8: the real workflow has no step that trusts the raw region input', () => {
  const problems = checkSteps(YAML);
  assert.deepEqual(
    problems.filter((p) => /reads `inputs\.region`/.test(p)), [],
    'a step is trusting inputs.region — on a schedule that is the empty string',
  );
});

// ---------------------------------------------------------------------------
// Restoring the #3701 shape takes TWO edits, not one.
//
// The step `env:` is applied BEFORE the `run:` body executes, so putting
// `REGION: ${{ inputs.region }}` back while the fix's `REGION="${AZURE_LOCATION:-}"`
// still stands leaves the workflow BEHAVIOURALLY CORRECT — the shell read
// overwrites the env value. A one-edit mutant therefore proves nothing about the
// guard; it only proves the guard does not fire on a correct workflow.
//
// The defect as it actually shipped was `env:`-ONLY: measured on the pre-fix
// file, the step had no shell `REGION=` assignment and no `AZURE_LOCATION` at
// all. Both edits, each with its own precondition, reproduce it.
// ---------------------------------------------------------------------------

/** `env:` entry the #3701 shape hung off, restored after the surviving one. */
const ENV_ANCHOR = /(          ADMIN_SUB: \$\{\{ steps\.topology_guard\.outputs\.deploy_sub \}\}\n)/;
/** The fix's shell read plus the refusal that guards it — absent pre-fix. */
const SHELL_READ = /          REGION="\$\{AZURE_LOCATION:-\}"\n          if \[ -z "\$REGION" \]; then\n(?:[^\n]*\n)*?          fi\n/;

/** Edit 1 only: the env: binding back, the shell read left standing. */
function restoreEnvBinding(yaml) {
  assert.ok(ENV_ANCHOR.test(yaml), 'the ADMIN_SUB env anchor is gone — the mutation would prove nothing');
  const out = yaml.replace(ENV_ANCHOR, '$1          REGION: ${{ inputs.region }}\n');
  assert.notEqual(out, yaml, 'the env-binding mutation did not apply');
  return out;
}

/** Edit 2: strip the fix, leaving the step with no measured region at all. */
function stripShellRead(yaml) {
  assert.ok(SHELL_READ.test(yaml), 'the shell read is gone — the mutation would prove nothing');
  const out = yaml.replace(SHELL_READ, '');
  assert.notEqual(out, yaml, 'the shell-read strip did not apply');
  return out;
}

test('S8 MUTANT: the #3701 shape restored (env: binding + the shell read stripped) -> the shape guard FAILS', () => {
  const mutant = stripShellRead(restoreEnvBinding(YAML));
  // Faithfulness check: the shipped defect had NO measured region in its wiring.
  // If AZURE_LOCATION survived, the mutant would be a different, weaker shape.
  const step = mutant.slice(mutant.indexOf('        id: dlz_adopt'));
  const body = step.slice(0, step.indexOf('      - name:')).split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*(echo|printf)\s/.test(l)).join('\n');
  assert.ok(
    !body.includes('AZURE_LOCATION'),
    'the mutant still holds the measured region in its wiring — that is not the #3701 shape',
  );

  const problems = checkSteps(mutant).filter((p) => /reads `inputs\.region`/.test(p));
  assert.equal(problems.length, 1, `expected exactly one S8 violation, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /Adopt the DLZ/);
});

test('S8: a DEAD env binding is flagged even though the shell read currently overwrites it', () => {
  // Restoring the `env:` line alone leaves the fix's `REGION="${AZURE_LOCATION:-}"`
  // standing, and a step `env:` is applied BEFORE the `run:` body executes — so
  // the shell read wins and the workflow is, today, behaviourally correct.
  //
  // It is still flagged, deliberately. That safety is ORDER-DEPENDENT: the env
  // entry has no effect other than to arm a trap that fires the moment someone
  // deletes the shell line as redundant — and "the body happens to overwrite it"
  // is precisely the kind of evaluation-order reasoning that produced #3701.
  // The rule stays simple and checkable: do not bind `inputs.region` into a step
  // `env:` unless that step reconciles it.
  //
  // This costs nothing in false positives — the real workflow binds it in no
  // step at all, which the control below pins.
  const mutant = restoreEnvBinding(YAML);
  const problems = checkSteps(mutant).filter((p) => /(reads|binds) `inputs\.region`/.test(p));
  assert.equal(problems.length, 1, `expected the dead-binding violation, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /Adopt the DLZ/);
});

test('S8 CONTROL: the only steps binding `inputs.region` bind INPUT_REGION and reconcile it', () => {
  const steps = parseWorkflowSteps(YAML);
  const bound = steps.filter((s) => s.body.some((l) => ENV_BINDS_REGION_INPUT.test(l)));
  assert.ok(bound.length >= 2, `expected >= 2 binding steps, found ${bound.length} — the extraction stopped matching`);
  // The two legitimate readers bind INPUT_REGION — a DIFFERENT name — and both
  // carry a strong reconciliation marker, so they are exempt for a stated
  // reason rather than by accident.
  for (const s of bound) {
    const names = s.body.map((l) => ENV_BINDS_REGION_INPUT.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(names, ['INPUT_REGION'],
      `step "${s.name}" binds inputs.region to ${names.join(',')} — only INPUT_REGION is expected here`);
  }
  assert.deepEqual(checkSteps(YAML).filter((p) => /(reads|binds) `inputs\.region`/.test(p)), []);
});

test('the resolver`s exit-1 arm requires the POSITIVE DLZ_STATUS marker, not just the code', () => {
  // node exits 1 for an uncaught throw AND for a module-load failure — the same
  // code that means "Resource Graph was read and nothing matched". Rename the
  // resolver and, on the code alone, the nightly reports a confident greenfield
  // negative forever. The arm must consult a marker the resolver only writes on
  // a MEASURED path. Pinned here so it cannot be simplified back to the code.
  const steps = parseWorkflowSteps(YAML);
  const adopt = steps.find((s) => /Adopt the DLZ/.test(s.name));
  assert.ok(adopt, 'the adopt step is gone — this control is stale');
  const body = adopt.body.join('\n');
  assert.match(body, /grep -q '\^DLZ_STATUS=not-found\$'/,
    'the exit-1 arm no longer requires the positive marker, so a crash reads as a greenfield measurement');
  // …and the resolver must still WRITE it, or the grep above fails every run.
  const resolver = readFileSync(
    path.join(REPO_ROOT, 'scripts', 'csa-loom', 'resolve-dlz-coordinates.mjs'), 'utf8',
  );
  assert.match(resolver, /DLZ_STATUS=\$\{result\.status\}/,
    'resolve-dlz-coordinates no longer writes DLZ_STATUS — the workflow grep would refuse every run');
});

test('S8 MUTANT: the #3701 shape hidden behind an UNRELATED AZURE_LOCATION use -> the shape guard STILL FAILS', () => {
  // The hole `AZURE_LOCATION`-as-bare-substring left open. Thirteen steps
  // interpolate `${AZURE_LOCATION}` to build a resource-group name; before the
  // marker became a PAIRED exemption, one such line anywhere in the adopt step
  // would have exempted it while it still consumed `$REGION` from `env:` —
  // #3701 restored, and invisible.
  let mutant = stripShellRead(restoreEnvBinding(YAML));
  const before = mutant;
  mutant = mutant.replace(
    /(          INPUT_DLZ_SUBSCRIPTION=""; INPUT_DLZ_DOMAIN=""\n)/,
    '          DIAG_RG="rg-csa-loom-admin-${AZURE_LOCATION}"\n$1',
  );
  assert.notEqual(mutant, before, 'the unrelated-use mutation did not apply');

  const problems = checkSteps(mutant).filter((p) => /reads `inputs\.region`/.test(p));
  assert.equal(problems.length, 1, `expected the S8 violation to survive, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /Adopt the DLZ/);
});

test('S8 CONTROL: a step that RECONCILES the raw input against $AZURE_LOCATION is allowed', () => {
  // The pairing exemption. No step in the workflow takes this branch today, so
  // without this test the branch would be unreachable code that no measurement
  // ever exercises — a guard clause with zero population is not a guard clause.
  let mutant = stripShellRead(restoreEnvBinding(YAML));
  const before = mutant;
  mutant = mutant.replace(
    /(          INPUT_DLZ_SUBSCRIPTION=""; INPUT_DLZ_DOMAIN=""\n)/,
    '          if [ "$REGION" != "$AZURE_LOCATION" ]; then exit 1; fi\n$1',
  );
  assert.notEqual(mutant, before, 'the reconciliation mutation did not apply');
  assert.deepEqual(
    checkSteps(mutant).filter((p) => /(reads|binds) `inputs\.region`/.test(p)), [],
    'a step comparing the input against the measurement is reconciling, not trusting',
  );
});

// ---------------------------------------------------------------------------
// The pairing exemption was itself defeatable — found in review of THIS PR.
//
// `l.includes(v)` is a SUBSTRING test, so the exemption fired on names that
// merely occur inside `AZURE_LOCATION`, and on the binding line itself. Proved
// by varying ONLY the bound variable's name on the real #3701 shape:
//
//   bound var        alone   + one ordinary `rg-…-${AZURE_LOCATION}` line
//   REGION             1       1        <- the name the first test happened to use
//   LOCATION           1       0        <- 'AZURE_LOCATION'.includes('LOCATION')
//   AZURE_LOCATION     0       0        <- the binding line self-satisfies it
//   R / A              1       0        <- any line at all
//
// Every cell must be a violation. The cases below pin the three that were not.
// ---------------------------------------------------------------------------

/** Restore the #3701 shape with the raw input bound to an arbitrary name. */
function restoreShapeBoundTo(yaml, varName) {
  assert.ok(ENV_ANCHOR.test(yaml), 'the ADMIN_SUB env anchor is gone');
  const withEnv = yaml.replace(ENV_ANCHOR, `$1          ${varName}: \${{ inputs.region }}\n`);
  assert.notEqual(withEnv, yaml, `binding ${varName} did not apply`);
  return stripShellRead(withEnv);
}

/** One ordinary resource-group interpolation — thirteen real steps have one. */
function addOrdinaryRgLine(yaml) {
  const out = yaml.replace(
    /(          INPUT_DLZ_SUBSCRIPTION=""; INPUT_DLZ_DOMAIN=""\n)/,
    '          DIAG_RG="rg-csa-loom-admin-${AZURE_LOCATION}"\n$1',
  );
  assert.notEqual(out, yaml, 'the ordinary-RG-line mutation did not apply');
  return out;
}

const s8Violations = (yaml) => checkSteps(yaml).filter((p) => /(reads|binds) `inputs\.region`/.test(p));

test('S8 MUTANT: the pairing exemption is not satisfied by a SUBSTRING of the measurement var', () => {
  for (const varName of ['LOCATION', 'R', 'A', 'REGION', 'INPUT_REGION']) {
    for (const [label, yaml] of [
      ['alone', restoreShapeBoundTo(YAML, varName)],
      ['+ ordinary RG line', addOrdinaryRgLine(restoreShapeBoundTo(YAML, varName))],
    ]) {
      const problems = s8Violations(yaml);
      assert.equal(problems.length, 1,
        `bound var ${varName} (${label}): expected exactly 1 S8 violation, got ${problems.length} — ` +
        `${problems.join(' | ') || 'the guard was SILENT on the #3701 shape'}`);
      assert.match(problems[0], /Adopt the DLZ/);
    }
  }
});

test('S8 MUTANT: binding the input to AZURE_LOCATION itself is a violation on its own', () => {
  // The worst case, and the one neither "exclude the binding line" nor "require
  // a shell reference" catches: when the bound name IS the measurement token,
  // every ordinary `${AZURE_LOCATION}` reads as a reference to it. It is also
  // unconditionally unsafe — a step-level `env:` entry OVERRIDES what
  // `Resolve reconcile target` wrote to $GITHUB_ENV, for that step, so the whole
  // body silently sees the empty input. Caught by name, before pairing.
  const mutant = restoreShapeBoundTo(YAML, 'AZURE_LOCATION');
  const problems = s8Violations(mutant);
  assert.equal(problems.length, 1, `expected the shadowing violation, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /SHADOWS the measured region/);
  assert.match(problems[0], /Adopt the DLZ/);

  // …and it must NOT be redeemable by adding a line that looks like pairing.
  const withPairing = addOrdinaryRgLine(mutant);
  assert.equal(s8Violations(withPairing).length, 1,
    'an ordinary ${AZURE_LOCATION} line must not redeem a step that shadows the measurement');
});

test('S8 CONTROL: shadowing is judged on the BOUND name, not on mentioning AZURE_LOCATION', () => {
  // The real workflow mentions AZURE_LOCATION in thirteen steps and binds it in
  // none. If this fired on a mention, the guard would be unusable.
  assert.deepEqual(s8Violations(YAML), []);
});

// ---------------------------------------------------------------------------
// Third round — CO-OCCURRENCE IS NOT RECONCILIATION.
//
// Requiring the measurement and the bound name on one line still exempted a
// step that merely USED both, and with two bindings, reconciling either one
// exempted the step for both. A reconciliation is a COMPARISON.
// ---------------------------------------------------------------------------

/** Restore the #3701 shape with arbitrary `env:` lines and one extra body line. */
function restoreShapeWith(envLines, bodyLine) {
  assert.ok(ENV_ANCHOR.test(YAML), 'the ADMIN_SUB env anchor is gone');
  const withEnv = YAML.replace(ENV_ANCHOR, `$1${envLines}`);
  assert.notEqual(withEnv, YAML, 'the env mutation did not apply');
  let out = stripShellRead(withEnv);
  if (bodyLine) {
    const before = out;
    out = out.replace(
      /(          INPUT_DLZ_SUBSCRIPTION=""; INPUT_DLZ_DOMAIN=""\n)/,
      `          ${bodyLine}\n$1`,
    );
    assert.notEqual(out, before, 'the body mutation did not apply');
  }
  return out;
}

const BIND_REGION = '          REGION: ${{ inputs.region }}\n';

test('S8 MUTANT: merely USING both tokens on one line is not a reconciliation', () => {
  for (const line of [
    'DIAG="${AZURE_LOCATION}/${REGION}"',
    'DIAG="${AZURE_LOCATION}${REGION:-x}"',
    'echo_target="${REGION}" ; TAG="${AZURE_LOCATION}-${REGION}"',
  ]) {
    const problems = s8Violations(restoreShapeWith(BIND_REGION, line));
    assert.equal(problems.length, 1,
      `co-occurrence line \`${line}\` exempted the step: ${problems.join(' | ') || '(guard SILENT)'}`);
    assert.match(problems[0], /Adopt the DLZ/);
  }
});

test('S8 CONTROL: a genuine COMPARISON is still exempt, in both test syntaxes', () => {
  for (const line of [
    'if [ "$REGION" != "$AZURE_LOCATION" ]; then exit 1; fi',
    'if [[ "$REGION" == "$AZURE_LOCATION" ]]; then :; fi',
    'test "$REGION" = "$AZURE_LOCATION" || exit 1',
  ]) {
    assert.deepEqual(s8Violations(restoreShapeWith(BIND_REGION, line)), [],
      `a real comparison was flagged: \`${line}\``);
  }
});

test('S8 MUTANT: reconciling ONE of two bound variables does not exempt the other', () => {
  const mutant = restoreShapeWith(
    `${BIND_REGION}          OTHER: \${{ inputs.region }}\n`,
    'if [ "$REGION" != "$AZURE_LOCATION" ]; then exit 1; fi',
  );
  const problems = s8Violations(mutant);
  assert.equal(problems.length, 1,
    `the unreconciled second binding was exempted: ${problems.join(' | ') || '(guard SILENT)'}`);
});

test('S8 MUTANT: a trailing COMMENT on the binding line cannot fake a pairing', () => {
  // This is what the binding-line exclusion blocks. Without that clause the
  // whole suite still passed, so the clause was load-bearing AND untested —
  // exactly the shape that gets deleted later as redundant.
  const mutant = restoreShapeWith(
    '          REGION: ${{ inputs.region }} # reconciled against ${AZURE_LOCATION} via [ "$REGION" != x ]\n',
    null,
  );
  const problems = s8Violations(mutant);
  assert.equal(problems.length, 1,
    `a comment on the binding line satisfied the exemption: ${problems.join(' | ') || '(guard SILENT)'}`);
  assert.match(problems[0], /Adopt the DLZ/);
});

test('S8 MUTANT: a COMPARISON that never references the bound variable does not exempt it', () => {
  // Pins the shell-REFERENCE clause on its own. Adding the comparison
  // requirement made the earlier substring cases fail for a different reason,
  // so reverting `new RegExp('\\$\\{?VAR\\b')` back to `l.includes(v)` stopped
  // failing anything — two overlapping controls hiding each other's absence.
  // Redundancy is not defence in depth unless each layer is pinned separately.
  //
  // Here the bound name `LOCATION` is a SUBSTRING of `AZURE_LOCATION`, and the
  // line is a genuine comparison — but it compares the measurement against a
  // literal and never mentions `$LOCATION`. Substring matching exempts it;
  // reference matching does not.
  const mutant = restoreShapeWith(
    '          LOCATION: ${{ inputs.region }}\n',
    'if [ "$AZURE_LOCATION" != "eastus2" ]; then :; fi',
  );
  const problems = s8Violations(mutant);
  assert.equal(problems.length, 1,
    `a comparison not naming the bound variable exempted the step: ${problems.join(' | ') || '(guard SILENT)'}`);
  assert.match(problems[0], /Adopt the DLZ/);
});

test('S8 CONTROL: the env-binding extraction has a floor — it cannot silently stop matching', () => {
  // If ENV_BINDS_REGION_INPUT stopped matching, `boundVars` would be empty
  // everywhere, the pairing exemption would be unreachable, and S8 would narrow
  // to the two strong markers while still reporting a clean run.
  //
  // The mutation gives the binding a fallback — the #3029 shape — which is still
  // a binding of the raw input but is NOT a shape this guard has reasoned about.
  // `inputs.region` is left textually intact so the reader-count floors above do
  // not fire first and mask this one.
  const mutant = YAML.replace(
    /INPUT_REGION: \$\{\{ inputs\.region \}\}/g,
    "INPUT_REGION: ${{ inputs.region || '' }}",
  );
  assert.notEqual(mutant, YAML, 'the mutation did not apply');
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /DISCOVERY FLOOR:.*ENV_BINDS_REGION_INPUT/.test(p)),
    `expected the env-binding floor to fire, got: ${problems.join(' | ')}`,
  );
  // …and it must be THIS floor, not the reader-count ones firing by accident.
  assert.ok(
    !problems.some((p) => /no step reads `inputs\.region` at all/.test(p)),
    'the reader floor fired too — the mutation is too broad to isolate the extraction',
  );
});

test('S8 CONTROL: the guard FAILS on the pre-fix workflow and PASSES on the fixed one', () => {
  // The strongest available control — the defect as it actually existed in git,
  // not a hand-written imitation of it.
  const preFix = execFileSync('git', ['show', 'HEAD:.github/workflows/deploy-fiab-commercial.yml'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');

  // `(?:[^\n]*\n)*?` — NOT `(?:.*\n)?`. The earlier form spanned at most ONE
  // line while the real pre-fix file has SIX between `env:` and `REGION:` (five
  // comment lines and `ADMIN_SUB:`), so the `if` never fired and this control
  // asserted nothing at all. Measured on the file, not reasoned about.
  const PRE_FIX_SHAPE = /id: dlz_adopt\n\s+env:\n(?:[^\n]*\n)*?\s+REGION: \$\{\{ inputs\.region \}\}/;
  const s8 = (y) => checkSteps(y).filter((p) => /reads `inputs\.region`/.test(p));

  if (PRE_FIX_SHAPE.test(preFix)) {
    // HEAD still predates the fix: the real defect must produce the real violation.
    const before = s8(preFix);
    assert.equal(before.length, 1, 'the pre-fix workflow must produce exactly one S8 violation');
    assert.match(before[0], /Adopt the DLZ/);
  } else {
    // Once merged, the fixed file IS HEAD. Assert THAT rather than falling
    // silent — a control whose only branch is conditional is a control that
    // stops watching the moment its condition lapses.
    assert.deepEqual(s8(preFix), [], 'HEAD no longer carries the #3701 shape, so it must be clean');
    assert.ok(
      /REGION="\$\{AZURE_LOCATION:-\}"/.test(preFix),
      'HEAD has neither the defect nor the fix — the adopt step changed shape and this control is stale',
    );
  }
  assert.deepEqual(s8(YAML), []);
});

test('S8 CONTROL: the two legitimate readers still read the input', () => {
  // Two steps legitimately read `inputs.region`: the one that runs
  // reconcile-resolve.mjs (it produces the measurement) and the input-safety
  // gate (it is passed steps.reconcile.outputs.region and refuses on a
  // mismatch, #3029). A guard that flagged those would be switched off.
  const steps = parseWorkflowSteps(YAML);
  const code = (s) => s.body.filter((l) => !/^\s*#/.test(l)).join('\n');
  const readers = steps.filter((s) => /\binputs\.region\b/.test(code(s)));
  assert.ok(readers.length >= 2, `expected >= 2 legitimate readers, found ${readers.length}`);
  assert.ok(
    readers.some((s) => code(s).includes('scripts/ci/reconcile-resolve.mjs')),
    'the step that MEASURES the region must still read the input',
  );
  assert.ok(
    readers.some((s) => code(s).includes('steps.reconcile.outputs.region')),
    'the input-safety gate must still receive the resolved region to compare against',
  );
});

test('S8 CONTROL: the guard fails closed when nothing reads the region at all', () => {
  const mutant = YAML.replace(/inputs\.region/g, 'inputs.regionRenamed');
  const problems = checkSteps(mutant);
  assert.ok(
    problems.some((p) => /DISCOVERY FLOOR: no step reads `inputs\.region`/.test(p)),
    `expected the S8 discovery floor to fire, got: ${problems.join(' | ')}`,
  );
});

test('S8 CONTROL: a step merely MENTIONING inputs.region in a comment is not a use', () => {
  // The fix's own explanation names the input, and a step's body absorbs the
  // comment block introducing the NEXT step. If comments counted, the fixed
  // workflow itself would fail — so this is proved against the real file.
  const mutant = YAML.replace(
    /(      - name: Setup Bicep\n)/,
    '      # prose that names inputs.region without using it\n$1',
  );
  assert.notEqual(mutant, YAML, 'the mutation did not apply');
  assert.deepEqual(checkSteps(mutant).filter((p) => /reads `inputs\.region`/.test(p)), []);
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
