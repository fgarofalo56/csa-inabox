/**
 * reconcile-policy + check-reconcile-safety tests (refs #2775).
 *
 * WHAT THESE PIN
 * --------------
 * #2881 unblocked the only workflow that can apply Console configuration to the
 * live Commercial estate. Walking the rest of that path found three ways it
 * would have destroyed or duplicated production on its first success:
 *
 *   1. a SUCCESSFUL scheduled run ran fiab-teardown.sh, which deletes every
 *      `rg-csa-loom-*` RG in the subscription;
 *   2. the schedule targeted eastus2 (the `inputs.region || 'eastus2'` default)
 *      while the estate is in centralus — a second estate, not a reconcile;
 *   3. `deployAppsEnabled=true`, the flag Console env application requires,
 *      would have rewritten every image to the bicep default of v0.1 while
 *      production runs commit-SHA tags.
 *
 * Each fix is one line that a later edit could silently undo. These tests, plus
 * scripts/ci/check-reconcile-safety.mjs, are what makes that edit go red.
 *
 * MUTATION-PROVEN (measured 2026-08-03; baseline 41 tests, 41 pass / 0 fail /
 * 0 skip). Counts below are the MEASURED red counts, not predictions — the
 * first draft of this header guessed 2 for mutation A and was wrong:
 *
 *   A. restore the teardown's `github.event_name == 'schedule' ||` clause
 *      (i.e. drop the `!=` literal from its `if:`)          -> 38 pass, 3 RED
 *        "check-reconcile-safety.run() is clean on the real repo"
 *        "the real workflow: no destructive step runs on a schedule"
 *        "REGRESSION: the teardown's schedule clause has not come back"
 *   B. revert `imageTag: appImageTags.?dbtRunner ?? 'v0.1'` in
 *      admin-plane/main.bicep back to `appImageTags.console` -> 39 pass, 2 RED
 *        "check-reconcile-safety.run() is clean on the real repo"
 *        "the real bicep: no appImageTags key drives two repositories"
 *   C. replace `console: readEnvironmentVariable('LOOM_CONSOLE_TAG','v0.1')` in
 *      commercial.bicepparam with the literal `console: 'v0.1'`
 *                                                            -> 39 pass, 2 RED
 *        "check-reconcile-safety.run() is clean on the real repo"
 *        "the real bicepparam pins every tag through an env var, never a literal"
 *   D. collapse UNKNOWN into "absent" in resolveRunningImageTags (the shape the
 *      repo's own notes call "UNKNOWN reported as NEGATIVE")  -> 38 pass, 3 RED
 *        "a digest-pinned container is UNKNOWN …"
 *        "two containers on one repository at DIFFERENT tags is UNKNOWN …"
 *        "schedule + an UNKNOWN tag -> stays infra-only"
 *
 * All four CONTROL tests at the bottom stayed GREEN under every mutation (they
 * are in the pass set of all four runs), and each mutated file was restored and
 * confirmed byte-identical by md5 with the suite back at 41/41.
 *
 * ---------------------------------------------------------------------------
 * 2026-08-11 — I6 ADDED. Fix #2 above (REGION) was the ONE fix in this file
 * with no test on the line that carries it. Measured on a clean tree, baseline
 * 47 tests / 47 pass:
 *
 *   restore `AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}` in the
 *   workflow's `env:`  ->  47 pass / 47, STILL GREEN. `node
 *   scripts/ci/check-reconcile-safety.mjs` also exited 0.
 *
 * Two tests NAMED that regression and both passed with the defect present:
 * one calls resolveReconcileRegion() as a pure function (the YAML is invisible
 * to it) and the other asserted only the DOWNSTREAM override in
 * reconcile-resolve.mjs, with a comment explicitly tolerating the `env:`
 * fallback. Nothing read the seed.
 *
 * A sibling — check-deploy-input-safety.mjs S3 — did catch that exact
 * spelling, so this was a coverage hole rather than a total blind spot. Its
 * matcher is `/\|\|\s*'[a-z0-9]+'/` against the FIRST `AZURE_LOCATION:` line in
 * the file; measured against it, five other spellings of the same defect and a
 * deletion of the line all walk through (see the I6 mutant table below).
 *
 * MUTATION-PROVEN at 60 tests / 60 pass baseline. MEASURED red counts:
 *
 *   E. `AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}` on disk
 *                                                          -> 46 pass, 14 RED
 *        "check-reconcile-safety.run() is clean on the real repo"
 *        "REGRESSION: the schedule no longer takes its region from the …"
 *        "I6: the real workflow seeds AZURE_LOCATION from the input alone"
 *        + the 11 I6 mutant/control tests, which refuse to run once SAFE_SEED
 *          is no longer on disk rather than silently proving nothing.
 *      `node scripts/ci/check-reconcile-safety.mjs` -> exit 1, naming
 *      .github/workflows/deploy-fiab-commercial.yml:132.
 *   F. break the DETECTOR instead of the workflow (ENV_OPENER -> a regex that
 *      never matches)                                      -> 47 pass, 13 RED
 *      including "I6 DISCOVERY: env: mappings are parsed at every level …",
 *      and the guard exits 1 with `DISCOVERY FLOOR: found 0 AZURE_LOCATION
 *      entr(y/ies)`. An empty population is a failure here, never a pass.
 *   G. `|| 'westus2'` (a region that is NOT eastus2)  -> guard exit 1. The rule
 *      is keyed to the MISMATCH, so it cannot be side-stepped by picking a
 *      different literal, and the safe form keeps `found` at 1 rather than
 *      silencing the rule.
 *   H. `|| 'EastUS2'` (mixed case, which `az --location` accepts)
 *                     -> check-reconcile-safety exit 1, check-deploy-input-
 *                        safety exit 0. This shape was previously unguarded.
 *
 * All mutations reverted; the workflow is byte-identical to HEAD and the suite
 * is back at 60/60.
 *
 * Run: node --test scripts/ci/__tests__/reconcile-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  APP_IMAGE_TAGS,
  APP_IMAGE_TAG_BY_KEY,
  parseImageRef,
  resolveRunningImageTags,
  decideDeployApps,
  resolveReconcileRegion,
  tagEnvLines,
} from '../reconcile-policy.mjs';
import {
  run as runSafety,
  checkDestructiveSteps,
  checkImageKeyFanout,
  checkPolicyTableCoverage,
  checkParamFile,
  checkWorkflowWiring,
  checkRegionSeed,
  envAssignments,
  deriveImageReads,
  parseParamImageTags,
  executableRun,
  parseWorkflowSteps,
  FLOORS,
  WORKFLOW,
  ADMIN_PLANE,
  COMMERCIAL_PARAM,
} from '../check-reconcile-safety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readNorm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** A running-estate fixture shaped like the real `az containerapp list` output. */
const LIVE = [
  { name: 'loom-console', image: 'acr123.azurecr.io/loom-console:5f9edba7694b254c68f0d41c03bc37c8b9cf7651' },
  { name: 'loom-mcp', image: 'acr123.azurecr.io/loom-mcp:0.80.0' },
  { name: 'loom-mcp-bridge', image: 'acr123.azurecr.io/loom-mcp-bridge:v0.1' },
  { name: 'loom-activator', image: 'acr123.azurecr.io/loom-activator:0.80.0' },
  { name: 'loom-mirroring', image: 'acr123.azurecr.io/loom-mirroring:0.80.0' },
  { name: 'loom-direct-lake-shim', image: 'acr123.azurecr.io/loom-direct-lake-shim:0.80.0' },
  { name: 'loom-setup-orchestrator', image: 'acr123.azurecr.io/loom-setup-orchestrator:0.80.0' },
  { name: 'loom-script-runner', image: 'acr123.azurecr.io/loom-script-runner:b5c07287' },
  // The Container App name and the image repository DIVERGE in the real estate
  // (`loom-wrangler-h2` runs `loom-wrangler-host`). Matching on the repository
  // rather than the app name is what makes this resolvable at all.
  { name: 'loom-wrangler-h2', image: 'acr123.azurecr.io/loom-wrangler-host:v0.1' },
  { name: 'loom-dbt-r2', image: 'acr123.azurecr.io/loom-dbt-runner:v0.1' },
  { name: 'loom-transform-runner', image: 'acr123.azurecr.io/loom-transform-runner:v0.1' },
  { name: 'loom-migrate', image: 'acr123.azurecr.io/loom-migrate:v0.1' },
  // Not a Loom image at all — must be ignored, not mis-attributed.
  { name: 'loom-airflow', image: 'apache/airflow:2.10.5-python3.12' },
  { name: 'loom-udf-runtime', image: 'mcr.microsoft.com/azure-functions/python:4-python3.11' },
];

