// Behaviour tests for LAYER 5 of scripts/ci/check-env-sync.mjs — the BYO
// env-var bridge every boundary's .bicepparam must carry (#3446) — and for the
// three ways #3956 measured that layer could be evaded WITHOUT tripping it.
//
// WHY THIS SUITE EXISTS
// ---------------------
// #3956 is not a report of a shipped defect. Layer 5's functional fix is correct
// on all 7 boundaries. It is a report that the layer's own TEETH could be
// removed by a future change while the guard stayed at RC=0, and all three were
// re-measured at 5f1ee0d1 before anything here was written:
//
//   N-1  POPULATION SHRINK. collectAdoptParamsFiles() filters on
//        /^param\s+adopt\s*=/m. Indenting that declaration by ONE SPACE in
//        platform/fiab/bicep/params/il5.bicepparam took the population 7 -> 6
//        and the guard exited RC=0. main() asserted only `bridgeFiles === 0`, so
//        7 -> 1 also passed. A sovereign boundary left the examined set and the
//        only trace was a printed number nothing compared against anything.
//
//   N-2  PRESENT BUT UNREACHABLE. The role assertion was
//        `decl.includes("readEnvironmentVariable('<SPELLING>'")` — a SUBSTRING
//        test. Transposing the two branches of il5's `mapsAdoptSub` ternary,
//        so the legacy spelling is selected only when the canonical one is
//        already set, keeps BOTH names present and exited RC=0 — while an IL5
//        operator who sets only EXISTING_MAPS_SUB is silently ignored. That is
//        #3446's defect verbatim, restored by transposition.
//
//   N-3  A STRUCTURALLY DEAD ASSERTION. The Console-param check sat behind
//        `if (declaration found)`. Measured: `adopt=true` on 7 files,
//        `param loomAzureMapsAccount =` present on 2. Deleting that line from
//        gcc.bicepparam exited RC=0 — the "fix" for a missing declaration was to
//        delete the declaration.
//
// Every test below is written so that REVERTING its guard makes it fail. The
// mutation receipt in the PR body records that, per guard, measured.
//
// Run: node --test scripts/ci/__tests__/env-sync-bridge-reachability.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  TRIAGED_INERT_BINDINGS,
  PARAMS_ENV_BRIDGES,
  EXPECTED_ADOPT_PARAMS_FILES,
  collectAdoptParamsFiles,
  collectAdoptParamsFilesFrom,
  collectAllParamsFiles,
  checkAdoptPopulation,
  checkOneBridge,
  checkPreferenceChain,
  checkBridgeOrchestratorArgs,
  checkAllowedInvariant,
  parsePreferenceChain,
  readAllowedValues,
  computeParamsEnvBridges,
  runParamsBridgeControl,
  runTriagedBindingControl,
  computeTriagedBindings,
  collectAdminPlaneArgs,
} from '../check-env-sync.mjs';

const MAPS = PARAMS_ENV_BRIDGES.find((b) => b.id === 'maps');

/** The shape all 7 params files carry today. */
const GOOD = `using '../main.bicep'
var mapsAdoptName = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')
  : (!empty(readEnvironmentVariable('EXISTING_AZURE_MAPS', ''))
      ? readEnvironmentVariable('EXISTING_AZURE_MAPS', '')
      : readEnvironmentVariable('EXISTING_MAPS', ''))
var mapsAdoptRg = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', '')
  : readEnvironmentVariable('EXISTING_MAPS_RG', '')
var mapsAdoptSub = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')
  : readEnvironmentVariable('EXISTING_MAPS_SUB', '')
var legacyAdoptFromEnv = union(
  empty(mapsAdoptName) ? {} : { maps: { mode: 'adopt', target: { name: mapsAdoptName, rg: mapsAdoptRg, sub: mapsAdoptSub } } }
)
param adopt = legacyAdoptFromEnv
param loomAzureMapsAccount = mapsAdoptName
`;

/** The bridge spec re-pointed at the fixture filename. */
const SPEC = { ...MAPS, consoleParamFiles: ['fixture.bicepparam'] };
const run = (src) => checkOneBridge('fixture.bicepparam', src, SPEC);

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────────
// Without this, every test below would still pass on a checker that flags
// EVERYTHING — the cheapest way to fake teeth.

test('POSITIVE CONTROL: the shape the tree actually carries is clean', () => {
  assert.deepEqual(run(GOOD), []);
});

test('POSITIVE CONTROL: the real tree passes layer 5 end to end', () => {
  const { failures, files } = computeParamsEnvBridges();
  assert.deepEqual(failures, []);
  assert.equal(files, EXPECTED_ADOPT_PARAMS_FILES.length);
});

