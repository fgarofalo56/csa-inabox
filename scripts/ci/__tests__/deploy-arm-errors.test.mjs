/**
 * deploy-arm-errors.test.mjs — the drill-down actually reads the real thing,
 * and CANNOT turn "I could not read it" into "there was nothing there".
 *
 * The fixtures in scripts/ci/__fixtures__/arm-ops-31069329802/ are the VERBATIM
 * `az deployment operation … list` output of deploy-fiab-commercial run
 * 31069329802 (only the subscription GUID is replaced). They are not modelled
 * on the parser — the parser is measured against them
 * (csa_loom_fixtures_that_model_the_code).
 *
 * Run: node --test scripts/ci/__tests__/deploy-arm-errors.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  STATUS,
  EXIT,
  azArgs,
  errorLeaves,
  failedOperations,
  nestedDeploymentTargets,
  resourceGroupOf,
  collectArmLeafErrors,
  renderLeaves,
  parseArgs,
} from '../deploy-arm-errors.mjs';
import { classify } from '../deploy-classify.mjs';

const FIXTURES = path.resolve(import.meta.dirname, '..', '__fixtures__', 'arm-ops-31069329802');
const ROOT_DEPLOYMENT = 'csa-loom-ci-31069329802';

/**
 * Replays the captured `az` output. Any call the fixtures do not cover is a
 * MISS, reported as az would report an unknown deployment — so a parser that
 * asks for the wrong thing fails rather than silently reading nothing.
 */
function fixtureRunner(calls = []) {
  return (args) => {
    calls.push(args.join(' '));
    const isGroup = args[2] === 'group';
    const name = args[args.indexOf('--name') + 1];
    const rg = isGroup ? args[args.indexOf('-g') + 1] : null;
    const file = isGroup ? `group--${rg}--${name}.json` : `sub--${name}.json`;
    const p = path.join(FIXTURES, file);
    if (!fs.existsSync(p)) {
      return {
        status: 1,
        stdout: '',
        stderr: `ERROR: (DeploymentNotFound) Deployment '${name}' could not be found.`,
      };
    }
    return { status: 0, stdout: fs.readFileSync(p, 'utf8'), stderr: '' };
  };
}

test('the captured run: both leaf causes are extracted from the real ARM output', () => {
  const calls = [];
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: fixtureRunner(calls) });

  assert.equal(r.status, STATUS.FOUND);
  const codes = r.leaves.map((l) => l.code).sort();
  assert.deepEqual(codes, ['BadRequest', 'RoleAssignmentExists']);

  const dns = r.leaves.find((l) => l.code === 'BadRequest');
  assert.match(dns.message, /cannot be linked to multiple zones with overlapping namespaces/);
  const ra = r.leaves.find((l) => l.code === 'RoleAssignmentExists');
  assert.match(ra.message, /The role assignment already exists/);

  // It recursed rather than reading only the top level.
  assert.ok(calls.some((c) => c.includes('operation sub list')), 'no sub-level enumeration');
  assert.ok(calls.some((c) => c.includes('--name admin-plane')), 'did not expand admin-plane');
  assert.ok(calls.some((c) => c.includes('--name network')), 'did not expand network');
  assert.ok(calls.some((c) => c.includes('--name swa-publish-rbac')), 'did not expand swa-publish-rbac');
});

test('MUTATION PROOF — the drilled text classifies; the run\'s own stderr does not', () => {
  // The stderr the classifier was ACTUALLY handed on run 31069329802: bicep
  // linter warnings, and the content-free ARM summary.
  const realStderr = [
    'WARNING: /home/runner/work/csa-inabox/csa-inabox/platform/fiab/bicep/modules/admin-plane/catalog.bicep(295,42) : Warning BCP318: The value of type "Microsoft.Purview/accounts | null" may be null at the start of the deployment, which would cause this access expression (and the overall deployment with it) to fail.',
    '/home/runner/work/csa-inabox/csa-inabox/platform/fiab/bicep/main.bicep(14,7) : Warning no-unused-params: Parameter "environment" is declared but never used.',
    'ERROR: {"code": "DeploymentFailed", "message": "At least one resource deployment operation failed. Please list deployment operations for details."}',
  ].join('\n');

  const before = classify(realStderr);
  assert.equal(before.class, 'unknown', 'the input the classifier really got must still be unclassifiable');

  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: fixtureRunner() });
  const after = classify(`${realStderr}\n${renderLeaves(r)}`);
  assert.notEqual(after.class, 'unknown');
  assert.equal(after.class, 'config');
  assert.ok(
    ['config.private-dns-namespace-overlap', 'config.role-assignment-exists'].includes(after.signalId),
    `unexpected signal ${after.signalId}`,
  );

  // BOTH causes must be visible to the operator, not only the winner.
  const rendered = renderLeaves(r);
  assert.match(rendered, /overlapping namespaces/);
  assert.match(rendered, /role assignment already exists/);

  // And each leaf, classified on its own, resolves to its own signal.
  assert.equal(
    classify(r.leaves.find((l) => l.code === 'BadRequest').message).signalId,
    'config.private-dns-namespace-overlap',
  );
  assert.equal(
    classify(r.leaves.find((l) => l.code === 'RoleAssignmentExists').message).signalId,
    'config.role-assignment-exists',
  );
});

