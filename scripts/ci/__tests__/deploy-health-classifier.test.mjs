/**
 * deploy-health.yml `Deploy health.bicep`: the failure classifier must be REACHABLE
 * under the runner shell (`bash -e`), and must see NESTED deployment errors.
 *
 * Why (run 43067631148): `az deployment sub create ... 2> temp/apply.err` failed, `bash -e`
 * ended the script on that line, the RC classifier never ran and apply.err was never
 * printed. The three real errors were only found by listing nested operations by hand.
 *
 * This test EXECUTES the step's script under `bash -e` with a stub `az`, so it fails on the
 * behaviour, not on a spelling. Breaking values (assertion-design.md):
 *   - the old step (no `set +e`): stdout has no "QUOTA/CAPACITY/REGION" -> test 1 RED.
 *   - a classifier that reads only apply.err: the zone error exists only in the nested
 *     operation, stderr says DeploymentFailed -> falls to UNCLASSIFIED -> test 1 RED.
 *   - the template-defect arm without ParameterOutOfRange/InvalidMaxRequestBody -> test 2 RED.
 * STUB_AZ_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 *
 * Needs bash and jq (present on ubuntu runners). Run:
 *   node --test scripts/ci/__tests__/deploy-health-classifier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.STUB_AZ_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wf = readFileSync(resolve(root, '.github/workflows/deploy-health.yml'), 'utf8').replace(/\r\n/g, '\n');

function stepScript(name) {
  const start = wf.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `step ${name} not found`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {6}- name: /);
  const block = next < 0 ? rest : rest.slice(0, next);
  const m = block.match(/\n {8}run: \|\n([\s\S]*)$/);
  assert.ok(m, `step ${name} has no run block`);
  return m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}

function runFailedApply({ stderr, operations }) {
  const dir = mkdtempSync(join(tmpdir(), 'dh-'));
  mkdirSync(join(dir, 'temp'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'ops.json'), JSON.stringify(operations));
  writeFileSync(join(dir, 'stderr.txt'), stderr);
  // Stub az: `deployment sub create` fails with `stderr`; `operation sub list` returns the
  // canned operations; `operation group list` returns [] (no deeper nesting).
  writeFileSync(
    join(dir, 'bin', 'az'),
    `#!/bin/bash\ncase "$*" in\n *"deployment sub create"*) cat "${dir}/stderr.txt" >&2; exit 1;;\n *"operation sub list"*) cat "${dir}/ops.json";;\n *"operation group list"*) echo '[]';;\n *) exit 0;;\nesac\n`.replace(/\\/g, '/'),
  );
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'step.sh'), stepScript('Deploy health.bicep'));
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin').replace(/\\/g, '/')}:${process.env.PATH}`, GITHUB_RUN_ID: '1', HUB_LOCATION: 'centralus', PF: 'x.bicepparam', ADMIN_GROUP: 'g' },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

const failedOp = (type, name, message) => ({
  properties: { provisioningState: 'Failed', targetResource: { resourceType: type, resourceName: name, id: `/subscriptions/s/resourceGroups/rg/providers/${type}/${name}` }, statusMessage: JSON.stringify({ error: { code: 'X', message } }) },
});

test('under bash -e a failed az create still reaches the classifier and names the nested zone error', () => {
  const r = runFailedApply({
    stderr: 'ERROR: DeploymentFailed: At least one resource deployment operation failed.\n',
    operations: [failedOp('Microsoft.ContainerService/managedClusters', 'aks-x', "AvailabilityZoneNotSupported: zone(s) '1' not supported")],
  });
  assert.notEqual(r.status, 0, 'a failed deploy must still fail the step');
  assert.match(r.out, /DeploymentFailed/, 'apply.err must be surfaced');
  assert.match(r.out, /FAILED-OPERATION Microsoft\.ContainerService\/managedClusters aks-x/, 'nested failed operation must be listed');
  assert.match(r.out, /::error::QUOTA\/CAPACITY\/REGION/, 'zone error must classify as region/capacity, not UNCLASSIFIED');
  assert.doesNotMatch(r.out, /UNCLASSIFIED/);
});

test('WAF body-size and Postgres version errors classify as template/region defects', () => {
  const waf = runFailedApply({
    stderr: 'ERROR: DeploymentFailed\n',
    operations: [failedOp('Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies', 'wafpol', "ApplicationGatewayFirewallInvalidMaxRequestBodySizeInKb: '2000000' is out of range")],
  });
  assert.match(waf.out, /::error::TEMPLATE\/PARAMETER defect/);
  assert.match(waf.out, /2000000/, 'the offending value must be in the error detail');
  const pg = runFailedApply({
    stderr: 'ERROR: DeploymentFailed\n',
    operations: [failedOp('Microsoft.DBforPostgreSQL/flexibleServers', 'pg', 'ParameterOutOfRange: Version should be in: []')],
  });
  assert.match(pg.out, /::error::QUOTA\/CAPACITY\/REGION/);
});
