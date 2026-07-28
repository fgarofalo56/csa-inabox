// Unit tests for the loom-sharing entrypoint config rendering (LU-9).
//
// Runs bin/loom-sharing-entrypoint.sh in LOOM_SHARING_DRYRUN mode (renders the
// config to stdout and exits without starting the JVM) and asserts the
// fail-closed branches actually fail and the happy branches render what the
// upstream server expects. This is the testable core of the packaging — no
// running server required.
//
// Skips automatically when a POSIX `sh` is unavailable (e.g. a bare Windows
// shell), so it is a no-op rather than a false failure off-Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'bin', 'loom-sharing-entrypoint.sh');

function render(env) {
  return spawnSync('sh', [SCRIPT], {
    env: { ...process.env, LOOM_SHARING_DRYRUN: '1', ...env },
    encoding: 'utf8',
  });
}

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('no bearer => FAILS CLOSED (an unauthenticated sharing server exposes every share)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: '' });
  assert.notEqual(r.status, 0, 'a config with no bearer must not render');
  assert.match(r.stderr, /LOOM_SHARING_BEARER is empty/);
  // The dangerous outcome this guards against: a rendered config with no
  // authorization block at all.
  assert.doesNotMatch(r.stdout, /version:\s*1/);
});

test('bearer set => the authorization block is rendered and the server binds all interfaces', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: 'server-minted-token' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^version: 1$/m);
  assert.match(r.stdout, /^authorization:$/m);
  assert.match(r.stdout, /bearerToken: "server-minted-token"/);
  // Container ingress terminates on 0.0.0.0; upstream's default is localhost,
  // which would make the app answer only itself and fail every ACA probe.
  assert.match(r.stdout, /host: "0\.0\.0\.0"/);
});

test('no shares wired => an EMPTY share list, not an error (a fresh deployment is not a gate)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: 't' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^shares: \[\]$/m);
});

test('LOOM_SHARING_SHARES_B64 is decoded into the config verbatim', { skip: !shAvailable }, () => {
  const yaml = [
    'shares:',
    '- name: "fin-quarterly"',
    '  schemas:',
    '  - name: "gold"',
    '    tables:',
    '    - name: "revenue"',
    '      location: "abfss://lake@stloom.dfs.core.usgovcloudapi.net/gold/revenue"',
    '      id: "11111111-1111-1111-1111-111111111111"',
  ].join('\n');
  const r = render({ LOOM_SHARING_BEARER: 't', LOOM_SHARING_SHARES_B64: b64(yaml) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /name: "fin-quarterly"/);
  assert.match(r.stdout, /abfss:\/\/lake@stloom\.dfs\.core\.usgovcloudapi\.net\/gold\/revenue/);
  assert.doesNotMatch(r.stdout, /^shares: \[\]$/m);
});

test('a corrupt shares payload FAILS the boot instead of silently serving nothing', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: 't', LOOM_SHARING_SHARES_B64: '!!!not-base64!!!' });
  assert.notEqual(r.status, 0, 'a mangled manifest must not degrade to an empty share list');
  assert.match(r.stderr, /not valid base64/);
});

test('ADLS account with an incomplete OAuth principal FAILS CLOSED', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_SHARING_BEARER: 't',
    LOOM_SHARING_ADLS_ACCOUNT: 'stloomgov',
    LOOM_SHARING_ADLS_TENANT: 'tenant-guid',
    // client id + secret deliberately missing
  });
  assert.notEqual(r.status, 0, 'a half-configured storage principal must not boot');
  assert.match(r.stderr, /OAuth principal is incomplete/);
});

test('ADLS OAuth renders per-account hadoop properties for the SOVEREIGN endpoint', { skip: !shAvailable }, () => {
  const r = render({
    LOOM_SHARING_BEARER: 't',
    LOOM_SHARING_ADLS_ACCOUNT: 'stloomgov',
    LOOM_SHARING_ADLS_SUFFIX: 'dfs.core.usgovcloudapi.net',
    LOOM_SHARING_AUTHORITY_HOST: 'login.microsoftonline.us',
    LOOM_SHARING_ADLS_TENANT: 'tenant-guid',
    LOOM_SHARING_ADLS_CLIENT_ID: 'client-guid',
    LOOM_SHARING_ADLS_CLIENT_SECRET: 'shhh',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fs\.azure\.account\.auth\.type\.stloomgov\.dfs\.core\.usgovcloudapi\.net<\/name>\s*<value>OAuth/);
  assert.match(r.stdout, /ClientCredsTokenProvider/);
  assert.match(
    r.stdout,
    /<value>https:\/\/login\.microsoftonline\.us\/tenant-guid\/oauth2\/token<\/value>/,
  );
  // A Commercial authority leaking into a Gov deployment is a sovereignty bug.
  //
  // Checked by parsing every URL out of the render and comparing HOSTS exactly.
  // Neither an unanchored regex (js/regex/missing-regexp-anchor) nor a substring
  // test (js/incomplete-url-substring-sanitization) is a sound way to reason
  // about a URL, and both are CodeQL-HIGH on a data-egress surface — so do the
  // thing they are telling us to do and compare the parsed host.
  const renderedHosts = [...r.stdout.matchAll(/https:\/\/[^<\s"']+/g)].map((m) => {
    try {
      return new URL(m[0]).host.toLowerCase();
    } catch {
      return '';
    }
  });
  assert.ok(
    renderedHosts.length > 0,
    'no authority URL was rendered at all — the OAuth config is missing',
  );
  assert.ok(
    !renderedHosts.includes('login.microsoftonline.com'),
    `a Commercial Entra authority leaked into a Gov core-site.xml render: ${renderedHosts.join(', ')}`,
  );
  // Account keys are never an option — only OAuth. (A config key, not a URL.)
  assert.ok(
    !r.stdout.includes('fs.azure.account.key'),
    'shared-key storage auth was rendered; the sharing server must be OAuth-only',
  );
});

test('no ADLS account => no core-site.xml at all (and an honest notice)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: 't' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /core-site\.xml/);
  assert.match(r.stderr, /no LOOM_SHARING_ADLS_ACCOUNT/);
});

test('credential/URL lifetimes default SHORT (a shared presigned URL is a bearer credential)', { skip: !shAvailable }, () => {
  const r = render({ LOOM_SHARING_BEARER: 't' });
  assert.equal(r.status, 0, r.stderr);
  const preSigned = /preSignedUrlTimeoutSeconds: (\d+)/.exec(r.stdout);
  const tempCred = /temporaryCredentialValiditySeconds: (\d+)/.exec(r.stdout);
  assert.ok(preSigned && tempCred, 'both lifetimes must be rendered explicitly');
  // Upstream defaults to 3600 for both. A URL handed to an EXTERNAL recipient
  // is a bearer credential for that file, so Loom shortens the window.
  assert.ok(Number(preSigned[1]) <= 900, `presigned URL TTL ${preSigned[1]}s is too long`);
  assert.ok(Number(tempCred[1]) <= 900, `temporary credential TTL ${tempCred[1]}s is too long`);
});
