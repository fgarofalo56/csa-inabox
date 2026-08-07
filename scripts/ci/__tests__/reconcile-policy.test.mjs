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
  // The fallback may remain in `env:` — it IS the first-run default. What must
  // exist is the override that makes a schedule use the estate's own region.
  assert.match(readNorm(join(HERE, '..', 'reconcile-resolve.mjs')), /AZURE_LOCATION=\$\{region\}/);
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
