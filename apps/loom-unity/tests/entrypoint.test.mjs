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
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'bin', 'loom-entrypoint.sh');
const FIXTURES = path.join(__dirname, 'fixtures');
const DISCOVERY_COMMERCIAL = path.join(FIXTURES, 'discovery-commercial');
const DISCOVERY_GOV = path.join(FIXTURES, 'discovery-gov');

/**
 * Every host a GOVERNMENT render is permitted to emit: the sovereign authority
 * host, plus the v1.0 issuer host the Gov fixture publishes. Deliberately an
 * ALLOW-LIST — see the reasoning at its use site.
 */
const GOV_ALLOWED_HOSTS = new Set(['login.microsoftonline.us', 'sovereign-sts.invalid']);

/** Every `https://host` the render emitted, parsed — never substring-matched. */
export function renderedHosts(stdout) {
  return [...stdout.matchAll(/https:\/\/([^/\s]+)/g)].map((m) => m[1]);
}

/**
 * Assert every rendered host is EXACTLY one of `allowed`.
 *
 * Shared by the Gov sovereignty test and the lookalike test below, so the
 * lookalike cases exercise the real predicate rather than a re-implementation
 * of it that could drift into being correct while the real one is not.
 */
function assertHostsAllowed(stdout, allowed) {
  const hosts = renderedHosts(stdout);
  assert.ok(hosts.length > 0, 'expected the render to emit at least one URL');
  for (const host of hosts) {
    assert.ok(
      allowed.has(host),
      `render emitted a host outside the sovereign boundary: ${host} `
        + `(allowed: ${[...allowed].join(', ')})`,
    );
  }
}