test('POSITIVE CONTROL: the embedded layer-4/5 controls hold', () => {
  assert.deepEqual(runParamsBridgeControl(), []);
  assert.deepEqual(runTriagedBindingControl(), []);
});

// ── N-1: the derived population may not shrink silently ──────────────────────

test('N-1 the ONE-SPACE indent that removed IL5 from the population is caught', () => {
  // The mutation verbatim: `param adopt =` -> ` param adopt =`. The file is
  // untouched otherwise and still on disk.
  const candidates = [
    { file: 'commercial.bicepparam', src: "using '../main.bicep'\nparam adopt = {}\n" },
    { file: 'il5.bicepparam', src: "using '../main.bicep'\n param adopt = {}\n" },
  ];
  const kept = collectAdoptParamsFilesFrom(candidates).map((f) => f.file);
  assert.deepEqual(kept, ['commercial.bicepparam'], 'the indent must drop the file from the population');

  const failures = checkAdoptPopulation(kept, candidates.map((c) => c.file), [
    'commercial.bicepparam',
    'il5.bicepparam',
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /il5\.bicepparam still exists but NO LONGER matches/);
});

test('N-1 a population at its floor is clean, and 7 -> 1 is not', () => {
  const all = [...EXPECTED_ADOPT_PARAMS_FILES];
  assert.deepEqual(checkAdoptPopulation(all, all), []);
  // The shape main()'s old `bridgeFiles === 0` check let through.
  const collapsed = checkAdoptPopulation([all[0]], all);
  assert.equal(collapsed.length, all.length - 1);
});

test('N-1 a DELETED params file gets a different diagnosis than an unmatched one (R7)', () => {
  // deploy-integrity R7: the message must not assert a cause it did not
  // establish. "still exists but no longer matches" and "is gone" are different
  // facts and send a reader to different files.
  const gone = checkAdoptPopulation(['a.bicepparam'], ['a.bicepparam'], ['a.bicepparam', 'b.bicepparam']);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /b\.bicepparam is gone from/);
  assert.doesNotMatch(gone[0], /still exists/);
});

test('N-1 the floor is the LIVE set of boundary params files, not a stale list', () => {
  // A floor that drifts away from the tree is a floor nobody is standing on.
  const onDisk = new Set(collectAllParamsFiles());
  for (const f of EXPECTED_ADOPT_PARAMS_FILES) {
    assert.ok(onDisk.has(f), `${f} is in the floor but not in platform/fiab/bicep/params/`);
  }
  const observed = collectAdoptParamsFiles().map((f) => f.file).sort();
  assert.deepEqual(observed, [...EXPECTED_ADOPT_PARAMS_FILES].sort());
});

// ── N-2: presence is not reachability ────────────────────────────────────────

test('N-2 the TRANSPOSED ternary is caught even though both spellings are present', () => {
  const mutated = GOOD.replace(
    `var mapsAdoptSub = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')
  : readEnvironmentVariable('EXISTING_MAPS_SUB', '')`,
    `var mapsAdoptSub = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? readEnvironmentVariable('EXISTING_MAPS_SUB', '')
  : readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')`,
  );
  // The pre-fix substring test would find BOTH spellings and pass.
  for (const s of MAPS.roles.sub) {
    assert.ok(mutated.includes(`readEnvironmentVariable('${s}'`), `${s} is still textually present`);
  }
  const failures = run(mutated);
  assert.ok(failures.length > 0, 'the transposition must be reported');
  assert.ok(
    failures.some((f) => /tests `!empty\(EXISTING_AZURE_MAPS_SUB\)` but then selects `EXISTING_MAPS_SUB`/.test(f)),
    `expected a guard/consequent mismatch, got: ${failures.join(' | ')}`,
  );
});

test('N-2 an INVERTED preference order is caught (the legacy spelling must not win)', () => {
  const mutated = GOOD.replace(
    `var mapsAdoptRg = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', '')
  : readEnvironmentVariable('EXISTING_MAPS_RG', '')`,
    `var mapsAdoptRg = !empty(readEnvironmentVariable('EXISTING_MAPS_RG', ''))
  ? readEnvironmentVariable('EXISTING_MAPS_RG', '')
  : readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', '')`,
  );
  const failures = run(mutated);
  assert.ok(failures.length > 0);
  assert.ok(
    failures.some((f) => /reads `EXISTING_MAPS_RG` first, expected the canonical spelling/.test(f)),
    `expected a preference-order failure, got: ${failures.join(' | ')}`,
  );
});

