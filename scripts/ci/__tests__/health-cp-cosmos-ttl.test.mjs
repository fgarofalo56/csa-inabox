/**
 * Guard: health control-plane Cosmos containers must OMIT defaultTtl when no
 * default TTL is wanted. deploy-health run 43321878414 (Commercial): 7 of 9
 * containers were rejected with BadRequest "One of the specified inputs is
 * invalid"; the 7 had `defaultTtl: c.defaultTtl == 0 ? null : ...` which
 * compiles to `null()`, the 2 that succeeded carried -1.
 *
 * WHAT VALUE WOULD MAKE EACH ASSERTION FAIL (assertion-design.md):
 *  - "no null()" : the old bicep compiles to `if(equals(..defaultTtl, 0), null(), ..)`
 *    and the resource expression then contains `null()`. RED on the old copy.
 *  - "zero branch is empty object": a variant that emits `defaultTtl: 0`
 *    (createObject('defaultTtl', 0)) in the zero branch fails the regex.
 *  - containerDefs positives: flipping an auth container to 0 or a plain one
 *    to -1 changes the expected sets.
 *
 * The compiled ARM `resource` is an ARM expression (the copy loop is not
 * expanded at compile time), so the check is on the expression text plus the
 * containerDefs variable, not on an evaluated document.
 *
 * Run: node --test scripts/ci/__tests__/health-cp-cosmos-ttl.test.mjs
 * Needs `az bicep` (or `bicep`); the test FAILS, not skips, if neither exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const TRACKED = path.join(REPO, 'platform', 'fiab', 'bicep', 'modules', 'health', 'control-plane.bicep');

export function compile(file) {
  const attempts = [
    ['az', ['bicep', 'build', '--file', file, '--stdout']],
    ['bicep', ['build', file, '--stdout']],
  ];
  const errs = [];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
    if (r.status === 0 && r.stdout.trim().startsWith('{')) return JSON.parse(r.stdout);
    errs.push(`${cmd}: status=${r.status} ${String(r.stderr).slice(0, 300)}`);
  }
  throw new Error(`could not compile ${file}: ${errs.join(' | ')}`);
}

export function analyse(arm) {
  const defs = arm.variables.containerDefs;
  const res = arm.resources.filter((r) => r.type === 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers');
  return { defs, res };
}

const target = process.env.HEALTH_CP_BICEP || TRACKED;

test('containers resource never emits null() or a zero defaultTtl', () => {
  const { res } = analyse(compile(target));
  assert.equal(res.length, 1, 'exactly one containers resource expected');
  const resource = res[0].properties.resource;
  const text = JSON.stringify(resource);
  assert.ok(!text.includes('null()'), `defaultTtl must be omitted, not null(): ${text}`);
  // A literal (non-expression) object must not carry defaultTtl 0/null either.
  if (typeof resource === 'object') {
    assert.ok(!('defaultTtl' in resource) || (resource.defaultTtl !== 0 && resource.defaultTtl !== null), 'literal defaultTtl 0/null');
  }
  // Positive: the zero branch yields an EMPTY object, the other branch sets defaultTtl.
  assert.match(
    text,
    /if\(equals\(variables\('containerDefs'\)\[copyIndex\(\)\]\.defaultTtl, 0\), createObject\(\), createObject\('defaultTtl', variables\('containerDefs'\)\[copyIndex\(\)\]\.defaultTtl\)\)/,
    `zero branch must be createObject() and the other must carry defaultTtl: ${text}`,
  );
});

test('containerDefs: two auth containers carry -1, the seven others 0 (so omitted)', () => {
  const { defs } = analyse(compile(target));
  const byTtl = (t) => defs.filter((d) => d.defaultTtl === t).map((d) => d.name).sort();
  assert.deepEqual(byTtl(-1), ['health-auth-grants', 'health-auth-replay']);
  assert.deepEqual(byTtl(0), [
    'health-auth-config', 'health-jobs', 'health-pdp-bundles', 'health-routing',
    'health-slo', 'health-stamps', 'health-tenants',
  ]);
  assert.equal(defs.length, 9, 'no container may carry any other TTL unreviewed');
});
