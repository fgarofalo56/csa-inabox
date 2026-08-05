/**
 * Self-tests for resolve-image-preflight-refs.mjs (refs #2958).
 *
 * WHAT IS BEING PINNED. The Commercial deploy lane adopts a live estate and
 * creates any app that is missing. Apps with no running container get no
 * LOOM_<APP>_TAG pin from reconcile-resolve.mjs and fall back to the
 * paramfile's `readEnvironmentVariable(…, '<default>')` — five of seventeen on
 * the live estate 2026-08-04. This resolver decides WHICH refs the image
 * preflight then proves exist. If it under-emits, the preflight passes while
 * the deploy still creates Container Apps that can never pull, i.e. exactly the
 * "green gate measuring nothing" shape (#2585 / the gates-that-cannot-fail
 * lesson). So the emission set is driven here on fixtures — no fs, no network.
 *
 * Each case is chosen to DIE under an obvious mutation of the code it guards:
 *
 *   - flip `if (fromEnv) pinned` / `else unpinned`  → the pinned/unpinned split
 *     assertions invert and both go red.
 *   - drop `if (!fromEnv && !fallback) continue`    → a key the paramfile never
 *     declares would be emitted as `repo:undefined`; the subset test asserts it
 *     is ABSENT, so that mutation goes red. (This is the one that would turn a
 *     real registry into a false failure and get the guard switched off.)
 *   - make `--only-unpinned` emit everything    → the only-unpinned test asserts
 *     an exact 1-element set, so that mutation goes red.
 *   - let the env pin lose to the paramfile default → the precedence test
 *     asserts the RUNNING tag wins; goes red.
 *   - loosen the regex to match any quote/whitespace shape → the
 *     malformed-paramfile test asserts null, so a regex that accidentally
 *     matched a bare literal would go red.
 *
 * The final case is not a fixture: it drives the REAL commercial.bicepparam
 * with the REAL running-tag set observed on the estate and asserts the exact
 * five-app fallback list from #2958. That is the load-bearing one — a fixture
 * that models the code rather than reality is its own failure class
 * (csa_loom_fixtures_that_model_the_code), so this pins the answer against the
 * shipped paramfile.
 *
 * Run: node --test scripts/ci/__tests__/image-preflight-refs.test.mjs
 * (Also picked up automatically by scripts/ci/check-node-test-suites.mjs, which
 *  the merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRefs, paramDefaultFor, DEPLOY_CONDITIONS } from '../resolve-image-preflight-refs.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** A three-app stand-in for APP_IMAGE_TAGS. */
const TABLE = Object.freeze([
  { key: 'console', repo: 'loom-console', envVar: 'LOOM_CONSOLE_TAG' },
  { key: 'duckdb', repo: 'loom-duckdb', envVar: 'LOOM_DUCKDB_TAG' },
  { key: 'ghost', repo: 'loom-ghost', envVar: 'LOOM_GHOST_TAG' },
]);

/** A paramfile declaring only two of the three keys. */
const PARAM_SRC = `
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v0.1')
  duckdb: readEnvironmentVariable('LOOM_DUCKDB_TAG', 'v0.1')
}
`;

// ---------------------------------------------------------------------------
// paramDefaultFor — the paramfile parse
// ---------------------------------------------------------------------------

test('reads the literal fallback out of readEnvironmentVariable', () => {
  assert.equal(paramDefaultFor(PARAM_SRC, 'LOOM_CONSOLE_TAG'), 'v0.1');
});

test('a non-default tag (mapsTiles ships v1, not v0.1) is read verbatim', () => {
  const src = `mapsTiles: readEnvironmentVariable('LOOM_MAPS_TILES_TAG', 'v1')`;
  assert.equal(paramDefaultFor(src, 'LOOM_MAPS_TILES_TAG'), 'v1');
});

test('an UNDECLARED key returns null, not a guess', () => {
  assert.equal(paramDefaultFor(PARAM_SRC, 'LOOM_GHOST_TAG'), null);
});

test('a BARE literal tag is NOT read as a default (check-reconcile-safety territory)', () => {
  // If the regex were loosened to "find the tag somehow", this would return
  // 'v9.9' and the guard would silently assert a tag the template never pulls.
  assert.equal(paramDefaultFor(`console: 'v9.9'`, 'LOOM_CONSOLE_TAG'), null);
});

