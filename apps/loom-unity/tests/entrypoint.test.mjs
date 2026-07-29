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

// Authorization is DEFAULT-ON and FAIL-CLOSED, so every test that is about a
// NON-auth branch must pin an issuer + audience or the render exits 1 before it
// reaches the branch under test. This is the minimum "authorization is wired"
// env — the shape loom-unity-app.bicep emits with authMode=entra.
const AUTHZ_WIRED = {
  LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
  LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
};

test('no Postgres wired => the H2 fallback still renders (local dev / not-yet-provisioned)', { skip: !shAvailable }, () => {
  const r = render({ ...AUTHZ_WIRED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /org\.h2\.Driver/);
  assert.match(r.stdout, /jdbc:h2:file:.*\/h2db;DB_CLOSE_DELAY=-1/);
  // No ADLS vending block unless explicitly configured.
  assert.doesNotMatch(r.stdout, /adls\.storageAccountName/);
});

test('LU-1: the DEFAULT Postgres path is PASSWORDLESS — plugin + sslmode, no password line', { skip: !shAvailable }, () => {
  const r = render({
    ...AUTHZ_WIRED,
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://psql-loom-unity.postgres.database.usgovcloudapi.net:5432/unitycatalog',
    LOOM_UNITY_DB_USER: 'uami-loom-unity',
    AZURE_CLIENT_ID: 'uami-client-guid',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /org\.postgresql\.Driver/);
  assert.match(r.stdout, /hibernate\.connection\.username=uami-loom-unity/);
  assert.match(r.stdout, /sslmode=require/);
  assert.match(
    r.stdout,
    /authenticationPluginClassName=ai\.limitlessdata\.loom\.unity\.EntraPostgresAuthPlugin/,
  );
  // The whole point: with an Entra-only server there is NO password anywhere.
  assert.doesNotMatch(r.stdout, /hibernate\.connection\.password/);
  assert.doesNotMatch(r.stdout, /org\.h2\.Driver/);
  // Schema is created/updated by Hibernate on first boot — not a manual migration.
  assert.match(r.stdout, /hibernate\.hbm2ddl\.auto=update/);
});

test('LU-1: Postgres with no DB user FAILS CLOSED (Entra role name is mandatory)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: .*LOOM_UNITY_DB_USER is empty/);
});

test('LU-1: a missing AZURE_CLIENT_ID still boots but WARNS with the exact remediation', { skip: !shAvailable }, () => {
  const r = render({
    ...AUTHZ_WIRED,
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog',
    LOOM_UNITY_DB_USER: 'uami-loom-unity',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /AZURE_CLIENT_ID is unset/);
  assert.match(r.stderr, /unityUamiClientId/);
});

test('LU-1: an operator query string on the JDBC URL is preserved, not clobbered', { skip: !shAvailable }, () => {
  const r = render({
    ...AUTHZ_WIRED,
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog?ApplicationName=loom-unity&sslmode=verify-full',
    LOOM_UNITY_DB_USER: 'uami-loom-unity',
    AZURE_CLIENT_ID: 'uami-client-guid',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ApplicationName=loom-unity/);
  // sslmode already present => not appended a second time.
  assert.doesNotMatch(r.stdout, /sslmode=require/);
  assert.match(r.stdout, /sslmode=verify-full&authenticationPluginClassName=/);
});

test('LU-1: LOOM_UNITY_DB_AUTH=password is an explicit, warned BYO opt-out', { skip: !shAvailable }, () => {
  const r = render({
    ...AUTHZ_WIRED,
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog',
    LOOM_UNITY_DB_USER: 'uc',
    LOOM_UNITY_DB_AUTH: 'password',
    LOOM_UNITY_DB_PASSWORD: 'secret',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hibernate\.connection\.password=secret/);
  assert.doesNotMatch(r.stdout, /authenticationPluginClassName/);
  assert.match(r.stderr, /NOTICE: Postgres is using PASSWORD authentication/);
});

test('LU-1: password mode with no password FAILS CLOSED', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_DB_URL: 'jdbc:postgresql://pg.example:5432/unitycatalog',
    LOOM_UNITY_DB_USER: 'uc',
    LOOM_UNITY_DB_AUTH: 'password',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: LOOM_UNITY_DB_AUTH=password but LOOM_UNITY_DB_PASSWORD is empty/);
});

test('svc-loom-unity-authz: NOTHING wired => the server REFUSES to boot (never anonymous by default)', { skip: !shAvailable }, () => {
  const r = render({});
  // Before the svc-loom-unity-authz fix this rendered server.authorization=disable
  // and exited 0 — a bare `az deployment` that omitted one parameter produced a
  // catalog anything on the VNet could read AND mutate. The default is now
  // enable, so an unpinnable issuer aborts the boot with the exact remediation.
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /server\.authorization=disable/);
  assert.match(r.stderr, /FATAL: LOOM_UNITY_AUTH=enable but no token issuer is pinned/);
  assert.match(r.stderr, /LOOM_UNITY_ENTRA_TENANT_ID/);
});

test('svc-loom-unity-authz: a tenant with NO client id also fails closed (issuer alone is not authorization)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: LOOM_UNITY_AUTH=enable but no token audience is pinned/);
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

// svc-loom-unity-authz round 2 — the SEALED contract. compute/loom-unity-app.bicep
// and data-plane/iceberg-catalog-aca.bicep pin a sentinel `.invalid` audience when
// no Entra app registration exists yet, so the container comes UP with
// authorization enforced and rejects every caller instead of CrashLoopBackOff-ing
// (round 1) or serving anonymously (the original finding). This asserts the image
// honours that contract: enable + sentinel audience + NO client id must boot.
test('LU-2 (round 2): a pinned SENTINEL audience with no client id BOOTS, authorization enforced', { skip: !shAvailable }, () => {
  const sealed = 'api://loom-unity-sealed-abc123.invalid';
  const r = render({
    LOOM_UNITY_AUTH: 'enable',
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_AUDIENCES: sealed,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, new RegExp(`server\\.audiences=${sealed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stdout, /server\.allowed-issuers=https:\/\/login\.microsoftonline\.com\/tenant-guid\/v2\.0/);
  // No client id was supplied, so nothing derives a real audience.
  assert.match(r.stdout, /server\.client-id=\s*$/m);
  // And it is NOT the anonymous opt-out.
  assert.doesNotMatch(r.stdout, /server\.authorization=disable/);
  assert.doesNotMatch(r.stderr, /SECURITY WARNING: authorization is DISABLED/);
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
    ...AUTHZ_WIRED,
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
