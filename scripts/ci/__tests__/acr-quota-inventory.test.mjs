/**
 * Tests for scripts/ci/acr-quota-inventory.mjs (pure functions) and for the
 * verified-pool-release wiring in the Gov / blue-green workflows + the reaper.
 * Each assertion names the input that turns it red.
 *
 * Run: node --test scripts/ci/__tests__/acr-quota-inventory.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attribute, familyOf, poolCores, TIER_CORES } from '../acr-quota-inventory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wf = (n) => readFileSync(join(ROOT, '.github', 'workflows', n), 'utf8').replace(/\r\n/g, '\n');

// ---- familyOf ------------------------------------------------------------
test('familyOf: the four D v5 shapes map to distinct ARM families (ds != s != d != plain)', () => {
  assert.equal(familyOf('Standard_D8ds_v5'), 'standardDDSv5Family');
  assert.equal(familyOf('Standard_D8s_v5'), 'standardDSv5Family');
  assert.equal(familyOf('Standard_D8d_v5'), 'standardDDv5Family');
  assert.equal(familyOf('Standard_D8_v5'), 'standardDv5Family');
});
test('familyOf: a name that is not Standard_<series><n>... is null, never a guessed family', () => {
  assert.equal(familyOf('loombuild'), null);
  assert.equal(familyOf(undefined), null);
  assert.equal(familyOf(''), null);
});

// ---- poolCores -----------------------------------------------------------
test('poolCores: S3 x1 = 8 cores (the 8 the 2026-10-23 error said it needed), S3 x2 = 16', () => {
  assert.equal(TIER_CORES.S3, 8);
  assert.equal(poolCores({ tier: 'S3', count: 1 }), 8);
  assert.equal(poolCores({ tier: 'S3', count: 2 }), 16);
  assert.equal(poolCores({ tier: 'S3', count: 0 }), 0);
});
test('poolCores: unknown tier or non-numeric count is null (UNKNOWN), not 0', () => {
  assert.equal(poolCores({ tier: 'S9', count: 1 }), null, 'an unrecognised tier must not read as 0 cores');
  assert.equal(poolCores({ tier: 'S3', count: undefined }), null);
});

// ---- attribute -----------------------------------------------------------
test('attribute: used 100 of 100 with 60 visible -> unattributed 40, free 0 (the incident shape)', () => {
  const r = attribute('standardDDSv5Family', { currentValue: 100, limit: 100 },
    [{ family: 'standardDDSv5Family', cores: 40 }, { family: 'standardDDSv5Family', cores: 20 }, { family: 'standardDSv5Family', cores: 99 }]);
  assert.equal(r.state, 'ok');
  assert.equal(r.seen, 60, 'the DSv5 consumer must not be counted into DDSv5 (seen would be 159)');
  assert.equal(r.unattributed, 40);
  assert.equal(r.free, 0);
});
test('attribute: an unreadable usage row is unknown, never "0 used"', () => {
  assert.equal(attribute('standardDDSv5Family', null, []).state, 'unknown');
});
test('attribute: a consumer with no resolvable cores makes the remainder UNKNOWN (null), not usage - partial sum', () => {
  const r = attribute('standardDDSv5Family', { currentValue: 100, limit: 100 },
    [{ family: 'standardDDSv5Family', cores: 40 }, { family: 'standardDDSv5Family', cores: null }]);
  assert.equal(r.state, 'partial');
  assert.equal(r.unattributed, null, 'reporting 60 here would blame the pool for cores a consumer holds');
});

// ---- workflow wiring -----------------------------------------------------
const ROLLS = ['gov-console-roll.yml', 'gov-build-images.yml', 'console-bluegreen-roll.yml'];
for (const f of ROLLS) {
  test(`${f}: no best-effort pool scale-down remains (--no-wait / || true on agentpool update)`, () => {
    const t = wf(f);
    assert.doesNotMatch(t, /agentpool update[^\n]*--count 0[^\n]*(--no-wait|\|\| true)/, 'the old `update --count 0 --no-wait || true` line must be gone');
    assert.doesNotMatch(t, /agentpool update[^\n]*--no-wait/, 'no agentpool update may be fire-and-forget');
  });
  test(`${f}: has an if: always() verified release that waits and reads back via acr-build-pool.mjs`, () => {
    const t = wf(f);
    const i = t.indexOf('- name: Release the ACR build pool (verified)');
    assert.ok(i > 0, 'the verified release step must exist (deleting it turns this red)');
    const step = t.slice(i, i + 1500);
    assert.match(step, /if: always\(\)/, 'dropping always() lets a cancelled run leak the pool');
    assert.match(step, /acr-build-pool\.mjs release /, 'must use the read-back release helper');
    assert.match(step, /--wait-seconds 300/, 'must wait a bounded time for the queue to drain');
    assert.doesNotMatch(step, /\|\| true/, 'the release verdict must not be discarded');
  });
}

test('acr-agentpool-reaper.yml runs the quota inventory in both clouds and does not discard its verdict', () => {
  const t = wf('acr-agentpool-reaper.yml');
  assert.match(t, /boundary: \[Commercial, GCC-High\]/, 'both clouds must stay in the matrix');
  assert.match(t, /acr-quota-inventory\.mjs "\$\{inv\[@\]\}" \|\| rc=1/, 'a failed inventory read must fail the job (rc=1), not be dropped');
});