// ---------------------------------------------------------------------------
// parseImageRef
// ---------------------------------------------------------------------------

test('parseImageRef splits registry / repo / tag', () => {
  assert.deepEqual(parseImageRef('acr123.azurecr.io/loom-console:abc'), {
    registry: 'acr123.azurecr.io', repo: 'loom-console', tag: 'abc', digest: null,
  });
});

test('parseImageRef keeps a multi-segment repository intact', () => {
  const r = parseImageRef('mcr.microsoft.com/azure-functions/python:4-python3.11');
  assert.equal(r.repo, 'azure-functions/python');
  assert.equal(r.tag, '4-python3.11');
});

test('parseImageRef handles a registry-less reference (the bicep-local shape)', () => {
  const r = parseImageRef('loom-console:v0.1');
  assert.equal(r.registry, '');
  assert.equal(r.repo, 'loom-console');
  assert.equal(r.tag, 'v0.1');
});

test('parseImageRef reports a digest pin as a digest, never as a tag', () => {
  const r = parseImageRef('acr123.azurecr.io/loom-console@sha256:deadbeef');
  assert.equal(r.tag, null);
  assert.equal(r.digest, 'sha256:deadbeef');
});

test('parseImageRef returns null for junk rather than a half-parsed guess', () => {
  for (const bad of ['', '   ', null, undefined]) assert.equal(parseImageRef(bad), null);
});