// ---------------------------------------------------------------------------
// resolveRefs — the emission decision
// ---------------------------------------------------------------------------

test('with NO running pins every declared key falls back to its paramfile default', () => {
  const r = resolveRefs({ paramSrc: PARAM_SRC, env: {}, table: TABLE });
  assert.deepEqual(r.refs, ['loom-console:v0.1', 'loom-duckdb:v0.1']);
  assert.deepEqual(r.pinned, []);
  assert.deepEqual(r.unpinned, ['loom-console:v0.1', 'loom-duckdb:v0.1']);
});

test('a RUNNING pin wins over the paramfile default, and counts as pinned', () => {
  const r = resolveRefs({
    paramSrc: PARAM_SRC,
    env: { LOOM_CONSOLE_TAG: '898b6daa' },
    table: TABLE,
  });
  assert.deepEqual(r.pinned, ['loom-console:898b6daa']);
  assert.deepEqual(r.unpinned, ['loom-duckdb:v0.1']);
  // The lane preflights BOTH — a pinned tag is running, but a registry purge
  // would still take the deploy down, and one extra read is cheap.
  assert.deepEqual(r.refs, ['loom-console:898b6daa', 'loom-duckdb:v0.1']);
});

test('a key the paramfile never declares is NEVER emitted (no repo:undefined)', () => {
  const r = resolveRefs({ paramSrc: PARAM_SRC, env: {}, table: TABLE });
  assert.equal(
    r.refs.some((x) => x.startsWith('loom-ghost')),
    false,
  );
  assert.equal(
    r.refs.some((x) => x.endsWith(':undefined')),
    false,
  );
});

test('--only-unpinned emits ONLY the unverified default-fallback refs', () => {
  const r = resolveRefs({
    paramSrc: PARAM_SRC,
    env: { LOOM_CONSOLE_TAG: '898b6daa' },
    onlyUnpinned: true,
    table: TABLE,
  });
  assert.deepEqual(r.refs, ['loom-duckdb:v0.1']);
});

// ---------------------------------------------------------------------------
// DEPLOY_CONDITIONS — the exclusions, which are the dangerous half
// ---------------------------------------------------------------------------

test('a key excluded on this boundary is SKIPPED with a reason, never silently dropped', () => {
  const conditions = {
    duckdb: { deployedOn: (b) => b === 'gcc-high', why: 'gov only (fixture)' },
  };
  const r = resolveRefs({ paramSrc: PARAM_SRC, env: {}, table: TABLE, conditions, boundary: 'commercial' });
  assert.deepEqual(r.refs, ['loom-console:v0.1']);
  assert.deepEqual(r.skipped, [{ ref: 'loom-duckdb:v0.1', why: 'gov only (fixture)' }]);
});

test('the same key IS asserted on the boundary that deploys it', () => {
  const conditions = {
    duckdb: { deployedOn: (b) => b === 'gcc-high', why: 'gov only (fixture)' },
  };
  const r = resolveRefs({ paramSrc: PARAM_SRC, env: {}, table: TABLE, conditions, boundary: 'gcc-high' });
  assert.deepEqual(r.refs, ['loom-console:v0.1', 'loom-duckdb:v0.1']);
  assert.deepEqual(r.skipped, []);
});

test('a RUNNING container OUTRANKS an exclusion — a stale condition cannot hide a live image', () => {
  // If the ordering were reversed (condition checked before the env pin), a
  // wrong exclusion would stop asserting a tag the estate is actually pulling.
  const conditions = {
    duckdb: { deployedOn: () => false, why: 'wrongly excluded (fixture)' },
  };
  const r = resolveRefs({
    paramSrc: PARAM_SRC,
    env: { LOOM_DUCKDB_TAG: 'h1' },
    table: TABLE,
    conditions,
    boundary: 'commercial',
  });
  assert.deepEqual(r.refs, ['loom-console:v0.1', 'loom-duckdb:h1']);
  assert.deepEqual(r.skipped, []);
});