test('N-2 an outright DELETED spelling is still caught (the pre-existing tooth survives)', () => {
  const mutated = GOOD.replace(
    "  : readEnvironmentVariable('EXISTING_MAPS_SUB', '')",
    "  : readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')",
  );
  assert.ok(run(mutated).some((f) => /never reads `EXISTING_MAPS_SUB`/.test(f)));
});

test('N-2 the LEGACY spelling must sit in the terminal branch, not merely appear', () => {
  // Every other tooth passes here: the canonical spelling is still first, every
  // guard still selects the name it tests, and the arity is right. Only the
  // POSITION changed — the second- and third-priority spellings swapped, so
  // EXISTING_MAPS now outranks EXISTING_AZURE_MAPS. This is the arm that pins
  // rule 4; without it the tail rule is decoration.
  const out = checkPreferenceChain(
    'f [maps]',
    'name',
    'v',
    `= !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')
  : (!empty(readEnvironmentVariable('EXISTING_MAPS', ''))
      ? readEnvironmentVariable('EXISTING_MAPS', '')
      : readEnvironmentVariable('EXISTING_AZURE_MAPS', ''))`,
    MAPS.roles.name,
    '#3446',
  );
  assert.ok(
    out.some((f) => /ends on `EXISTING_AZURE_MAPS`, expected the legacy spelling `EXISTING_MAPS`/.test(f)),
    `expected a terminal-branch failure, got: ${out.join(' | ')}`,
  );
});

test('N-2 a guard whose consequent is NOT a readEnvironmentVariable fails closed', () => {
  // guardCount=1 but the pair matcher reads 0 pairs, so the reachability verdict
  // would be computed over fewer branches than the file has. "I cannot read
  // this" must not render as "this is fine".
  const out = checkPreferenceChain(
    'f [maps]',
    'sub',
    'v',
    `= !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? someOtherVar
  : readEnvironmentVariable('EXISTING_MAPS_SUB', '')`,
    MAPS.roles.sub,
    '#3446',
  );
  assert.ok(
    out.some((f) => /guard\(s\) but only 0 parsed as/.test(f)),
    `expected a fail-closed parse failure, got: ${out.join(' | ')}`,
  );
});

test('N-2 a chain in an UNREADABLE shape fails closed rather than passing', () => {
  // `empty(x) ? legacy : canonical` is semantically equivalent but is not the
  // pinned shape. The checker must say it cannot read it, not shrug.
  const out = checkPreferenceChain(
    'f [maps]',
    'sub',
    'v',
    `= empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? readEnvironmentVariable('EXISTING_MAPS_SUB', '')
  : readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')`,
    MAPS.roles.sub,
    '#3446',
  );
  assert.ok(out.length > 0, 'an unreadable chain must not be silently clean');
});

test('N-2 parsePreferenceChain reports order, pairing and arity separately', () => {
  const decl = `= !empty(readEnvironmentVariable('A', '')) ? readEnvironmentVariable('A', '') : readEnvironmentVariable('B', '')`;
  const { reads, pairs, guardCount } = parsePreferenceChain(decl);
  assert.deepEqual(reads, ['A', 'A', 'B']);
  assert.deepEqual(pairs, [{ guard: 'A', selects: 'A' }]);
  assert.equal(guardCount, 1);
});

test('N-2 a spelling bolted on with no test to reach it fails the arity check', () => {
  const out = checkPreferenceChain(
    'f [maps]',
    'sub',
    'v',
    `= !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')) ? readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '') : readEnvironmentVariable('EXISTING_MAPS_SUB', '')`,
    ['EXISTING_AZURE_MAPS_SUB', 'EXISTING_OTHER_SUB', 'EXISTING_MAPS_SUB'],
    '#3446',
  );
  assert.ok(out.some((f) => /fallback test\(s\) for 3 accepted spellings, expected 2/.test(f)));
});

// ── N-3: the Console-param assertion is no longer structurally dead ──────────

test('N-3 DELETING the Console param from a file that must carry it is caught', () => {
  // The exact mutation: RC=0 before, because the assertion sat behind `if (p)`.
  const mutated = GOOD.replace('param loomAzureMapsAccount = mapsAdoptName\n', '');
  assert.ok(!mutated.includes('param loomAzureMapsAccount'));
  const failures = run(mutated);
  assert.ok(
    failures.some((f) => /`param loomAzureMapsAccount =` is GONE from this file/.test(f)),
    `expected a missing-declaration failure, got: ${failures.join(' | ')}`,
  );
});