// ---------------------------------------------------------------------------
// resolveRunningImageTags — the measurement the invariant rests on
// ---------------------------------------------------------------------------

test('every running image is pinned to the tag it is ACTUALLY running', () => {
  const r = resolveRunningImageTags(LIVE);
  assert.equal(r.probed, true);
  assert.equal(r.pinned.console, '5f9edba7694b254c68f0d41c03bc37c8b9cf7651');
  assert.equal(r.pinned.mcp, '0.80.0');
  assert.equal(r.pinned.scriptRunner, 'b5c07287');
  // Repository match, not app-name match.
  assert.equal(r.pinned.wrangler, 'v0.1');
  assert.equal(r.pinned.dbtRunner, 'v0.1');
  assert.equal(r.unknown.length, 0);
});

test('an app that is NOT deployed is absent, not unknown — creating it changes no running image', () => {
  const r = resolveRunningImageTags(LIVE);
  assert.ok(r.absent.includes('duckdb'));
  assert.ok(r.absent.includes('risingwave'));
  assert.equal(r.pinned.duckdb, undefined);
  assert.equal(r.unknown.find((u) => u.key === 'duckdb'), undefined);
});

test('a digest-pinned container is UNKNOWN — a tag cannot be invented from a digest', () => {
  const r = resolveRunningImageTags([
    { name: 'loom-console', image: 'acr123.azurecr.io/loom-console@sha256:beef' },
  ]);
  const u = r.unknown.find((x) => x.key === 'console');
  assert.ok(u, 'console must be UNKNOWN when it runs by digest');
  assert.match(u.why, /digest/i);
  assert.equal(r.pinned.console, undefined);
  assert.equal(r.absent.includes('console'), false, 'UNKNOWN must never be collapsed into absent');
});

test('two containers on one repository at DIFFERENT tags is UNKNOWN — one key cannot preserve both', () => {
  const r = resolveRunningImageTags([
    { name: 'a', image: 'acr123.azurecr.io/loom-console:one' },
    { name: 'b', image: 'acr123.azurecr.io/loom-console:two' },
  ]);
  const u = r.unknown.find((x) => x.key === 'console');
  assert.ok(u);
  assert.match(u.why, /different tags/i);
  assert.equal(r.pinned.console, undefined);
});

test('two containers on one repository at the SAME tag is fine', () => {
  const r = resolveRunningImageTags([
    { name: 'a', image: 'acr123.azurecr.io/loom-console:same' },
    { name: 'b', image: 'acr123.azurecr.io/loom-console:same' },
  ]);
  assert.equal(r.pinned.console, 'same');
  assert.equal(r.unknown.length, 0);
});

test('a FAILED probe is probed:false with everything UNKNOWN — never an empty estate', () => {
  const r = resolveRunningImageTags(null);
  assert.equal(r.probed, false);
  assert.equal(r.absent.length, 0, 'a failed query must not report apps as "not deployed"');
  assert.equal(r.unknown.length, APP_IMAGE_TAGS.length);
});

test('an estate with no container apps is probed:true and all-absent', () => {
  const r = resolveRunningImageTags([]);
  assert.equal(r.probed, true);
  assert.equal(r.absent.length, APP_IMAGE_TAGS.length);
  assert.equal(r.unknown.length, 0);
});

