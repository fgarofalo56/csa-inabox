// Unit tests for the loom-unity entrypoint config rendering.
//
// Runs bin/loom-entrypoint.sh in LOOM_UNITY_DRYRUN mode (renders config to
// stdout and exits without starting the JVM) and asserts the persistence + auth
// + ADLS-vending branches produce the right properties. This is the testable
// core of the packaging — no running server required.
//
// Skips automatically when a POSIX `sh` is unavailable (e.g. a bare Windows
// shell), so it is a no-op rather than a false failure off-Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'bin', 'loom-entrypoint.sh');

function render(env) {
  return spawnSync('sh', [SCRIPT], {
    env: { ...process.env, LOOM_UNITY_DRYRUN: '1', ...env },
    encoding: 'utf8',
  });
}

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

test('default persistence is the H2 file DB (no external DB required)', { skip: !shAvailable }, () => {
  const r = render({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /org\.h2\.Driver/);
  assert.match(r.stdout, /jdbc:h2:file:.*\/h2db;DB_CLOSE_DELAY=-1/);
  // Auth disabled by default (internal-ingress network boundary, like loom-onelake).
  assert.match(r.stdout, /server\.authorization=disable/);
  // No ADLS vending block unless explicitly configured.
  assert.doesNotMatch(r.stdout, /adls\.storageAccountName/);
});

test('LOOM_UNITY_DB_URL=jdbc:postgresql routes persistence to Postgres', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog',
    LOOM_UNITY_DB_USER: 'uc',
    LOOM_UNITY_DB_PASSWORD: 'secret',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /org\.postgresql\.Driver/);
  assert.match(r.stdout, /jdbc:postgresql:\/\/pg\.example:5432\/unitycatalog/);
  assert.match(r.stdout, /hibernate\.connection\.username=uc/);
  assert.doesNotMatch(r.stdout, /org\.h2\.Driver/);
});

test('LOOM_UNITY_AUTH=enable turns on the OAuth/OIDC authorization server', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_AUTH: 'enable',
    LOOM_UNITY_AUTHORIZATION_URL: 'https://login.example/authorize',
    LOOM_UNITY_TOKEN_URL: 'https://login.example/token',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, /server\.authorization-url=https:\/\/login\.example\/authorize/);
  assert.match(r.stdout, /server\.token-url=https:\/\/login\.example\/token/);
});

test('ADLS credential-vending block renders only when an account is configured', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_ADLS_ACCOUNT: 'dlzlake01',
    LOOM_UNITY_ADLS_TENANT: 'tenant-guid',
    LOOM_UNITY_ADLS_CLIENT_ID: 'client-guid',
    LOOM_UNITY_ADLS_CLIENT_SECRET: 'shh',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /adls\.storageAccountName\.0=dlzlake01/);
  assert.match(r.stdout, /adls\.tenantId\.0=tenant-guid/);
  assert.match(r.stdout, /adls\.clientId\.0=client-guid/);
});