test('the SHIPPED exclusions are exactly orchestrator (never) and mapsTiles (gov only)', () => {
  // Pins the loophole shut: any new exclusion has to be added here on purpose,
  // with the grep evidence the module header demands.
  assert.deepEqual(Object.keys(DEPLOY_CONDITIONS).sort(), ['mapsTiles', 'orchestrator']);
  assert.equal(DEPLOY_CONDITIONS.orchestrator.deployedOn('commercial'), false);
  assert.equal(DEPLOY_CONDITIONS.orchestrator.deployedOn('gcc-high'), false);
  assert.equal(DEPLOY_CONDITIONS.orchestrator.deployedOn('il5'), false);
  assert.equal(DEPLOY_CONDITIONS.mapsTiles.deployedOn('commercial'), false);
  assert.equal(DEPLOY_CONDITIONS.mapsTiles.deployedOn('gcc'), false);
  assert.equal(DEPLOY_CONDITIONS.mapsTiles.deployedOn('gcc-high'), true);
  assert.equal(DEPLOY_CONDITIONS.mapsTiles.deployedOn('il5'), true);
});

// ---------------------------------------------------------------------------
// The real paramfile, the real estate — the case that pins #2958's finding
// ---------------------------------------------------------------------------

test('commercial.bicepparam + the live running set => exactly the five unpinned apps of #2958', () => {
  const paramSrc = readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/params/commercial.bicepparam'),
    'utf8',
  );
  // The twelve apps observed RUNNING in rg-csa-loom-admin-centralus on
  // 2026-08-04 (`az containerapp list`), i.e. what reconcile-resolve.mjs would
  // export. Tags are the real ones; only their existence matters here.
  const env = {
    LOOM_CONSOLE_TAG: '898b6daa607c4cf6f0c67639ab9c4c2058cd5213',
    LOOM_MCP_TAG: '0.80.0',
    LOOM_MCP_BRIDGE_TAG: 'v0.1',
    LOOM_ACTIVATOR_TAG: '0.80.0',
    LOOM_MIRRORING_TAG: '0.80.0',
    LOOM_DIRECTLAKE_TAG: '0.80.0',
    LOOM_SETUP_ORCHESTRATOR_TAG: '0.80.0',
    LOOM_SCRIPT_RUNNER_TAG: 'b5c07287',
    LOOM_WRANGLER_TAG: 'v0.1',
    LOOM_DBT_RUNNER_TAG: 'v0.1',
    LOOM_TRANSFORM_RUNNER_TAG: 'v0.1',
    LOOM_MIGRATE_TAG: 'v0.1',
  };

  const r = resolveRefs({ paramSrc, env, boundary: 'commercial' });

  // orchestrator + mapsTiles are excluded on Commercial (dead key / gov-only),
  // so what the Commercial deploy would actually pull unproven is these four —
  // and the in-VNet probe (run 30955093956) found loom-duckdb:v0.1 MISSING.
  //
  // loom-unity joined this set in #2681, and that is the POINT of the change:
  // admin-plane/main.bicep now deploys the catalog DEFAULT-ON, so the Commercial
  // deploy really does pull `loom-unity:v0.1`. Before #2681 it was invisible
  // here — the module was an out-of-band entrypoint and the key was absent from
  // both APP_IMAGE_TAGS and commercial.bicepparam, so a deploy that could not
  // pull the image would have failed the Container App PUT with no preflight
  // warning at all. This row growing is the guard extending to cover it.
  assert.deepEqual(r.unpinned, [
    'loom-copilot-maf:v0.1',
    'loom-duckdb:v0.1',
    'loom-risingwave:v0.1',
    'loom-unity:v0.1',
  ]);
  assert.deepEqual(
    r.skipped.map((s) => s.ref),
    ['loom-orchestrator:v0.1', 'loom-maps-tileserver:v1'],
  );
  assert.equal(r.pinned.length, 12);
  assert.equal(r.refs.length, 16);
});

test('on GCC-High the SAME inputs additionally assert the maps tile server', () => {
  const paramSrc = readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/params/commercial.bicepparam'),
    'utf8',
  );
  const r = resolveRefs({ paramSrc, env: {}, boundary: 'gcc-high' });
  assert.equal(r.refs.includes('loom-maps-tileserver:v1'), true);
  assert.equal(r.refs.includes('loom-orchestrator:v0.1'), false);
});