// ---------------------------------------------------------------------------
// decideDeployApps — default deny, upgrade only on proof
// ---------------------------------------------------------------------------

test('schedule + every running tag resolved -> UPGRADES to true (this is what applies Console env)', () => {
  const d = decideDeployApps({
    eventName: 'schedule', baseValue: 'false', resolution: resolveRunningImageTags(LIVE),
  });
  assert.equal(d.value, 'true');
  assert.equal(d.upgraded, true);
});

test('schedule + an UNKNOWN tag -> stays infra-only', () => {
  const d = decideDeployApps({
    eventName: 'schedule',
    baseValue: 'false',
    resolution: resolveRunningImageTags([
      ...LIVE, { name: 'x', image: 'acr123.azurecr.io/loom-console:other' },
    ]),
  });
  assert.equal(d.value, 'false');
  assert.match(d.reason, /UNKNOWN/);
});

test('schedule + a FAILED probe -> stays infra-only, and says the images could not be read', () => {
  const d = decideDeployApps({ eventName: 'schedule', baseValue: 'false', resolution: resolveRunningImageTags(null) });
  assert.equal(d.value, 'false');
  assert.match(d.reason, /could not be read/i);
});

test('schedule + no running console -> stays infra-only (bringing one up is an operator action)', () => {
  const d = decideDeployApps({
    eventName: 'schedule', baseValue: 'false', resolution: resolveRunningImageTags([]),
  });
  assert.equal(d.value, 'false');
  assert.match(d.reason, /loom-console/);
});

test('a dispatch is never overridden in either direction', () => {
  const clean = resolveRunningImageTags(LIVE);
  assert.equal(decideDeployApps({ eventName: 'workflow_dispatch', baseValue: 'false', resolution: clean }).value, 'false');
  assert.equal(decideDeployApps({ eventName: 'workflow_dispatch', baseValue: 'true', resolution: clean }).value, 'true');
  // Even with an unreadable estate, an operator who asked for apps gets apps.
  assert.equal(
    decideDeployApps({ eventName: 'workflow_dispatch', baseValue: 'true', resolution: resolveRunningImageTags(null) }).value,
    'true',
  );
});

// ---------------------------------------------------------------------------
// resolveReconcileRegion — the eastus2-vs-centralus bug (#2775, then #3029)
// ---------------------------------------------------------------------------

test('schedule derives the region from the hub that actually exists', () => {
  const r = resolveReconcileRegion({
    eventName: 'schedule', adminRgNames: ['rg-csa-loom-admin-centralus'],
  });
  assert.equal(r.decision, 'use');
  assert.equal(r.region, 'centralus', 'the schedule must NOT fall back to the eastus2 default');
  assert.equal(r.source, 'adopted');
});

test('schedule + the RG query FAILED -> refuses rather than defaulting to another region', () => {
  const r = resolveReconcileRegion({ eventName: 'schedule', adminRgNames: null });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /UNKNOWN/);
});

test('DISPATCH + the RG query FAILED -> refuses too (#3029: UNKNOWN is not a licence to guess)', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch', requestedRegion: 'centralus', adminRgNames: null,
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /UNKNOWN/);
});

test('schedule + hubs in two regions -> refuses (an unattended job cannot choose)', () => {
  const r = resolveReconcileRegion({
    eventName: 'schedule',
    adminRgNames: ['rg-csa-loom-admin-centralus', 'rg-csa-loom-admin-eastus2'],
  });
  assert.equal(r.decision, 'refuse');
});

test('two regions + an explicit region that is one of them -> uses it', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch',
    requestedRegion: 'eastus2',
    adminRgNames: ['rg-csa-loom-admin-centralus', 'rg-csa-loom-admin-eastus2'],
  });
  assert.equal(r.decision, 'use');
  assert.equal(r.region, 'eastus2');
});

test('two regions + an explicit region that is NEITHER -> refuses', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch',
    requestedRegion: 'westus3',
    adminRgNames: ['rg-csa-loom-admin-centralus', 'rg-csa-loom-admin-eastus2'],
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /THIRD estate/);
});

test('no hub + an explicit region -> a first-run install at that region', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch', requestedRegion: 'eastus2', adminRgNames: [],
  });
  assert.equal(r.decision, 'use');
  assert.equal(r.region, 'eastus2');
  assert.equal(r.source, 'input');
});

