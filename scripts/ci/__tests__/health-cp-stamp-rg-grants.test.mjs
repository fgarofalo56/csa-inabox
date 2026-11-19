/**
 * Guard (#5380): the control-plane UAMI's conditioned RBAC Administrator grant on the stamp
 * resource group must allow EXACTLY the role definitions modules/health/tenant.bicep assigns.
 *
 * Drift is the failure: tenant.bicep gains a 5th role -> tenant.create 403s on the assignment
 * (condition too narrow); the CP condition keeps a role tenant.bicep dropped -> the CP can mint
 * an assignment nothing needs (condition too wide).
 *
 * WHAT VALUE WOULD MAKE EACH ASSERTION FAIL (assertion-design.md):
 *  - "set equals tenant.bicep": add a 5th `roleDefinitions', <id>` role to tenant.bicep, or drop
 *    one from control-plane.bicep's delegableRoleIds. The expected set is LIFTED from the
 *    `subscriptionResourceId('Microsoft.Authorization/roleDefinitions', X)` calls in tenant.bicep
 *    at runtime (X resolved through its `var`), not transcribed.
 *  - "lifted set has 4": guards the regex going blind (zero lifted would make equality vacuous
 *    only if both sides were empty; the CP side is asserted non-empty and == 4 here).
 *  - "write and delete both use the set": removing `${delegableRoleIds}` from either arm, or
 *    swapping @Resource for @Request on delete, turns the matching regex RED.
 *  - "ServicePrincipal only": changing the principal-type list to {'User'} or adding 'Group'.
 *  - "conditionVersion 2.0", Contributor / RBAC Admin built-in ids: change any id.
 *  - Mutation run in a SANDBOX COPY: HEALTH_TENANT_BICEP / HEALTH_CP_BICEP env override the
 *    tracked paths so a mutated copy can be tested without touching the tree.
 *
 * Run: node --test scripts/ci/__tests__/health-cp-stamp-rg-grants.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const HEALTH = path.join(REPO, 'platform', 'fiab', 'bicep', 'modules', 'health');
const TENANT = process.env.HEALTH_TENANT_BICEP || path.join(HEALTH, 'tenant.bicep');
const CP = process.env.HEALTH_CP_BICEP || path.join(HEALTH, 'control-plane.bicep');

const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Role ids tenant.bicep actually passes to a roleAssignments roleDefinitionId. */
export function tenantRoleIds(src) {
  const vars = new Map(
    [...src.matchAll(new RegExp(`^var (\\w+) = '(${GUID.source})'`, 'gm'))].map((m) => [m[1], m[2]]),
  );
  const ids = new Set();
  for (const m of src.matchAll(/roleDefinitions', (?:(\w+)|'([^']+)')\)/g)) {
    const id = m[2] ?? vars.get(m[1]);
    assert.ok(id && GUID.test(id), `tenant.bicep role arg "${m[1] ?? m[2]}" did not resolve to a GUID`);
    ids.add(id);
  }
  return ids;
}

/** Role ids in control-plane.bicep's delegableRoleIds var (the `{a, b, c, d}` list). */
export function cpDelegableIds(src) {
  const m = src.match(/^var delegableRoleIds = '\{([^}]*)\}'/m);
  assert.ok(m, 'control-plane.bicep must declare `var delegableRoleIds = \'{...}\'`');
  return new Set(m[1].split(',').map((s) => s.trim()));
}

const tenantSrc = read(TENANT);
const cpSrc = read(CP);

test('CP delegable role set equals the roles tenant.bicep assigns (lifted at runtime)', () => {
  const expected = tenantRoleIds(tenantSrc);
  const actual = cpDelegableIds(cpSrc);
  assert.equal(expected.size, 4, `tenant.bicep assigns ${[...expected]} - guard expects 4; update the CP grant deliberately`);
  assert.deepEqual([...actual].sort(), [...expected].sort(),
    'control-plane.bicep delegableRoleIds drifted from tenant.bicep role assignments');
});

test('condition checks write on @Request and delete on @Resource, both against the set, ServicePrincipal only', () => {
  const cond = cpSrc.match(/^var rbacAdminCondition = '(.*)'$/m);
  assert.ok(cond, 'rbacAdminCondition var missing');
  const c = cond[1];
  for (const [act, src] of [['write', 'Request'], ['delete', 'Resource']]) {
    assert.match(c, new RegExp(`ActionMatches\\{\\\\'Microsoft\\.Authorization/roleAssignments/${act}\\\\'\\}`), `${act} arm missing`);
    assert.match(c, new RegExp(`@${src}\\[Microsoft\\.Authorization/roleAssignments:RoleDefinitionId\\] ForAnyOfAnyValues:GuidEquals \\$\\{delegableRoleIds\\}`),
      `${act} arm must read @${src} RoleDefinitionId against delegableRoleIds`);
    assert.match(c, new RegExp(`@${src}\\[Microsoft\\.Authorization/roleAssignments:PrincipalType\\] ForAnyOfAnyValues:StringEqualsIgnoreCase \\{\\\\'ServicePrincipal\\\\'\\}`),
      `${act} arm must constrain PrincipalType to ServicePrincipal only`);
  }
  assert.equal((c.match(/\$\{delegableRoleIds\}/g) || []).length, 2, 'set referenced exactly once per arm');
});

test('assignments: Contributor + conditioned RBAC Admin, version 2.0, skipRoleGrants honoured, no Reader', () => {
  assert.match(cpSrc, /var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'/);
  assert.match(cpSrc, /var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'/);
  const admin = cpSrc.match(/resource cpStampRbacAdmin [^\n]*= if \(([^)]*\)?[^)]*)\) \{[\s\S]*?\n\}/);
  assert.ok(admin, 'cpStampRbacAdmin resource missing');
  assert.match(admin[0], /!skipRoleGrants/);
  assert.match(admin[0], /condition: rbacAdminCondition/);
  assert.match(admin[0], /conditionVersion: '2\.0'/);
  const contrib = cpSrc.match(/resource cpStampContributor [^\n]*\n/);
  assert.ok(contrib && /!skipRoleGrants/.test(contrib[0]), 'cpStampContributor must honour skipRoleGrants');
  assert.ok(!/resource cpStampReader/.test(cpSrc), 'Reader assignment must be replaced, not kept alongside Contributor');
});
