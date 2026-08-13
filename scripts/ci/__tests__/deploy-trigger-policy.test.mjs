/**
 * deploy-trigger-policy tests (refs #2775).
 *
 * The bug these pin: deploy-fiab-commercial.yml decided a TRIGGER question by
 * reading an INPUT. On a `schedule` event there are no inputs, so
 * `inputs.allow_existing_hub` was "", `"" != "true"` was always true, and the
 * nightly reconcile refused itself against the very hub it was scheduled to
 * reconcile -- every night, for as long as the schedule has existed.
 *
 * So the four states below are pinned INDEPENDENTLY. Widening the guard to
 * "pass more often" (the tempting fix -- just delete the guard) turns the
 * dispatch tests RED; narrowing it back turns the schedule test RED.
 *
 * MUTATION-PROVEN (measured 2026-08-03, 22 tests, 22 pass / 0 skip at baseline):
 *
 *   A. drop the allow_existing_hub requirement (guard permissive for dispatch)
 *        -> 2 RED: "dispatch + existing hub + no flag -> REFUSES",
 *                  "empty topology defaults to tenant, and keeps the tenant guard"
 *   B. collapse UNKNOWN into 0, exactly as the old `|| echo "0"` bash did
 *        -> 2 RED: "dispatch + UNKNOWN hub count -> REFUSES",
 *                  "schedule + UNKNOWN hub count -> proceeds, and says so"
 *   C. flip the scheduled deployAppsEnabled default to 'true' (the outage-shaped
 *      change) -> 2 RED: the divergence test and the image-tag tripwire.
 *
 * Both CONTROL tests at the bottom stayed GREEN under all three, and the file
 * restored byte-identical to green afterwards -- so a change that merely widens
 * a pass branch cannot hide behind them, and the controls are not themselves
 * just re-asserting the mutated logic.
 *
 * Run: node --test scripts/ci/__tests__/deploy-trigger-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveTopologyGuard,
  resolveFeatureFlags,
  parseHubCount,
  SCHEDULE_FLAG_DEFAULTS,
  DISPATCH_FLAG_DEFAULTS,
  FLAG_DEFAULT_DIVERGENCES,
  FLAG_INPUT_NAMES,
} from '../deploy-trigger-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '..', '..', '.github', 'workflows', 'deploy-fiab-commercial.yml');

/** Workflow source with CRLF normalised — the file is checked out CRLF on Windows. */
const readWorkflow = () => readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

/**
 * Workflow source with whole-line YAML comments removed.
 *
 * The regression tests below look for the SHAPE of the old bug, and the fix
 * documents that shape in a comment on purpose. Matching raw text would make the
 * documentation trip its own regression test -- the same "a guard that counts
 * comments" trap called out in this repo's ratchet notes. Only executable YAML
 * is searched.
 */
const readWorkflowCode = () =>
  readWorkflow().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// ---------------------------------------------------------------------------
// THE FOUR STATES the guard has to keep apart
// ---------------------------------------------------------------------------

test('schedule + existing hub -> PROCEEDS (this is the bug that broke the nightly reconcile)', () => {
  const r = resolveTopologyGuard({
    eventName: 'schedule',
    topology: 'tenant',
    // On a schedule there are no inputs at all. Both spellings of "absent"
    // must proceed, because that absence is exactly what used to refuse.
    allowExistingHub: '',
    existingHubCount: 1,
  });
  assert.equal(r.decision, 'proceed');
  assert.match(r.reason, /scheduled reconcile/i);
});

test('schedule + existing hub + allowExistingHub undefined -> still PROCEEDS', () => {
  const r = resolveTopologyGuard({ eventName: 'schedule', topology: 'tenant', existingHubCount: 3 });
  assert.equal(r.decision, 'proceed');
});

test('dispatch + existing hub + no flag -> REFUSES (the guard keeps its teeth)', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: 'tenant',
    allowExistingHub: false,
    existingHubCount: 1,
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /already exists/i);
  assert.match(r.reason, /second Console cannot be stamped/i);
});

test('dispatch + existing hub + allow_existing_hub=true -> proceeds', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: 'tenant',
    allowExistingHub: true,
    existingHubCount: 1,
  });
  assert.equal(r.decision, 'proceed');
  assert.match(r.warning, /no second Console/i);
});