test('no hub + NO region -> refuses; there is no default region to fall back to (#3029)', () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const r = resolveReconcileRegion({ eventName, adminRgNames: [] });
    assert.equal(r.decision, 'refuse', `${eventName} must not invent a region`);
    assert.match(r.reason, /no region may be assumed/);
  }
});

// THE #3029 CASE, both ways round.
test('an explicit region that does NOT match the one hub -> REFUSES on every trigger', () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const r = resolveReconcileRegion({
      eventName, requestedRegion: 'eastus2', adminRgNames: ['rg-csa-loom-admin-centralus'],
    });
    assert.equal(r.decision, 'refuse', `${eventName}: eastus2 against a centralus hub must refuse`);
    assert.match(r.reason, /second, empty estate/);
    assert.match(r.reason, /region=centralus/, 'the refusal must name the region to re-dispatch with');
  }
});

test('an explicit region that MATCHES the one hub -> used, and says so', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch', requestedRegion: 'centralus', adminRgNames: ['rg-csa-loom-admin-centralus'],
  });
  assert.equal(r.decision, 'use');
  assert.equal(r.region, 'centralus');
  assert.equal(r.source, 'input');
});

test('a dispatch with NO region adopts the estate rather than the old eastus2 default (#3029)', () => {
  const r = resolveReconcileRegion({
    eventName: 'workflow_dispatch', adminRgNames: ['rg-csa-loom-admin-centralus'],
  });
  assert.equal(r.decision, 'use');
  assert.equal(r.region, 'centralus');
  assert.equal(r.source, 'adopted');
});

test('resolveReconcileRegion accepts no fallback argument — a default region cannot be reintroduced by a caller', () => {
  // The old signature took `fallback`, and reconcile-resolve.mjs passed
  // `AZURE_LOCATION || 'eastus2'` into it. That parameter WAS the defect.
  assert.ok(
    !/fallback/.test(resolveReconcileRegion.toString()),
    'resolveReconcileRegion still references a fallback region',
  );
});

// ---------------------------------------------------------------------------
// tagEnvLines
// ---------------------------------------------------------------------------

test('only PINNED keys are exported — an absent one is left to the param default', () => {
  const r = resolveRunningImageTags(LIVE);
  const lines = tagEnvLines(r.pinned);
  assert.equal(lines.length, Object.keys(r.pinned).length);
  assert.ok(lines.includes('LOOM_CONSOLE_TAG=5f9edba7694b254c68f0d41c03bc37c8b9cf7651'));
  assert.equal(lines.some((l) => l.startsWith('LOOM_DUCKDB_TAG=')), false);
});

test('every exported name is the one its APP_IMAGE_TAGS entry declares', () => {
  const lines = tagEnvLines(Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.key, 'T'])));
  assert.deepEqual(lines, APP_IMAGE_TAGS.map((e) => `${e.envVar}=T`));
});

test('APP_IMAGE_TAGS has no duplicate key, repository or env var', () => {
  for (const field of ['key', 'repo', 'envVar']) {
    const seen = new Set(APP_IMAGE_TAGS.map((e) => e[field]));
    assert.equal(seen.size, APP_IMAGE_TAGS.length, `duplicate ${field} in APP_IMAGE_TAGS`);
  }
});

// ---------------------------------------------------------------------------
// THE GUARD, AGAINST THE REAL REPOSITORY
// These are the tests that go red when someone undoes a fix.
// ---------------------------------------------------------------------------

test('check-reconcile-safety.run() is clean on the real repo', () => {
  const problems = runSafety();
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the real workflow: no destructive step runs on a schedule', () => {
  const r = checkDestructiveSteps(readNorm(WORKFLOW));
  assert.ok(
    r.found >= FLOORS.destructiveSteps,
    `only ${r.found} destructive step(s) discovered — the detector, not the workflow, is what changed`,
  );
  assert.deepEqual(r.violations, [], r.violations.map((v) => v.msg).join('\n'));
});

test('REGRESSION: the teardown\'s schedule clause has not come back', () => {
  const steps = parseWorkflowSteps(readNorm(WORKFLOW));
  const teardown = steps.find((s) => /fiab-teardown\.sh/.test(s.run));
  assert.ok(teardown, 'the teardown step disappeared — this test can no longer measure anything');
  assert.doesNotMatch(
    teardown.if, /github\.event_name\s*==\s*'schedule'/,
    'a scheduled run would reach fiab-teardown.sh, which deletes every rg-csa-loom-* RG in the subscription',
  );
  assert.match(teardown.if, /github\.event_name\s*!=\s*'schedule'/);
});

