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

test('no Entra tenant wired => authorization stays off but the boot WARNS loudly (LU-2)', { skip: !shAvailable }, () => {
  const r = render({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=disable/);
  // The open door is never silent: the operator sees the exact remediation.
  assert.match(r.stderr, /SECURITY WARNING: authorization is DISABLED/);
  assert.match(r.stderr, /LOOM_UNITY_ENTRA_TENANT_ID/);
});

test('LU-2: an Entra tenant + client id turn authorization ON and derive issuer/audience', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, /server\.authorization-url=https:\/\/login\.microsoftonline\.com\/tenant-guid\/oauth2\/v2\.0\/authorize/);
  assert.match(r.stdout, /server\.token-url=https:\/\/login\.microsoftonline\.com\/tenant-guid\/oauth2\/v2\.0\/token/);
  // Upstream v0.5.1 REQUIRES both when authorization is enabled (exact match).
  assert.match(r.stdout, /server\.allowed-issuers=https:\/\/login\.microsoftonline\.com\/tenant-guid\/v2\.0/);
  assert.match(r.stdout, /server\.audiences=api:\/\/client-guid,client-guid/);
  assert.doesNotMatch(r.stderr, /SECURITY WARNING/);
});

test('LU-2: the sovereign authority host flows into every derived Entra URL (Gov)', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
    LOOM_UNITY_AUTHORITY_HOST: 'login.microsoftonline.us',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.allowed-issuers=https:\/\/login\.microsoftonline\.us\/tenant-guid\/v2\.0/);
  // Assert on the PARSED hosts, not on a substring of the whole render.
  // Earlier revisions used doesNotMatch(/login\.microsoftonline\.com/) and then
  // !includes('login.microsoftonline.com'); CodeQL flagged both
  // (js/regex/missing-regexp-anchor, then js/incomplete-url-substring-sanitization)
  // because a bare hostname substring-checked against a URL is the shape of a
  // broken sanitizer. Both were false positives HERE - the intent is absence,
  // not validation - but rather than suppress the rule, extract every URL the
  // entrypoint rendered and compare its host EXACTLY. That is structurally
  // unambiguous and a strictly stronger guarantee: it would also catch a
  // sovereign-boundary leak like `login.microsoftonline.us.evil.example`,
  // which a substring check would have happily accepted.
  const renderedHosts = [...r.stdout.matchAll(/https:\/\/([^/\s]+)/g)].map((m) => m[1]);
  assert.ok(renderedHosts.length > 0, 'expected the Gov render to emit at least one URL');
  for (const host of renderedHosts) {
    assert.equal(
      host,
      'login.microsoftonline.us',
      `Gov render leaked a non-sovereign Entra host: ${host}`,
    );
  }
});

test('LU-2: authorization=enable with no pinned issuer FAILS CLOSED (never boots half-secured)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_UNITY_AUTH: 'enable' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: LOOM_UNITY_AUTH=enable but no token issuer is pinned/);
});

test('LU-2: authorization=enable with an issuer but no audience FAILS CLOSED', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_AUTH: 'enable',
    LOOM_UNITY_ALLOWED_ISSUERS: 'https://login.microsoftonline.us/tenant-guid/v2.0',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: LOOM_UNITY_AUTH=enable but no token audience is pinned/);
});

test('LU-2: LOOM_UNITY_AUTH=disable is an explicit, warned opt-out even with a tenant wired', { skip: !shAvailable }, () => {
  const r = render({ LOOM_UNITY_AUTH: 'disable', LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=disable/);
  assert.match(r.stderr, /SECURITY WARNING: authorization is DISABLED/);
});

test('explicit IdP endpoints still win over the derived Entra ones', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_AUTH: 'enable',
    LOOM_UNITY_AUTHORIZATION_URL: 'https://login.example/authorize',
    LOOM_UNITY_TOKEN_URL: 'https://login.example/token',
    LOOM_UNITY_ALLOWED_ISSUERS: 'https://login.example',
    LOOM_UNITY_AUDIENCES: 'api://loom-unity',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, /server\.authorization-url=https:\/\/login\.example\/authorize/);
  assert.match(r.stdout, /server\.token-url=https:\/\/login\.example\/token/);
  assert.match(r.stdout, /server\.audiences=api:\/\/loom-unity/);
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