test('MUTATION PROOF — az refusing the ROOT list is UNREADABLE, never "none"', () => {
  const denied = () => ({
    status: 1,
    stdout: '',
    stderr: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Resources/deployments/operations/read'.",
  });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: denied });
  assert.equal(r.status, STATUS.UNREADABLE);
  assert.equal(r.leaves.length, 0);
  assert.match(renderLeaves(r), /UNREADABLE/);
  assert.match(renderLeaves(r), /nothing\s+is asserted about the cause/);
  assert.doesNotMatch(renderLeaves(r), /none\./);
});

test('MUTATION PROOF — an EMPTY operation list is "none", and says so without asserting a cause', () => {
  const empty = () => ({ status: 0, stdout: '[]', stderr: '' });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: empty });
  assert.equal(r.status, STATUS.NONE);
  assert.equal(r.leaves.length, 0);
  assert.match(renderLeaves(r), /none\b/);
  assert.match(renderLeaves(r), /NOT in the deployment operations/);
});

test('MUTATION PROOF — a non-JSON answer is UNREADABLE, not an empty result', () => {
  const junk = () => ({ status: 0, stdout: '<html>login required</html>', stderr: '' });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: junk });
  assert.equal(r.status, STATUS.UNREADABLE);
  assert.match(r.reason, /not JSON/);
});

test('a nested list that cannot be read is PARTIAL, and the partial is disclosed', () => {
  // Root readable, every child refused: the nested details[] chain still
  // carries the causes, so leaves are found — but the failure to expand is
  // reported rather than hidden behind a clean-looking result.
  const rootOnly = (args) => {
    if (args[2] === 'sub') {
      return {
        status: 0,
        stdout: fs.readFileSync(path.join(FIXTURES, `sub--${ROOT_DEPLOYMENT}.json`), 'utf8'),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) read denied' };
  };
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: rootOnly });
  assert.equal(r.status, STATUS.FOUND);
  assert.ok(r.warnings.length > 0, 'a blocked expansion must be disclosed');
  assert.match(renderLeaves(r), /\(partial\)/);
});

test('maxDepth stops the walk and SAYS it stopped', () => {
  const r = collectArmLeafErrors({
    name: ROOT_DEPLOYMENT,
    scope: 'sub',
    maxDepth: 0,
    run: fixtureRunner(),
  });
  // depth 0 still reads the root; the children are refused with a warning.
  assert.ok(r.warnings.some((w) => /stopped at depth 0/.test(w)), r.warnings.join('|'));
});

test('subscription ids never reach the rendered output', () => {
  const leaky = () => ({
    status: 1,
    stdout: '',
    stderr:
      "ERROR: (AuthorizationFailed) does not have authorization over scope '/subscriptions/e093f4fd-5047-4ee4-968d-a56942c665f3/resourceGroups/rg-x'",
  });
  const out = renderLeaves(collectArmLeafErrors({ name: 'x', scope: 'sub', run: leaky }));
  assert.doesNotMatch(out, /e093f4fd-5047-4ee4-968d-a56942c665f3/);
  assert.match(out, /<redacted>/);
});

test('errorLeaves walks past the boilerplate wrappers to the real code', () => {
  const err = {
    code: 'DeploymentFailed',
    message: 'At least one resource deployment operation failed.',
    details: [
      {
        code: 'ResourceDeploymentFailure',
        message: 'reached terminal provisioning state Failed',
        details: [{ code: 'BadRequest', message: 'the actual cause', target: '/x' }],
      },
    ],
  };
  assert.deepEqual(errorLeaves(err), [{ code: 'BadRequest', message: 'the actual cause', target: '/x' }]);
  assert.deepEqual(errorLeaves(null), []);
  assert.deepEqual(errorLeaves(undefined), []);
});

test('failedOperations / nestedDeploymentTargets read the real fixture shape', () => {
  const ops = JSON.parse(fs.readFileSync(path.join(FIXTURES, `sub--${ROOT_DEPLOYMENT}.json`), 'utf8'));
  assert.equal(failedOperations(ops).length, 1);
  const nested = nestedDeploymentTargets(ops);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].name, 'admin-plane');
  assert.equal(nested[0].resourceGroup, 'rg-csa-loom-admin-centralus');
});

test('resourceGroupOf is case-insensitive and null when there is no RG segment', () => {
  assert.equal(resourceGroupOf('/subscriptions/x/resourcegroups/rg-a/providers/y'), 'rg-a');
  assert.equal(resourceGroupOf('/subscriptions/x/providers/y'), null);
  assert.equal(resourceGroupOf(undefined), null);
});

test('azArgs builds the calls the CLI documents, and threads --subscription', () => {
  assert.deepEqual(azArgs({ scope: 'sub', name: 'd' }), [
    'deployment', 'operation', 'sub', 'list', '--name', 'd', '-o', 'json',
  ]);
  assert.deepEqual(azArgs({ scope: 'group', name: 'd', resourceGroup: 'rg', subscription: 's' }), [
    'deployment', 'operation', 'group', 'list', '-g', 'rg', '--name', 'd', '--subscription', 's', '-o', 'json',
  ]);
});

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.equal(parseArgs(['--name', 'd', '--scope', 'group', '-g', 'rg']).resourceGroup, 'rg');
});

test('the three outcomes have three distinct exit codes', () => {
  assert.equal(new Set([EXIT.FOUND, EXIT.NONE, EXIT.UNREADABLE, EXIT.USAGE]).size, 4);
});
