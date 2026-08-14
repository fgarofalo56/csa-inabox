/**
 * Self-tests for assert-no-silent-image-tag-revert.mjs (#3161, runtime half).
 *
 * WHAT IS BEING PINNED. The static guard proves a tag env var is IN SCOPE where
 * the template is deployed. That is necessary and not sufficient: being in
 * scope with the value `v0.1` is precisely the state that flattened the Gov
 * estate. Only a live read distinguishes "correctly deploying the default" from
 * "silently reverting a pin", and only these tests prove the distinction is
 * actually drawn rather than asserted in a comment.
 *
 * Every CONTROL is chosen to DIE under an obvious mutation:
 *
 *   - make decideTagWrites() return no refusals -> the silent-revert control
 *     and the digest control both go red.
 *   - treat UNKNOWN as absent (the collapse deploy-integrity R7 forbids) ->
 *     the digest control and the failed-probe control go red.
 *   - drop the `source === 'pin'` branch -> the intentional-roll-forward
 *     control goes red (the guard would block every legitimate roll and be
 *     turned off within a week).
 *   - compare against the bicep default instead of the running tag -> the
 *     no-op control goes red (Gov legitimately RUNS :v0.1 after a roll).
 *   - honour LOOM_ALLOW_IMAGE_TAG_REVERT unconditionally -> the
 *     override-still-reports control goes red.
 *
 * The running-image side is NOT re-implemented here: it comes from
 * resolveRunningImageTags() in reconcile-policy.mjs, the same function the
 * Commercial lane uses in production. A fixture that modelled the code instead
 * of the dependency would agree with itself and prove nothing.
 *
 * Run: node --test scripts/ci/__tests__/silent-image-tag-revert.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideTagWrites, declaredTagDefaults, KEY_BY_ENV_VAR } from '../assert-no-silent-image-tag-revert.mjs';
import { resolveRunningImageTags } from '../reconcile-policy.mjs';

const ACR = 'acrloomxxxx.azurecr.us';
const declared = new Map([['LOOM_UNITY_TAG', 'v0.1'], ['LOOM_TRINO_TAG', 'v0.1']]);
const running = (pairs) => resolveRunningImageTags(pairs.map(([name, image]) => ({ name, image })));
const row = (r, envVar) => r.rows.find((x) => x.envVar === envVar);

// ---------------------------------------------------------------------------
// THE #3161 CONTROL
// ---------------------------------------------------------------------------

test('CONTROL: the param default about to overwrite a SHA-pinned live app is REFUSED', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' }, // vars unset -> the default
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:5f9edba7`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'REFUSE');
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'fallback');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, '5f9edba7');
  // loom-trino already runs what would be written — no finding, no noise.
  assert.equal(row(r, 'LOOM_TRINO_TAG').verdict, 'no-op');
});

test('an EXPLICIT pin moving a live app is allowed and reported as a move, not a revert', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'abc1234', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(row(r, 'LOOM_UNITY_TAG').verdict, 'move');
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'pin');
});

test('Gov after a dataplane roll: :v0.1 re-pointed at the verified digest is a NO-OP, not a revert', () => {
  // loom-dataplane-roll.yml's interim mitigation makes :v0.1 carry the rolled
  // content, so the running TAG is legitimately v0.1. A guard that compared
  // against "is this the bicep default" instead of "is this what is running"
  // would refuse every Gov deploy forever.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:v0.1`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
  });
  assert.equal(r.decision, 'proceed');
  assert.ok(r.rows.every((x) => x.verdict === 'no-op'));
});

test('greenfield: an app that is not running cannot be reverted', () => {
  const r = decideTagWrites({ declared, env: {}, resolution: running([]) });
  assert.equal(r.decision, 'proceed');
  assert.ok(r.rows.every((x) => x.verdict === 'create'));
});

// ---------------------------------------------------------------------------
// UNKNOWN IS NOT ABSENT
// ---------------------------------------------------------------------------

test('CONTROL: a DIGEST-pinned container is UNKNOWN, and a default-sourced write over it is refused', () => {
  // ACA pins the digest a revision was created with, so a rolled app frequently
  // reports no tag at all. Reading that as "nothing there" is the exact
  // UNKNOWN-as-NEGATIVE collapse.
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity@sha256:0123456789abcdef`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, 'UNKNOWN');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /digest/);
});

test('CONTROL: a FAILED container-app query refuses rather than reporting an empty estate', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: resolveRunningImageTags(null), // null = the query failed
  });
  assert.equal(r.decision, 'refuse');
  assert.ok(r.rows.every((x) => x.running === 'UNKNOWN'));
});

test('two containers running one repo at two tags is UNKNOWN, not a silent pick', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:v0.1`],
      ['iceberg-catalog', `${ACR}/loom-unity:abc9999`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(row(r, 'LOOM_UNITY_TAG').running, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// the override is explicit, logged, and still reports
// ---------------------------------------------------------------------------

test('LOOM_ALLOW_IMAGE_TAG_REVERT proceeds but the refusals are still ENUMERATED', () => {
  const r = decideTagWrites({
    declared,
    env: { LOOM_UNITY_TAG: 'v0.1', LOOM_TRINO_TAG: 'v0.1' },
    resolution: running([['loom-unity', `${ACR}/loom-unity:5f9edba7`], ['loom-trino', `${ACR}/loom-trino:v0.1`]]),
    allowRevert: true,
  });
  assert.equal(r.decision, 'proceed');
  assert.equal(r.refusals.length, 1, 'an acknowledged revert is still a reverted tag and must stay visible');
});

// ---------------------------------------------------------------------------
// self-defence + real-file wiring
// ---------------------------------------------------------------------------

test('a tag var absent from APP_IMAGE_TAGS is reported unmapped, never scored safe', () => {
  const r = decideTagWrites({
    declared: new Map([['LOOM_NOT_A_REAL_TAG', 'v0.1']]),
    env: {},
    resolution: running([]),
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(r.rows[0].verdict, 'unmapped');
});

test('declaredTagDefaults reads the REAL Gov param files, and every tag maps to an image', () => {
  for (const [file, expectConsole] of [
    ['platform/fiab/bicep/params/gcc-high.bicepparam', 'v0.1'],
    ['platform/fiab/bicep/params/il5.bicepparam', 'v3.0'],
  ]) {
    const d = declaredTagDefaults(readFileSync(file, 'utf8'));
    assert.ok(d.size >= 16, `${file} should declare at least 16 tag defaults, saw ${d.size}`);
    assert.equal(d.get('LOOM_CONSOLE_TAG'), expectConsole);
    for (const envVar of d.keys()) {
      assert.ok(KEY_BY_ENV_VAR[envVar], `${file} reads ${envVar}, which APP_IMAGE_TAGS cannot map to an image`);
    }
  }
});