test('the real bicep: no appImageTags key drives two repositories', () => {
  const reads = deriveImageReads(ADMIN_PLANE);
  assert.ok(reads.length >= FLOORS.imageReads, `only ${reads.length} appImageTags reads found`);
  const { violations, byKey } = checkImageKeyFanout(reads);
  assert.deepEqual(violations, [], violations.map((v) => v.msg).join('\n'));
  // The specific collision this PR split.
  assert.equal([...(byKey.get('console') || [])].join(), 'loom-console');
  assert.equal([...(byKey.get('dbtRunner') || [])].join(), 'loom-dbt-runner');
});

test('the resolver table matches the repositories the bicep actually builds', () => {
  const { byKey } = checkImageKeyFanout(deriveImageReads(ADMIN_PLANE));
  const violations = checkPolicyTableCoverage(byKey);
  assert.deepEqual(violations, [], violations.map((v) => v.msg).join('\n'));
});

test('the real bicepparam pins every tag through an env var, never a literal', () => {
  const tags = parseParamImageTags(COMMERCIAL_PARAM);
  assert.ok(tags, 'commercial.bicepparam declares no appImageTags block');
  for (const [key, value] of Object.entries(tags)) {
    assert.match(
      value, /^readEnvironmentVariable\('LOOM_[A-Z0-9_]+_TAG',/,
      `appImageTags.${key} = ${value} — a literal tag is applied over whatever is running`,
    );
  }
  const res = checkParamFile(COMMERCIAL_PARAM, deriveImageReads(ADMIN_PLANE));
  assert.deepEqual(res.violations, [], res.violations.map((v) => v.msg).join('\n'));
});

test('every key the bicep reads NON-optionally is present in commercial.bicepparam', () => {
  const reads = deriveImageReads(ADMIN_PLANE);
  const required = [...new Set(reads.filter((r) => !r.optional).map((r) => r.key))];
  assert.ok(required.length >= 10, `only ${required.length} non-optional keys found`);
  const tags = parseParamImageTags(COMMERCIAL_PARAM);
  for (const k of required) {
    assert.ok(k in tags, `appImageTags.${k} missing — the nested deployment fails template evaluation`);
  }
});

test('the workflow runs the resolver before it deploys, and consumes its verdict', () => {
  const violations = checkWorkflowWiring(readNorm(WORKFLOW));
  assert.deepEqual(violations, [], violations.map((v) => v.msg).join('\n'));
});

test('REGRESSION: the schedule no longer takes its region from the eastus2 default alone', () => {
  const yaml = readNorm(WORKFLOW);
  const code = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /node scripts\/ci\/reconcile-resolve\.mjs/);
  // TWO independent things have to hold, and this test used to assert only the
  // second. Its old comment said "the fallback may remain in `env:` — it IS the
  // first-run default", which was already false when #3029 landed: there is NO
  // default region. Restoring `${{ inputs.region || 'eastus2' }}` therefore left
  // all 47 tests here green (measured 2026-08-11). I6 is the missing half.
  const seed = checkRegionSeed(yaml);
  assert.deepEqual(seed.violations, [], seed.violations.map((v) => v.msg).join('\n'));
  // …and the downstream override that makes the resolver's verdict the one ARM sees.
  assert.match(readNorm(join(HERE, '..', 'reconcile-resolve.mjs')), /AZURE_LOCATION=\$\{region\}/);
});

// ---------------------------------------------------------------------------
// I6 — the AZURE_LOCATION seed in `env:` (refs #3029)
//
// Keyed to the MISMATCH ("a producer that is neither the input nor the
// resolver"), never to the string 'eastus2': a future default of 'westus2'
// must fail identically, and adopting the safe form must leave the rule
// MATCHING the line rather than going quiet on it.
// ---------------------------------------------------------------------------

/** The seed as it stands on `main` — the text every mutant below replaces. */
const SAFE_SEED = 'AZURE_LOCATION: ${{ inputs.region }}';

/** Apply a mutation and refuse to proceed if it did not actually land. */
function mutateWorkflow(replacement) {
  const yaml = readNorm(WORKFLOW);
  const mutant = yaml.replace(SAFE_SEED, replacement);
  assert.notEqual(mutant, yaml, `the mutation did not apply (\`${SAFE_SEED}\` not found) — this test would prove nothing`);
  return mutant;
}