test('N-3 a file that grows an UNCLAIMED Console param declaration is caught', () => {
  // The other half: a declaration nothing in the spec claims is a declaration
  // nothing would notice losing.
  const unclaimed = checkOneBridge('other.bicepparam', GOOD, SPEC);
  assert.ok(
    unclaimed.some((f) => /is not listed in this bridge's `consoleParamFiles`/.test(f)),
    `expected an unclaimed-declaration failure, got: ${unclaimed.join(' | ')}`,
  );
});

test('N-3 the consoleParamFiles population matches the tree it claims to describe', () => {
  const declaring = collectAdoptParamsFiles()
    .filter(({ src }) => /^param\s+loomAzureMapsAccount\s*=/m.test(src))
    .map((f) => f.file)
    .sort();
  assert.deepEqual(declaring, [...MAPS.consoleParamFiles].sort());
  // …and it is genuinely a MINORITY of boundaries, which is why asserting only
  // this path (population 2) was never enough.
  assert.ok(declaring.length < EXPECTED_ADOPT_PARAMS_FILES.length);
});

test('N-3 the ORCHESTRATOR argument — the binding with a population of 7 — is pinned by value', () => {
  assert.deepEqual(checkBridgeOrchestratorArgs(collectAdminPlaneArgs()), []);
  // Reverting to the bare param drops the adopt-map preference on ALL boundaries
  // while every name-presence check stays green.
  const reverted = new Map([[MAPS.consoleParam, MAPS.consoleParam]]);
  assert.equal(checkBridgeOrchestratorArgs(reverted).length, 1);
  // Dropping the argument entirely is the original defect.
  assert.equal(checkBridgeOrchestratorArgs(new Map()).length, 1);
});

// ── #3956 hardening: the invariant the rationale rests on ───────────────────

test('T5 readAllowedValues distinguishes a CONSTRAINED param from an unconstrained one', () => {
  const src = `@description('Cloud boundary')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string
`;
  assert.deepEqual(readAllowedValues(src, 'boundary'), ['Commercial', 'GCC', 'GCC-High', 'IL5']);
  assert.equal(readAllowedValues(src.replace(/@allowed.*\n/, ''), 'boundary'), null);
});

test('T5 a NEIGHBOURING @allowed decorator is not attributed to an unconstrained param', () => {
  const src = `@allowed(['a', 'b'])
param somethingElse string

param boundary string
`;
  assert.equal(readAllowedValues(src, 'boundary'), null);
});

test('T5 REMOVING the @allowed decorator is caught (it still compiles, so nothing else sees it)', () => {
  // The #3956 measurement: `az bicep build` RC=0, 0 BCP errors, guard RC=0. The
  // assertion is driven over synthetic source so this arm pins the CHECK, not
  // the current contents of main.bicep.
  const spec = {
    param: 'loomCloudTier',
    dependsOnAllowed: { param: 'boundary', values: ['Commercial', 'GCC', 'GCC-High', 'IL5'] },
  };
  const constrained = `@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])\nparam boundary string\n`;
  assert.deepEqual(checkAllowedInvariant('LOOM_CLOUD_TIER', spec, constrained), []);

  const stripped = `param boundary string\n`;
  const gone = checkAllowedInvariant('LOOM_CLOUD_TIER', spec, stripped);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /no longer declares `@allowed/);

  // WIDENING the union is also a regression: a value the compliance gate has
  // never seen could then reach it.
  const widened = `@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5', 'Anything'])\nparam boundary string\n`;
  const drift = checkAllowedInvariant('LOOM_CLOUD_TIER', spec, widened);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /is \["Commercial","GCC","GCC-High","IL5","Anything"\], expected/);

  // A spec with no declared dependency is silent — the check must not invent one.
  assert.deepEqual(checkAllowedInvariant('X', { param: 'p' }, stripped), []);
});

test('T5 the live tree still constrains `boundary`, and a triaged binding DEPENDS on that', () => {
  // Layer 4 is green on the real tree…
  const { failures } = computeTriagedBindings();
  assert.deepEqual(failures, []);

  // …and at least one entry pins the invariant its own rationale rests on,
  // rather than only the expression. #3956: removing the @allowed decorator from
  // main.bicep compiles cleanly and left the guard at RC=0, because the registry
  // pinned `loomCloudTier: boundary` and nothing pinned what made `boundary` safe.
  const dependents = [...TRIAGED_INERT_BINDINGS].filter(([, s]) => s.dependsOnAllowed);
  assert.ok(dependents.length > 0, 'no triaged binding declares the invariant it depends on');

  const rootSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'main.bicep'),
    'utf8',
  );
  for (const [envName, spec] of dependents) {
    const live = readAllowedValues(rootSrc, spec.dependsOnAllowed.param);
    assert.deepEqual(
      live,
      spec.dependsOnAllowed.values,
      `${envName}: the live @allowed union on \`${spec.dependsOnAllowed.param}\` drifted from the pin`,
    );
  }
});