test('dispatch + existing hub + allow_existing_hub="true" (string) -> proceeds', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: 'tenant',
    allowExistingHub: 'true',
    existingHubCount: 1,
  });
  assert.equal(r.decision, 'proceed');
});

test('no existing hub -> proceeds on either trigger', () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const r = resolveTopologyGuard({ eventName, topology: 'tenant', existingHubCount: 0 });
    assert.equal(r.decision, 'proceed', `${eventName} should proceed on a fresh sub`);
    assert.match(r.reason, /no existing hub/i);
  }
});

// ---------------------------------------------------------------------------
// UNKNOWN is not zero -- the old bash collapsed these with `|| echo "0"`
// ---------------------------------------------------------------------------

test('dispatch + UNKNOWN hub count -> REFUSES (fail closed, was permissive)', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: 'tenant',
    allowExistingHub: false,
    existingHubCount: null,
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /UNKNOWN, not absent/);
});

test('schedule + UNKNOWN hub count -> proceeds, and says so', () => {
  const r = resolveTopologyGuard({ eventName: 'schedule', topology: 'tenant', existingHubCount: null });
  assert.equal(r.decision, 'proceed');
  assert.match(r.warning, /query failed/i);
});

test('parseHubCount keeps UNKNOWN distinct from 0', () => {
  assert.equal(parseHubCount('0'), 0);
  assert.equal(parseHubCount('2\n'), 2);
  // Everything az leaves behind on failure is UNKNOWN, never 0.
  for (const bad of ['', '   ', undefined, null, 'ERROR: auth failed', '-1', 'null', '1.5']) {
    assert.equal(parseHubCount(bad), null, `${JSON.stringify(bad)} must be UNKNOWN`);
  }
});

// ---------------------------------------------------------------------------
// dlz-attach is unaffected by the trigger change
// ---------------------------------------------------------------------------

test('dlz-attach without target_subscription -> refuses', () => {
  const r = resolveTopologyGuard({ eventName: 'workflow_dispatch', topology: 'dlz-attach' });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /requires target_subscription/);
});

test('dlz-attach with target_subscription -> proceeds against THAT sub', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: 'dlz-attach',
    targetSubscription: 'sub-abc',
    subscriptionOverride: 'hub-sub',
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(r.deploySub, 'sub-abc');
});

test('empty topology defaults to tenant, and keeps the tenant guard', () => {
  const r = resolveTopologyGuard({
    eventName: 'workflow_dispatch',
    topology: '',
    allowExistingHub: false,
    existingHubCount: 1,
  });
  assert.equal(r.decision, 'refuse');
});

// ---------------------------------------------------------------------------
// FEATURE FLAGS -- the second defect in the same file
// ---------------------------------------------------------------------------

test('schedule (no inputs) yields real bools, never the empty string', () => {
  const { flags, source } = resolveFeatureFlags({ eventName: 'schedule', inputs: {} });
  assert.equal(source, 'schedule-defaults');
  for (const [param, value] of Object.entries(flags)) {
    assert.ok(value === 'true' || value === 'false', `${param} must be a bicep bool, got "${value}"`);
  }
  assert.deepEqual(flags, { ...SCHEDULE_FLAG_DEFAULTS });
});

test('an explicit false input is NOT flipped to the default', () => {
  // The obvious one-liner fix (`inputs.purview_enabled || 'true'`) has exactly
  // this bug: GitHub expressions treat `false` as falsy, so an operator's
  // deliberate false silently becomes true. Pin it.
  const { flags } = resolveFeatureFlags({
    eventName: 'workflow_dispatch',
    inputs: { purview_enabled: false, azure_maps_enabled: 'false' },
  });
  assert.equal(flags.purviewEnabled, 'false');
  assert.equal(flags.azureMapsEnabled, 'false');
});

test('an explicit true input is preserved', () => {
  const { flags } = resolveFeatureFlags({
    eventName: 'workflow_dispatch',
    inputs: { deploy_apps_enabled: true, front_door_enabled: 'true' },
  });
  assert.equal(flags.deployAppsEnabled, 'true');
  assert.equal(flags.frontDoorEnabled, 'true');
});

