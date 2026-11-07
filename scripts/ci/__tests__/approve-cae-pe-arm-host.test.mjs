// Gov run 42335318755: approve-cae-private-endpoints.sh called management.azure.com from an
// AzureUSGovernment session and got `SubscriptionNotFound`. The ARM host must come from the
// active cloud. A fake `az` records every URL the script calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/csa-loom/approve-cae-private-endpoints.sh');
const CAE = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae-x';
const CONN = `${CAE}/privateEndpointConnections/c1`;
const GOV = 'https://management.usgovcloudapi.net';

function run({ cloudShowFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeaz-'));
  const log = path.join(dir, 'calls.log');
  const state = path.join(dir, 'approved');
  const fake = [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${log.replace(/\\/g, '/')}"`,
    'if [ "$1 $2" = "cloud show" ]; then',
    cloudShowFails ? '  echo boom >&2; exit 1' : `  echo "${GOV}/"; exit 0`,
    'fi',
    'if [ "$1" = "rest" ] && [ "$3" = "get" ]; then',
    `  if [ -f "${state.replace(/\\/g, '/')}" ]; then echo '{"value":[{"id":"${CONN}","properties":{"privateLinkServiceConnectionState":{"status":"Approved"}}}]}';`,
    `  else echo '{"value":[{"id":"${CONN}","properties":{"privateLinkServiceConnectionState":{"status":"Pending"}}}]}'; fi; exit 0`,
    'fi',
    `if [ "$1" = "rest" ] && [ "$3" = "put" ]; then touch "${state.replace(/\\/g, '/')}"; exit 0; fi`,
    'exit 0',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'az'), fake, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, '--cae-id', CAE, '--timeout-seconds', '5', '--interval-seconds', '1'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, RM_ENDPOINT: '' },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { r, calls };
}

test('the list and the approve PUT both go to the ACTIVE cloud ARM host, never management.azure.com', () => {
  const { r, calls } = run();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // Positive: both verbs reached the Gov host. Breaks if either URL is hardcoded back.
  assert.match(calls, new RegExp(`rest --method get --url ${GOV}${CAE}/privateEndpointConnections`));
  assert.match(calls, new RegExp(`rest --method put --url ${GOV}${CONN}`));
  assert.ok(!calls.includes('management.azure.com'), `a call still used management.azure.com:\n${calls}`);
});

test('an unreadable cloud endpoint fails closed instead of defaulting to a host', () => {
  const { r, calls } = run({ cloudShowFails: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /could not read the active cloud's Resource Manager endpoint/);
  assert.ok(!/rest --method/.test(calls), `no ARM call may be made without a host:\n${calls}`);
});