test('I6: the real workflow seeds AZURE_LOCATION from the input alone', () => {
  const r = checkRegionSeed(readNorm(WORKFLOW));
  // found >= 1 is the half that matters most: the safe form must keep the rule
  // POINTED AT the line. A guard that only matches the broken spelling goes
  // silent on exactly the files that adopted the fix.
  assert.ok(
    r.found >= FLOORS.regionSeeds,
    `only ${r.found} AZURE_LOCATION seed(s) discovered — envAssignments(), not the workflow, is what changed`,
  );
  assert.deepEqual(r.violations, [], r.violations.map((v) => v.msg).join('\n'));
});

test('I6 DISCOVERY: env: mappings are parsed at every level, and shell text is not', () => {
  const entries = envAssignments(readNorm(WORKFLOW));
  assert.ok(entries.length >= 40, `only ${entries.length} env entries parsed — the parser broke`);
  // Workflow-level AND step-level env: blocks.
  assert.ok(entries.some((e) => e.name === 'AZURE_LOCATION'), 'the workflow-level seed was not found');
  assert.ok(entries.some((e) => e.name === 'INPUT_REGION'), 'no step-level env: block was parsed');
  // `run: |` bodies are shell, not YAML. A line like `RG="rg-…-${AZURE_LOCATION}"`
  // must never be mistaken for an env assignment.
  assert.equal(entries.filter((e) => e.name === 'AZURE_LOCATION').length, 1);
  assert.equal(entries.filter((e) => /[^A-Za-z0-9_]/.test(e.name)).length, 0);
});

// Each row is a DIFFERENT spelling of the same defect. Measured 2026-08-11
// against check-deploy-input-safety.mjs S3 (`/\|\|\s*'[a-z0-9]+'/` on the FIRST
// matching line): only the first two are caught there. I6 must catch all seven.
const REGION_SEED_MUTANTS = [
  ["|| 'eastus2' — the #3029 defect verbatim", "AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}", /'eastus2'/],
  ["|| 'westus2' — a DIFFERENT region, so the rule cannot be keyed to eastus2", "AZURE_LOCATION: ${{ inputs.region || 'westus2' }}", /'westus2'/],
  ['|| "eastus2" — double quotes', 'AZURE_LOCATION: ${{ inputs.region || "eastus2" }}', /'eastus2'/],
  ["|| 'EastUS2' — mixed case, which `az --location` accepts", "AZURE_LOCATION: ${{ inputs.region || 'EastUS2' }}", /'EastUS2'/],
  ['a bare YAML scalar with no expression at all', 'AZURE_LOCATION: eastus2', /bare text "eastus2"/],
  ["the literal on the LEFT of ||", "AZURE_LOCATION: ${{ inputs.region == '' && 'eastus2' || inputs.region }}", /'eastus2'/],
  ['seeded from another env var nobody measured', 'AZURE_LOCATION: ${{ env.DEFAULT_REGION }}', /env\.DEFAULT_REGION/],
];

for (const [label, replacement, expected] of REGION_SEED_MUTANTS) {
  test(`I6 MUTANT: ${label} -> the guard FAILS`, () => {
    const r = checkRegionSeed(mutateWorkflow(replacement));
    assert.ok(r.violations.length > 0, `expected a violation for \`${replacement}\`, got none`);
    const text = r.violations.map((v) => v.msg).join('\n');
    assert.match(text, /AZURE_LOCATION/);
    assert.match(text, expected);
    // The violation must point at the line, so the failure names WHERE to look.
    assert.ok(r.violations.every((v) => v.line > 0), `a violation carries no line number: ${text}`);
  });
}

test('I6 MUTANT: the whole seed line DELETED -> DISCOVERY FLOOR, not a clean pass', () => {
  const yaml = readNorm(WORKFLOW);
  const mutant = yaml.replace(`  ${SAFE_SEED}\n`, '');
  assert.notEqual(mutant, yaml, 'the deletion did not apply — this test would prove nothing');
  const r = checkRegionSeed(mutant);
  assert.equal(r.found, 0);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].msg, /DISCOVERY FLOOR/);
});

test('I6 MUTANT: the env: block restructured into a flow mapping -> DISCOVERY FLOOR', () => {
  // A YAML restructure must report BROKEN DISCOVERY, never silence. The old
  // `.find(/^\s*AZURE_LOCATION:/)` shape returned '' here and read as clean.
  const yaml = readNorm(WORKFLOW);
  const mutant = yaml.replace(`  ${SAFE_SEED}`, "  # moved: { AZURE_LOCATION: '${{ inputs.region }}' }");
  assert.notEqual(mutant, yaml);
  const r = checkRegionSeed(mutant);
  assert.equal(r.found, 0);
  assert.match(r.violations[0].msg, /DISCOVERY FLOOR/);
});