test('a non-bool input is a hard error, not something az gets handed', () => {
  assert.throws(
    () => resolveFeatureFlags({ eventName: 'workflow_dispatch', inputs: { purview_enabled: 'yes' } }),
    /not a bicep bool/,
  );
});

test('scheduled reconcile still STARTS deployAppsEnabled at FALSE (fail-safe base)', () => {
  // appImageTags.console defaults to 'v0.1' in both main.bicep files, while
  // production runs a commit-SHA tag, so a nightly job that simply set
  // deployAppsEnabled=true would rewrite the Console image to a tag that does
  // not exist.
  //
  // refs #2775 closed that gap, but NOT by flipping this default. The value
  // resolved here stays the safe 'false' and is the BASE that
  // scripts/ci/reconcile-policy.mjs `decideDeployApps` may upgrade to 'true' --
  // and only after `az containerapp list` has positively identified the tag
  // every running image is on, so the ARM PUT is a no-op for the image. Default
  // deny, upgrade on evidence.
  //
  // So this tripwire is still exactly right: flipping the default HERE would
  // hand ARM an unpinned 'true' on any path that skips the resolver. The
  // upgrade must stay in the step that does the measuring.
  const { flags } = resolveFeatureFlags({ eventName: 'schedule', inputs: {} });
  assert.equal(flags.deployAppsEnabled, 'false');
});

// ---------------------------------------------------------------------------
// DRIFT -- the dispatch table must equal the workflow's own defaults, and the
// schedule table may diverge from it only where that is written down
// ---------------------------------------------------------------------------

test('DISPATCH_FLAG_DEFAULTS match the workflow_dispatch defaults in the YAML', () => {
  const yaml = readWorkflow();
  for (const [param, inputName] of Object.entries(FLAG_INPUT_NAMES)) {
    // Match the input's own block: `  <name>:` then its `default:` before the
    // next input at the same indent.
    const block = new RegExp(`\\n      ${inputName}:\\n([\\s\\S]*?)(?=\\n      \\w|\\n\\w)`).exec(yaml);
    assert.ok(block, `input ${inputName} not found in ${WORKFLOW}`);
    const def = /^\s*default:\s*(\S+)\s*$/m.exec(block[1]);
    assert.ok(def, `input ${inputName} has no default: in the workflow`);
    assert.equal(
      def[1], DISPATCH_FLAG_DEFAULTS[param],
      `${inputName} default drifted: workflow says ${def[1]}, DISPATCH_FLAG_DEFAULTS says ${DISPATCH_FLAG_DEFAULTS[param]}`,
    );
  }
});

test('the schedule and dispatch tables diverge on EXACTLY the documented keys', () => {
  // #3332 gave `deploy_apps_enabled` a dispatch default of true while leaving
  // the schedule base false. Two tables where there was one is how a deliberate
  // decision decays into drift, so the divergence is enumerated and asserted in
  // BOTH directions:
  //   - a SEVENTH flag quietly diverging fails here (it is not in the list);
  //   - this one quietly CONVERGING fails here too (it is in the list but the
  //     values now match), which is the outage-shaped change: a schedule that
  //     starts at true hands ARM an unpinned flag on any path that skips the
  //     resolver.
  const diverged = Object.keys(FLAG_INPUT_NAMES)
    .filter((param) => SCHEDULE_FLAG_DEFAULTS[param] !== DISPATCH_FLAG_DEFAULTS[param])
    .sort();
  assert.deepEqual(
    diverged, Object.keys(FLAG_DEFAULT_DIVERGENCES).sort(),
    'the set of flags whose schedule default differs from their dispatch default changed. ' +
    'Every divergence must be listed in FLAG_DEFAULT_DIVERGENCES with its reason.',
  );
  for (const [param, why] of Object.entries(FLAG_DEFAULT_DIVERGENCES)) {
    assert.ok(String(why).trim().length > 40, `FLAG_DEFAULT_DIVERGENCES.${param} needs a real reason`);
  }
});

