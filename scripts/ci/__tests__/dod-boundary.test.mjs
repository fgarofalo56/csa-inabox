/**
 * DoD boundary (D3, LHDS W1-8): supported-in-code only, never exercised.
 *
 * WHAT VALUE WOULD MAKE EACH TEST FAIL (assertion-design.md):
 *   - enum tests: delete 'DoD' from the `@allowed` list in main.bicep or health.bicep
 *     (RED on the DoD assertion), or delete ANY prior value such as 'IL5' (RED on the
 *     positive control, which pins the exact list so a rewrite that drops a boundary
 *     cannot hide behind the DoD assertion).
 *   - param tests: change `param boundary = 'DoD'` to 'IL5' in dod.bicepparam (a
 *     copy-paste of il5 that forgot the edit), or drop the NEVER EXERCISED header.
 *   - alias test: remove 'DoD' from the `effectiveBoundary` expression; DoD would then
 *     fall through to 'Commercial' and silently lose every IL5 restriction.
 *   - not-deployed test: add a workflow step naming dod.bicepparam or dod-health. The
 *     positive control in the same test (il5 IS named by a workflow) proves the scan
 *     can see param-file names at all, so an empty result is not a blind scan.
 *
 * The pattern parser is LIFTED from check-env-sync.mjs (readAllowedValues), not
 * transcribed, so a regex typo cannot make this probe disagree with the guard.
 *
 * DISCLOSED, no kill power: the "header says NEVER EXERCISED" arm is a documentation
 * guard against a future loosening; it does not prove behaviour.
 *
 * Sandbox mutation: set DOD_TEST_ROOT to a copy of the tree to run against it.
 * Run: node --test scripts/ci/__tests__/dod-boundary.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllowedValues } from '../check-env-sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DOD_TEST_ROOT ?? path.resolve(HERE, '..', '..', '..');
const BICEP = path.join(ROOT, 'platform', 'fiab', 'bicep');
const read = (...p) => fs.readFileSync(path.join(BICEP, ...p), 'utf8');

const PRIOR = ['Commercial', 'GCC', 'GCC-High', 'IL5'];

for (const entry of ['main.bicep', 'health.bicep']) {
  test(`${entry}: boundary enum contains DoD AND every prior value, in order`, () => {
    const allowed = readAllowedValues(read(entry), 'boundary');
    assert.ok(allowed, `${entry} lost @allowed on param boundary`);
    assert.ok(allowed.includes('DoD'), `${entry} @allowed is ${JSON.stringify(allowed)}: DoD missing`);
    for (const v of PRIOR) assert.ok(allowed.includes(v), `${entry} @allowed dropped prior value ${v}`);
    assert.deepEqual(allowed, [...PRIOR, 'DoD'], `${entry} @allowed is not exactly prior + DoD`);
  });

  test(`${entry}: effectiveBoundary resolves DoD to IL5 and keeps every other boundary`, () => {
    const m = read(entry).match(/^var effectiveBoundary = (.+)$/m);
    assert.ok(m, `${entry} has no effectiveBoundary var`);
    const expr = m[1];
    // Evaluate the ternary for each boundary; the expression uses only == , ||, ?: and literals.
    const js = expr.replace(/\bboundary\b/g, 'b');
    const evalFor = (b) => new Function('b', `return ${js};`)(b);
    assert.equal(evalFor('DoD'), 'IL5', 'DoD must behave as IL5 (compliance restrictions)');
    for (const v of PRIOR) assert.equal(evalFor(v), v, `${v} must map to itself`);
  });
}

test('dod.bicepparam sets boundary DoD and discloses never-exercised', () => {
  const p = read('params', 'dod.bicepparam');
  assert.match(p, /^param boundary = 'DoD'\s*$/m, "dod.bicepparam must set boundary 'DoD'");
  assert.doesNotMatch(p, /^param boundary = 'IL5'/m);
  assert.match(p, /NEVER EXERCISED/, 'header must disclose never-exercised');
  assert.match(p, /^using '\.\.\/main\.bicep'/m);
  // positive control: the file it was derived from still sets IL5
  assert.match(read('params', 'il5.bicepparam'), /^param boundary = 'IL5'\s*$/m);
});

test('dod-health.bicepparam sets boundary DoD, health disabled, discloses never-exercised', () => {
  const p = read('health-params', 'dod-health.bicepparam');
  assert.match(p, /^param boundary = 'DoD'\s*$/m);
  assert.match(p, /^param healthEnabled = false\s*$/m);
  assert.match(p, /NEVER EXERCISED/);
  assert.match(p, /^using '\.\.\/health\.bicep'/m);
});

test('no workflow deploys DoD (il5 control proves the scan sees param names)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const naming = (re) => files.filter((f) => re.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(naming(/il5\.bicepparam/).length > 0, 'control: expected a workflow naming il5.bicepparam');
  assert.deepEqual(naming(/dod(-health)?\.bicepparam/), [], 'a workflow names the DoD param file');
});