function render(env) {
  return spawnSync('sh', [SCRIPT], {
    env: {
      ...process.env,
      LOOM_UNITY_DRYRUN: '1',
      // Issuers are derived from OIDC discovery (F1/RC-9), so EVERY render that
      // wires a tenant would otherwise reach the live IdP — making the whole
      // suite network-dependent, slow (~28s per test on a blocked egress) and
      // flaky. Default every test to the offline fixtures; individual tests
      // override this, and the fail-closed tests deliberately unset it to
      // exercise the real fetch.
      LOOM_UNITY_DISCOVERY_DOC_DIR: DISCOVERY_COMMERCIAL,
      ...env,
    },
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
  // Issuers are DERIVED FROM OIDC DISCOVERY (F1/RC-9). Point every test at the
  // offline fixtures so the suite stays deterministic and never touches the
  // network — the fail-closed path is proven separately, WITHOUT this seam.
  LOOM_UNITY_DISCOVERY_DOC_DIR: DISCOVERY_COMMERCIAL,
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
  // BOTH spellings, mandatorily (finishline D2, root-caused live on Commercial):
  // Hibernate reads `.username`; upstream JCasbinAuthorizer reads `.user`
  // verbatim to build its casbin JDBCAdapter. Rendering only `.username` made
  // the authorizer connect as user=null (the OS user, no such role on the
  // Entra-only server) and the boot died with the cause-swallowed
  // "Problem initializing authorizer."
  assert.match(r.stdout, /hibernate\.connection\.user=uami-loom-unity/);
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
  // BOTH issuer forms, taken VERBATIM from the tenant's own OIDC discovery
  // documents (F1/RC-9). Entra emits the version the RESOURCE app requests, and
  // the Console app registration has requestedAccessTokenVersion=null => v1.0
  // tokens. Deriving only the v2.0 form made the catalog answer every real
  // token 401 "Invalid issuer".
  assert.match(
    r.stdout,
    /server\.allowed-issuers=https:\/\/sts\.windows\.net\/tenant-guid\/,https:\/\/login\.microsoftonline\.com\/tenant-guid\/v2\.0/,
  );
  assert.match(r.stdout, /server\.audiences=api:\/\/client-guid,client-guid/);
  assert.doesNotMatch(r.stderr, /SECURITY WARNING/);
});

test('LU-2: the sovereign authority host flows into every derived Entra URL (Gov)', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
    LOOM_UNITY_AUTHORITY_HOST: 'login.microsoftonline.us',
    LOOM_UNITY_DISCOVERY_DOC_DIR: DISCOVERY_GOV,
  });
  assert.equal(r.status, 0, r.stderr);
  // Gov issuers come out CORRECT without this repo knowing what they are: they
  // are read verbatim from the sovereign tenant's own discovery documents. The
  // v1 fixture uses a deliberately synthetic host precisely to prove the code
  // never infers the value (cloud-parity.md: supply the equivalent, do not ship
  // Commercial-first). And no Commercial STS hostname may leak into a sovereign
  // deployment's trusted issuers.
  const govIssuers = r.stdout.match(/server\.allowed-issuers=(.*)/)[1];
  assert.equal(
    govIssuers,
    'https://sovereign-sts.invalid/tenant-guid/,https://login.microsoftonline.us/tenant-guid/v2.0',
  );
  // Assert on the PARSED hosts, never on a substring of the whole render.
  // A bare hostname matched against a URL is the shape of a broken sanitizer
  // (CodeQL: js/regex/missing-regexp-anchor, js/incomplete-url-substring-sanitization),
  // and the shape is flagged because it is genuinely wrong: an unanchored
  // pattern matches anywhere, so arbitrary labels may precede or follow it.
  //
  // THIS MUST BE AN ALLOW-LIST, AND THAT IS NOT A STYLE CHOICE.
  //
  // A previous revision of this test used a DENY-list — `!COMMERCIAL_HOSTS.has(host)`
  // — with a comment claiming it "still catches login.microsoftonline.us.evil.example
  // because the comparison is on the PARSED host". That claim was FALSE, and
  // measuring it is what caught it:
  //
  //     ACCEPTED  login.microsoftonline.us.evil.example
  //     ACCEPTED  evil.login.microsoftonline.us
  //     ACCEPTED  login.microsoftonline.com.evil.example   <-- a COMMERCIAL lookalike
  //     REJECTED  login.microsoftonline.com
  //
  // A deny-list cannot catch a lookalike by construction: the lookalike is not
  // the denied string, so it passes. Parsing the host correctly does not help —
  // it is the PREDICATE that was wrong, not the parsing. Only enumerating what
  // is ALLOWED rejects everything else, which is what a sovereignty boundary
  // needs.
  assertHostsAllowed(r.stdout, GOV_ALLOWED_HOSTS);
  // The authority-derived URLs (authorize/token) must still be sovereign — those
  // ARE built from the authority host, so the original exact-match still applies
  // to them.
  const authorityUrls = [...r.stdout.matchAll(/server\.(?:authorization|token)-url=https:\/\/([^/\s]+)/g)].map((m) => m[1]);
  assert.equal(authorityUrls.length, 2, 'expected both authority-derived URLs');
  for (const host of authorityUrls) {
    assert.equal(host, 'login.microsoftonline.us', `authority-derived URL is not sovereign: ${host}`);
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
  // Issuers now come from discovery (F1/RC-9), so both forms are present — the
  // point of THIS test is the audience/client-id branch, not the issuer string.
  assert.match(
    r.stdout,
    /server\.allowed-issuers=https:\/\/sts\.windows\.net\/tenant-guid\/,https:\/\/login\.microsoftonline\.com\/tenant-guid\/v2\.0/,
  );
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

// ── #2643 AUTO-BIND ─────────────────────────────────────────────────────────
// Enforcing authorization is only half a working catalog. Upstream
// AuthService.verifyPrincipal resolves the caller from the subject token's
// `email` claim, falling back to `sub`; an Entra APP-ONLY token has no `email`,
// so the subject is the principal's OBJECT ID, which must exist as an ENABLED
// Unity Catalog user or the token exchange answers 401. Without that step,
// turning authorization on produces a catalog that is correct-but-unusable —
// which is exactly why gov-uc-purview-wire.yml kept deploying authMode=disabled.
// The entrypoint therefore registers the principal itself, using the server's
// own admin token (auto-bind-by-default.md §5).

const PRINCIPAL = '11111111-2222-3333-4444-555555555555';

test('#2643 auto-bind: an enforced catalog with a principal id BINDS it', { skip: !shAvailable }, () => {
  const r = render({ ...AUTHZ_WIRED, LOOM_UNITY_CONSOLE_PRINCIPAL_ID: PRINCIPAL });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, new RegExp(`console-principal-bind=bind:${PRINCIPAL}`));
});