test('I6 CONTROL: the resolver\'s own output and an empty fallback are ALLOWED', () => {
  const yaml = readNorm(WORKFLOW);
  for (const ok of [
    'AZURE_LOCATION: ${{ github.event.inputs.region }}',
    'AZURE_LOCATION: ${{ steps.reconcile.outputs.region }}',
    "AZURE_LOCATION: ${{ inputs.region || '' }}",
    'AZURE_LOCATION: ${{ inputs.region }}   # a trailing comment is not a value',
    'AZURE_LOCATION:',
  ]) {
    const variant = yaml.replace(SAFE_SEED, ok);
    assert.notEqual(variant, yaml, `the variant \`${ok}\` did not apply`);
    const r = checkRegionSeed(variant);
    assert.equal(r.found, 1, `${ok} was not discovered`);
    assert.deepEqual(r.violations, [], `${ok} -> ${r.violations.map((v) => v.msg).join('\n')}`);
  }
});

test('I6 CONTROL: a NON-region env entry is never policed by this rule', () => {
  // CSA_LOOM_CAPACITY_SKU legitimately carries `|| 'F8'`. I6 must not widen
  // into a general "no literals in env:" rule and start failing on it.
  const r = checkRegionSeed(readNorm(WORKFLOW));
  assert.deepEqual(r.violations, []);
  const entries = envAssignments(readNorm(WORKFLOW));
  assert.ok(entries.some((e) => e.name === 'CSA_LOOM_CAPACITY_SKU' && /'F8'/.test(e.value)));
});

// ---------------------------------------------------------------------------
// The detector's own blind spot, pinned
// ---------------------------------------------------------------------------

test('a command MENTIONED inside a quoted string is not an invocation', () => {
  const body = [
    '      - name: Note resources kept',
    '        run: |',
    '          echo "::warning::  RG_NAME=x bash .github/scripts/fiab-teardown.sh"',
  ];
  assert.doesNotMatch(executableRun(body), /fiab-teardown\.sh/);
});

test('an UNQUOTED invocation still counts', () => {
  const body = [
    '      - name: Teardown',
    '        run: bash .github/scripts/fiab-teardown.sh',
  ];
  assert.match(executableRun(body), /fiab-teardown\.sh/);
});

// ---------------------------------------------------------------------------
// CONTROLS — green under every mutation in the header. They assert SHAPE, so a
// widened branch cannot hide behind them.
// ---------------------------------------------------------------------------

test('CONTROL: every APP_IMAGE_TAGS entry is fully populated', () => {
  for (const e of APP_IMAGE_TAGS) {
    assert.ok(e.key && e.repo && e.envVar, `incomplete entry: ${JSON.stringify(e)}`);
    assert.match(e.envVar, /^LOOM_[A-Z0-9_]+_TAG$/);
    assert.equal(APP_IMAGE_TAG_BY_KEY[e.key], e);
  }
});

test('CONTROL: every resolution puts each key in exactly one bucket', () => {
  for (const fixture of [LIVE, [], null]) {
    const r = resolveRunningImageTags(fixture);
    const seen = [
      ...Object.keys(r.pinned), ...r.absent, ...r.unknown.map((u) => u.key),
    ];
    assert.equal(seen.length, APP_IMAGE_TAGS.length);
    assert.equal(new Set(seen).size, APP_IMAGE_TAGS.length);
  }
});

test('CONTROL: every deployApps decision is a bool string with a real reason', () => {
  const cases = [
    { eventName: 'schedule', baseValue: 'false', resolution: resolveRunningImageTags(LIVE) },
    { eventName: 'schedule', baseValue: 'false', resolution: resolveRunningImageTags(null) },
    { eventName: 'workflow_dispatch', baseValue: 'true', resolution: resolveRunningImageTags([]) },
  ];
  for (const c of cases) {
    const d = decideDeployApps(c);
    assert.ok(['true', 'false'].includes(d.value));
    assert.ok(typeof d.reason === 'string' && d.reason.length > 20);
  }
});

test('CONTROL: the guard parses the workflow into real steps', () => {
  const steps = parseWorkflowSteps(readNorm(WORKFLOW));
  assert.ok(steps.length >= 10, `only ${steps.length} steps parsed`);
  assert.ok(steps.some((s) => /Azure login/.test(s.name)));
  assert.ok(steps.some((s) => /az deployment sub create/.test(s.run)));
});