test('a dispatch that supplies NO apps flag still deploys the apps (#3332)', () => {
  // The bug: `deploy_apps_enabled` defaulted false, so an operator selecting
  // run_mode=full and changing nothing else got `deployAppsEnabled=false`,
  // app-deployments.bicep was skipped, and the run went green having created or
  // updated ZERO Container Apps and applied ZERO LOOM_* env vars.
  //
  // GitHub always materialises a declared boolean input on a workflow_dispatch,
  // so the value seen here is the input's `default:` -- which the YAML-drift
  // test above pins to DISPATCH_FLAG_DEFAULTS.
  const { flags } = resolveFeatureFlags({
    eventName: 'workflow_dispatch',
    inputs: { deploy_apps_enabled: DISPATCH_FLAG_DEFAULTS.deployAppsEnabled },
  });
  assert.equal(flags.deployAppsEnabled, 'true');
});

test('the workflow no longer decides the trigger question from an input', () => {
  const code = readWorkflowCode();
  // The exact shape of the bug: comparing inputs.allow_existing_hub inside a
  // shell test. If it comes back, this fails.
  assert.doesNotMatch(
    code, /\[\s*"\$\{\{\s*inputs\.allow_existing_hub\s*\}\}"\s*!=\s*"true"\s*\]/,
    'the inline guard that refused every scheduled run is back in the workflow',
  );
  // And the flags must not be interpolated raw into the az command line, which
  // is what produced `purviewEnabled=` on the schedule path.
  assert.doesNotMatch(
    code, /purviewEnabled=\$\{\{\s*inputs\.purview_enabled\s*\}\}/,
    'raw input interpolation is back -- a scheduled run would pass purviewEnabled=',
  );
  // The resolved values must actually be consumed by the az invocations.
  //
  // The SHAPE changed with #3022. The what-if and the apply used to restate the
  // whole argument list, so this asserted "the resolved flag appears twice".
  // They now expand ONE composed argument file, so the flag is bound ONCE — in
  // the composition step's `env:` — and both commands necessarily see the same
  // value. That is the stronger property: there is no second copy to drift.
  // check-deploy-input-safety.mjs (S5) enforces the one-composition/two-consumers
  // half; this asserts the binding is still the RESOLVED value, not a raw input.
  assert.match(
    code, /PURVIEW_ENABLED:\s*\$\{\{\s*steps\.topology_guard\.outputs\.purview_enabled\s*\}\}/,
    'the composition step must take purviewEnabled from the resolved topology-guard output',
  );
  assert.match(
    code, /--parameters "purviewEnabled=\$PURVIEW_ENABLED"/,
    'the composition step must emit purviewEnabled from that resolved value',
  );
  const consumers = code.match(/az deployment sub (?:what-if|create) "\$\{DEPLOY_ARGS\[@\]\}"/g) || [];
  assert.equal(
    consumers.length, 2,
    'both the what-if and the provision step must expand the ONE composed argument list',
  );
});

test('the guard step invokes the tested script rather than inline shell', () => {
  const code = readWorkflowCode();
  assert.match(code, /run:\s*node scripts\/ci\/deploy-fiab-guard\.mjs/);
});

// ---------------------------------------------------------------------------
// CONTROLS -- these must stay GREEN under the mutations described in the header.
// They assert shape, not permissiveness, so they cannot absorb a widened branch.
// ---------------------------------------------------------------------------

test('CONTROL: every verdict has a decision and a non-empty reason', () => {
  const cases = [
    { eventName: 'schedule', topology: 'tenant', existingHubCount: 1 },
    { eventName: 'workflow_dispatch', topology: 'tenant', existingHubCount: 1 },
    { eventName: 'workflow_dispatch', topology: 'tenant', existingHubCount: 0 },
    { eventName: 'workflow_dispatch', topology: 'dlz-attach', targetSubscription: 's' },
  ];
  for (const c of cases) {
    const r = resolveTopologyGuard(c);
    assert.ok(['proceed', 'refuse'].includes(r.decision));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10);
  }
});

test('CONTROL: flag resolution always returns all six params', () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const { flags } = resolveFeatureFlags({ eventName, inputs: {} });
    assert.equal(Object.keys(flags).length, 6);
    for (const param of Object.keys(FLAG_INPUT_NAMES)) {
      assert.ok(param in flags, `${param} missing`);
    }
  }
});