test('#2643 auto-bind: an enforced catalog with NO principal id is announced, not silent', { skip: !shAvailable }, () => {
  // Correct-but-unusable is a real state and must be visible: authorization is
  // enforced, but only `admin` / pre-registered users can call the catalog.
  const r = render({ ...AUTHZ_WIRED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, /console-principal-bind=not-configured/);
  assert.match(r.stderr, /no LOOM_UNITY_CONSOLE_PRINCIPAL_ID was passed/);
});

test('#2643 auto-bind: a non-GUID principal id is REFUSED, not interpolated into the SCIM body', { skip: !shAvailable }, () => {
  // The id is interpolated into a JSON request body, so a value carrying a quote
  // would break out of the string. Shape-validating it is cheaper than escaping
  // and makes the misconfiguration (e.g. passing the clientId, or a resource id)
  // obvious instead of producing a confusing server-side error.
  const r = render({ ...AUTHZ_WIRED, LOOM_UNITY_CONSOLE_PRINCIPAL_ID: 'not-a-guid","active":false,"x":"' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /console-principal-bind=invalid-principal-id/);
  assert.doesNotMatch(r.stdout, /console-principal-bind=bind:/);
  assert.match(r.stderr, /not an Entra object id/);
});

test('#2643 auto-bind: nothing to bind when authorization is the audited disable opt-out', { skip: !shAvailable }, () => {
  const r = render({ LOOM_UNITY_AUTH: 'disable', LOOM_UNITY_CONSOLE_PRINCIPAL_ID: PRINCIPAL });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /console-principal-bind=authorization-disabled/);
});

// ── RC-12 WAREHOUSE AUTO-BIND ───────────────────────────────────────────────
// data-plane/iceberg-catalog-aca.bicep has always emitted LOOM_ICEBERG_WAREHOUSE
// and NOTHING read it — `grep -ci warehouse` over the entrypoint returned 0. So
// the deployment declared a warehouse and never created the object. Creating a
// Loom item must PROVISION AND BIND its backing object
// (.claude/rules/auto-bind-by-default.md §1), and the PLATFORM must do it (§5).
//
// The plan is pinned the same way console_bind_plan is: a provisioning decision
// only exercisable on a live container is one nobody notices has stopped
// happening. The live half is proven by tests/authz/iceberg-e2e.sh.

test('RC-12 warehouse: a wired warehouse plans to PROVISION it', { skip: !shAvailable }, () => {
  const r = render({ ...AUTHZ_WIRED, LOOM_ICEBERG_WAREHOUSE: 'loom' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warehouse-bind=provision:loom/);
});

test('RC-12 warehouse: the sibling loom-unity app (no warehouse) provisions nothing', { skip: !shAvailable }, () => {
  // Only the iceberg-catalog deployment carries LOOM_ICEBERG_WAREHOUSE. The
  // general Unity app must not start inventing catalogs.
  const r = render({ ...AUTHZ_WIRED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warehouse-bind=not-configured/);
  assert.doesNotMatch(r.stdout, /warehouse-bind=provision:/);
});

test('RC-12 warehouse: a non-identifier name is REFUSED, not interpolated', { skip: !shAvailable }, () => {
  // The value lands in a JSON body AND a URL path, so shape-validate rather than
  // escape — same reasoning as the principal id above.
  const r = render({ ...AUTHZ_WIRED, LOOM_ICEBERG_WAREHOUSE: 'loom","x":"y' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warehouse-bind=invalid-warehouse-name/);
  assert.doesNotMatch(r.stdout, /warehouse-bind=provision:/);
  assert.match(r.stderr, /not a valid Unity Catalog identifier/);
});

test('RC-12 warehouse: the LIST-namespaces defect is STATED, not left to be rediscovered', { skip: !shAvailable }, () => {
  // MEASURED: GET <irc>/v1/catalogs/<wh>/namespaces answers 500 on this image for
  // EVERY principal (including the metastore owner). A known ceiling stated on
  // every boot beats a 500 rediscovered from a browser.
  const r = render({ ...AUTHZ_WIRED, LOOM_ICEBERG_WAREHOUSE: 'loom' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ICEBERG-LIST-NAMESPACES-DEFECT/);
  assert.match(r.stderr, /Authorization filter not initialized/);
  // It must name the CONTROL, not just the symptom — that is what makes it a
  // diagnosis rather than a shrug. The control is the AUTHORIZATION FLAG.
  assert.match(r.stderr, /authorization DISABLED returns 200/);
  // And it must NOT re-assert the cause we disproved on 2026-08-10. The overlay
  // was blamed on a two-variable "control"; measured with one variable (overlay
  // removed, authorization still enabled) the 500 is unchanged. An error string
  // that names a cause the code never established is a deploy-integrity R7
  // violation, so this assertion keeps the retraction from silently regressing.
  assert.match(r.stderr, /NOT caused by the #1603 overlay/);
  assert.doesNotMatch(r.stderr, /Cause: the v0\.5\.1 unitycatalog-server overlay/);
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

// ── #2643 follow-up: the IdP-reachability probe ────────────────────────────
//
// With authorization ON, upstream fetches the issuer's JWKS over the network on
// every verification it cannot serve from cache. If the Container Apps subnet
// cannot egress to the authority host, the catalog refuses EVERY caller — and
// from outside that is indistinguishable from "correctly enforcing", because
// both answer 401 to an anonymous read. The boot-time probe states which one it
// is on a line the deploy gates on, so these tests pin the DECISION the same way
// the auto-bind tests pin theirs: a probe only exercisable on a live container is
// a probe nobody notices has stopped running.

test('#2643 probe: an enforced Gov catalog plans to probe the SOVEREIGN authority host', { skip: !shAvailable }, () => {
  const r = render({ ...AUTHZ_WIRED, LOOM_UNITY_AUTHORITY_HOST: 'login.microsoftonline.us' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.authorization=enable/);
  assert.match(r.stdout, /idp-reachability=probe:login\.microsoftonline\.us/);
});

test('#2643 probe: Commercial derives login.microsoftonline.com — the host is never hard-coded', { skip: !shAvailable }, () => {
  const r = render({ ...AUTHZ_WIRED });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /idp-reachability=probe:login\.microsoftonline\.com/);
});

test('#2643 probe: the marker carries the HOST ONLY — no Entra tenant id leaks into CI logs', { skip: !shAvailable }, () => {
  // This line is read back through GitHub Actions logs by
  // .github/workflows/gov-uc-purview-wire.yml. The issuer embeds the tenant id;
  // the marker must not. Asserting the absence is the point of the test — the
  // obvious "simplification" (echo the whole issuer) is what it prevents.
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: TENANT,
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
    LOOM_UNITY_AUTHORITY_HOST: 'login.microsoftonline.us',
  });
  assert.equal(r.status, 0, r.stderr);
  const marker = r.stdout.split('\n').find((l) => l.startsWith('idp-reachability='));
  assert.ok(marker, 'no idp-reachability marker rendered');
  assert.equal(marker, 'idp-reachability=probe:login.microsoftonline.us');
  assert.ok(!marker.includes(TENANT), `tenant id leaked into the probe marker: ${marker}`);
});

test('#2643 probe: an EXPLICIT issuer list is honoured, first entry wins', { skip: !shAvailable }, () => {
  // `server.allowed-issuers` is a comma list. The first entry is the issuer this
  // deployment mints against, so it is the one whose keys must be fetchable.
  const r = render({
    LOOM_UNITY_AUTH: 'enable',
    LOOM_UNITY_ALLOWED_ISSUERS: 'https://sts.example.gov/abc/v2.0,https://other.example/v2.0',
    LOOM_UNITY_AUDIENCES: 'api://loom-unity',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /idp-reachability=probe:sts\.example\.gov/);
  assert.doesNotMatch(r.stdout, /idp-reachability=probe:other\.example/);
});

test('#2643 probe: the audited disable opt-out has nothing to reach', { skip: !shAvailable }, () => {
  // No token is ever verified, so no JWKS is ever fetched. Reporting a network
  // finding here would be noise, and — worse — a deploy gating on "ok" would
  // then block the documented opt-out.
  const r = render({ LOOM_UNITY_AUTH: 'disable' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /idp-reachability=skipped-authorization-disabled/);
});


// ---------------------------------------------------------------------------
// RC-9 — issuers are DERIVED from the tenant's OIDC discovery, never hardcoded.
// ---------------------------------------------------------------------------

test('RC-9: issuers are taken VERBATIM from discovery, not reconstructed', { skip: !shAvailable }, () => {
  // Non-vacuity for the two per-cloud assertions above: the code must not be
  // rebuilding a well-known string that merely happens to match the fixture.
  // These fixture issuers are shaped nothing like Entra's, so only a verbatim
  // read can produce them.
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-disc-'));
  writeFileSync(path.join(dir, 'v1.json'), JSON.stringify({ issuer: 'https://v1.example.test/ANY-STRING/' }));
  writeFileSync(path.join(dir, 'v2.json'), JSON.stringify({ issuer: 'https://v2.example.test/ANY-STRING/v9.9' }));

  const r = render({ ...AUTHZ_WIRED, LOOM_UNITY_DISCOVERY_DOC_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const issuers = r.stdout.match(/server\.allowed-issuers=(.*)/)[1];
  assert.equal(issuers, 'https://v1.example.test/ANY-STRING/,https://v2.example.test/ANY-STRING/v9.9');
});

test('RC-9: an UNREACHABLE discovery endpoint FAILS CLOSED (no empty/partial allow-list)', { skip: !shAvailable }, () => {
  // No test seam here, deliberately: this exercises the REAL fetch path against
  // an unroutable authority, so the fail-closed behaviour is proven by the code
  // that actually runs in production.
  //
  // An unreachable metadata endpoint is an UNKNOWN. Booting with an empty or
  // half-filled issuer list would either wedge every call or open the door —
  // and "UNKNOWN read as fine" is this program's most expensive defect class.
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
    // RFC 5737 TEST-NET-1 — guaranteed unroutable, so this fails fast rather
    // than resolving to somebody's host.
    LOOM_UNITY_AUTHORITY_HOST: '192.0.2.1',
    LOOM_UNITY_DISCOVERY_RETRIES: '1',
    LOOM_UNITY_DISCOVERY_DOC_DIR: '',   // unset the offline seam: real fetch
  });
  assert.notEqual(r.status, 0, 'must refuse to boot when discovery cannot be reached');
  assert.match(r.stderr, /token issuers could not be derived/);
  assert.match(r.stderr, /openid-configuration/);
  assert.doesNotMatch(r.stdout, /server\.allowed-issuers=\s*$/m);
});

test('RC-9: a discovery document with NO issuer field FAILS CLOSED', { skip: !shAvailable }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-disc-'));
  writeFileSync(path.join(dir, 'v1.json'), JSON.stringify({ jwks_uri: 'https://x.test/keys' }));
  writeFileSync(path.join(dir, 'v2.json'), JSON.stringify({ issuer: 'https://v2.example.test/t/v2.0' }));

  const r = render({ ...AUTHZ_WIRED, LOOM_UNITY_DISCOVERY_DOC_DIR: dir });
  assert.notEqual(r.status, 0, 'a document without an issuer must not boot');
  assert.match(r.stderr, /token issuers could not be derived/);
});

test('RC-9: LOOM_UNITY_ALLOWED_ISSUERS still overrides discovery entirely', { skip: !shAvailable }, () => {
  // The documented escape hatch must keep working — it is the only way a
  // sovereign or air-gapped deployment pins issuers without reaching an IdP.
  const r = render({
    LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
    LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
    LOOM_UNITY_AUTHORITY_HOST: '192.0.2.1', // unreachable: proves discovery is not consulted
    LOOM_UNITY_DISCOVERY_DOC_DIR: '',       // and the seam is off too
    LOOM_UNITY_ALLOWED_ISSUERS: 'https://pinned.example.test/t/v2.0',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /server\.allowed-issuers=https:\/\/pinned\.example\.test\/t\/v2\.0/);
});

test('RC-9: no cloud-specific issuer hostname is baked into the script', () => {
  // The guard for the mistake this fix replaced: an earlier revision appended a
  // literal Commercial "sts.windows.net" issuer, and did it only for the
  // Commercial authority — which left Gov on the broken v2-only path. Discovery
  // removed the need for any such literal, so CODE must contain none.
  //
  // Comments are stripped before matching: the rationale above the derivation
  // legitimately NAMES these hosts, and prose is not configuration.
  const src = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // Only ISSUER-shaped hostnames. `login.microsoftonline.{com,us}` are AUTHORITY
  // hosts — the .com default is the documented Commercial default that bicep
  // overrides per-cloud, and the .us mention lives inside an operator-facing
  // egress diagnostic. Neither constructs an issuer. `sts.windows.*` has no
  // legitimate reason to appear in code at all: it is purely an issuer host, and
  // a literal one is exactly the mistake this fix replaced.
  // `includes`, not a constructed RegExp. Building one from a hostname needs the
  // dots escaped (an unescaped `.` matches any character, so the rule stops
  // stating what it means) and the escaper itself then has to handle backslashes
  // — CodeQL flagged both on the previous version (js/incomplete-hostname-regexp,
  // js/incomplete-sanitization). A literal substring search needs no escaping at
  // all and is exactly the question being asked: does this text appear in the
  // source?
  for (const host of ['sts.windows.net', 'sts.windows.us']) {
    assert.ok(
      !src.includes(host),
      `'${host}' is hardcoded in entrypoint CODE. Issuer values must come from the `
        + 'tenant OIDC discovery documents, so no cloud is special-cased.',
    );
  }
});


test('RC-9: a LOOKALIKE host is rejected, not merely a known-bad one', { skip: !shAvailable }, () => {
  // The property the sovereignty check exists for, pinned explicitly rather than
  // implied by a comment.
  //
  // MEASURED BEFORE THIS FIX, with the deny-list predicate this test replaced:
  //     ACCEPTED  login.microsoftonline.us.evil.example
  //     ACCEPTED  evil.login.microsoftonline.us
  //     ACCEPTED  login.microsoftonline.com.evil.example
  // All three now REJECT. So this is a live fix, not defence-in-depth: the check
  // had stopped doing the job it was kept for, and its comment asserted
  // otherwise.
  //
  // Driven through a POISONED FIXTURE — a real render whose discovery document
  // publishes the lookalike — so the whole path is exercised: fetch, verbatim
  // extraction, render, and the host predicate. Asserting on the predicate alone
  // would prove only that a Set works.
  for (const evil of [
    'login.microsoftonline.us.evil.example',   // suffix: the classic boundary escape
    'evil.login.microsoftonline.us',           // prefix
    'login.microsoftonline.com.evil.example',  // a COMMERCIAL lookalike
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'loom-evil-'));
    writeFileSync(path.join(dir, 'v1.json'), JSON.stringify({ issuer: `https://${evil}/tenant-guid/` }));
    writeFileSync(
      path.join(dir, 'v2.json'),
      JSON.stringify({ issuer: 'https://login.microsoftonline.us/tenant-guid/v2.0' }),
    );

    const r = render({
      LOOM_UNITY_ENTRA_TENANT_ID: 'tenant-guid',
      LOOM_UNITY_ENTRA_CLIENT_ID: 'client-guid',
      LOOM_UNITY_AUTHORITY_HOST: 'login.microsoftonline.us',
      LOOM_UNITY_DISCOVERY_DOC_DIR: dir,
    });
    assert.equal(r.status, 0, r.stderr);

    // The render SUCCEEDS — the entrypoint trusts whatever the tenant publishes,
    // which is correct; a compromised discovery document is a different threat.
    // What must hold is that this TEST refuses to call such a render sovereign.
    assert.throws(
      () => assertHostsAllowed(r.stdout, GOV_ALLOWED_HOSTS),
      /outside the sovereign boundary/,
      `lookalike host '${evil}' was accepted as sovereign`,
    );
  }
});
