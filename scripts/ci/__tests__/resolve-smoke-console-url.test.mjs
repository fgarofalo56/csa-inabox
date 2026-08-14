/**
 * Smoke-test console-URL resolution tests (#3137).
 *
 * The defect being pinned is not "the URL was wrong" — it is that the sovereign
 * lanes ASSUMED a URL would appear from a shell substitution a workflow `env:`
 * block never evaluates, and then probed whatever text arrived. So these tests
 * pin the three states apart (public / internal-only / none) and, specifically,
 * that "internal-only" never silently degrades into "use the internal URL".
 *
 * MUTATION-PROVEN: the tempting one-line "fix" for #3137 is to keep the same
 * key and just make it evaluate —
 *
 *     CONSOLE_URL=$(azd env get-value consoleUrl)
 *
 * i.e. answer with the CAE-internal host. `internal-only must NOT be answered`
 * and `prefers a public ingress over the internal consoleUrl` both go RED under
 * that mutation, while the CONTROL tests (a public URL present, and an empty
 * environment) stay green either way — so an internal-URL shortcut cannot hide
 * behind them.
 *
 * Run: node --test scripts/ci/__tests__/resolve-smoke-console-url.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  INTERNAL_KEYS,
  PUBLIC_KEYS,
  isUsableUrl,
  normalizeKey,
  pickSmokeUrl,
  unwrapOutputValue,
} from '../resolve-smoke-console-url.mjs';

const SCRIPT = fileURLToPath(new URL('../resolve-smoke-console-url.mjs', import.meta.url));

/**
 * The shape azd writes back on a GCC-High tenant deploy: the outputs declared by
 * platform/fiab/bicep/main.bicep, plus the environment values azd itself keeps.
 * AZURE_SUBSCRIPTION_ID is present deliberately — the CLI must never print it.
 */
const GCCH_ENV = {
  AZURE_ENV_NAME: 'csa-loom-gcch-ci-123',
  AZURE_LOCATION: 'usgovvirginia',
  AZURE_SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000000',
  consoleUrl: 'https://loom-console.icystone-1234abcd.usgovvirginia.azurecontainerapps.us',
  frontDoorPublicUrl: 'https://loom-console-abcdefgh-h1h2.z01.azurefd.us',
  vanityPublicUrl: '',
  mcpServerUrl: 'https://loom-mcp.icystone-1234abcd.usgovvirginia.azurecontainerapps.us',
};

test('prefers a public ingress over the internal consoleUrl', () => {
  const picked = pickSmokeUrl(GCCH_ENV);
  assert.equal(picked.kind, 'public');
  assert.equal(picked.key, 'frontDoorPublicUrl');
  assert.equal(picked.url, GCCH_ENV.frontDoorPublicUrl);
});

test('prefers the vanity URL over the raw Front Door host when both are set', () => {
  const picked = pickSmokeUrl({ ...GCCH_ENV, vanityPublicUrl: 'https://csa-loom.example.gov' });
  assert.equal(picked.key, 'vanityPublicUrl');
  assert.equal(picked.url, 'https://csa-loom.example.gov');
});

test('internal-only must NOT be answered — it is reported as internal, never returned as the target', () => {
  const { frontDoorPublicUrl, ...noPublic } = GCCH_ENV;
  void frontDoorPublicUrl;
  const picked = pickSmokeUrl(noPublic);
  assert.equal(picked.kind, 'internal');
  assert.equal(picked.key, 'consoleUrl');
});

test('an EMPTY public output is not a match — that is the "Front Door did not deploy" state', () => {
  const picked = pickSmokeUrl({ ...GCCH_ENV, frontDoorPublicUrl: '' });
  assert.equal(picked.kind, 'internal', 'an empty frontDoorPublicUrl must not be treated as a public ingress');
});

test('a non-URL value is not a match', () => {
  const picked = pickSmokeUrl({ ...GCCH_ENV, frontDoorPublicUrl: 'not-a-url' });
  assert.equal(picked.kind, 'internal');
});

test('no console output of any kind -> nothing is picked (CONTROL)', () => {
  const picked = pickSmokeUrl({ AZURE_ENV_NAME: 'x', AZURE_LOCATION: 'usgovvirginia' });
  assert.equal(picked.kind, null);
  assert.equal(picked.url, null);
});

test('key matching is case- and separator-insensitive (azd casing is not bet on)', () => {
  const picked = pickSmokeUrl({ FRONT_DOOR_PUBLIC_URL: 'https://fd.example.us' });
  assert.equal(picked.kind, 'public');
  assert.equal(picked.url, 'https://fd.example.us');
  assert.equal(normalizeKey('FRONT_DOOR_PUBLIC_URL'), normalizeKey('frontDoorPublicUrl'));
});

test('normalizeKey cannot collapse two DIFFERENT outputs into one', () => {
  const distinct = new Set([...PUBLIC_KEYS, ...INTERNAL_KEYS].map(normalizeKey));
  assert.equal(distinct.size, PUBLIC_KEYS.length + INTERNAL_KEYS.length);
});

test('isUsableUrl rejects the literal that caused #3137', () => {
  assert.equal(isUsableUrl('$(azd env get-values | grep CONSOLE_URL | cut -d= -f2)'), false);
  assert.equal(isUsableUrl('"https://quoted.example.us"'), false, 'azd writes values QUOTED; the quotes are not part of the URL');
  assert.equal(isUsableUrl('https://ok.example.us'), true);
});

// ── CLI behaviour ───────────────────────────────────────────────────────────

function runCli(stdin) {
  return spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });
}

test('CLI prints ONLY the resolved URL on stdout', () => {
  const r = runCli(JSON.stringify(GCCH_ENV));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, GCCH_ENV.frontDoorPublicUrl);
});

test('CLI never prints a value it did not select — including AZURE_SUBSCRIPTION_ID', () => {
  const { frontDoorPublicUrl, ...noPublic } = GCCH_ENV;
  void frontDoorPublicUrl;
  const r = runCli(JSON.stringify(noPublic));
  assert.equal(r.status, 1);
  const all = r.stdout + r.stderr;
  assert.ok(all.includes('AZURE_SUBSCRIPTION_ID'), 'the KEY name is diagnostic and is expected');
  assert.ok(
    !all.includes(GCCH_ENV.AZURE_SUBSCRIPTION_ID),
    'the subscription VALUE must never reach a log',
  );
  assert.ok(!all.includes(GCCH_ENV.consoleUrl), 'the internal URL is named by key, not printed as a target');
});

test('CLI fails closed on EMPTY stdin rather than emitting an empty URL', () => {
  const r = runCli('');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /STDIN was EMPTY/);
});

test('CLI fails closed on the non-JSON `KEY="value"` stream', () => {
  const r = runCli('consoleUrl="https://x.example.us"\n');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /not JSON/);
});

// ── ARM deployment-output shape (#3415) ────────────────────────────────────
//
// #3415 removed azd from the sovereign lanes, so the outputs now arrive from
// `az deployment sub show --query properties.outputs`, which wraps every value
// as { "type": …, "value": … } instead of the flat map azd wrote. These pin the
// widening AND, more importantly, pin that it does not weaken the three states
// the tests above establish: an ARM-shaped EMPTY public URL is still not a
// match, and an ARM-shaped internal-only deploy is still refused.

/**
 * The same GCC-High deploy as GCCH_ENV, in ARM's output shape. There are no
 * AZURE_* values here — ARM returns only what main.bicep declared as `output`.
 */
const GCCH_ARM_OUTPUTS = {
  consoleUrl: {
    type: 'String',
    value: 'https://loom-console.icystone-1234abcd.usgovvirginia.azurecontainerapps.us',
  },
  frontDoorPublicUrl: { type: 'String', value: 'https://loom-console-abcdefgh-h1h2.z01.azurefd.us' },
  vanityPublicUrl: { type: 'String', value: '' },
  mcpServerUrl: {
    type: 'String',
    value: 'https://loom-mcp.icystone-1234abcd.usgovvirginia.azurecontainerapps.us',
  },
};

test('ARM output shape resolves the public ingress (the post-#3415 source)', () => {
  const picked = pickSmokeUrl(GCCH_ARM_OUTPUTS);
  assert.equal(picked.kind, 'public');
  assert.equal(picked.key, 'frontDoorPublicUrl');
  assert.equal(picked.url, GCCH_ARM_OUTPUTS.frontDoorPublicUrl.value);
});

test('ARM shape: an EMPTY public output is STILL not a match — "Front Door did not deploy" must not hide inside the wrapper', () => {
  const picked = pickSmokeUrl({
    consoleUrl: GCCH_ARM_OUTPUTS.consoleUrl,
    frontDoorPublicUrl: { type: 'String', value: '' },
    vanityPublicUrl: { type: 'String', value: '' },
  });
  assert.equal(picked.kind, 'internal', 'an empty ARM-wrapped public URL must not count as a public ingress');
  assert.equal(picked.key, 'consoleUrl');
});

test('ARM shape: internal-only is STILL refused, not degraded into the internal URL', () => {
  const r = runCli(JSON.stringify({ consoleUrl: GCCH_ARM_OUTPUTS.consoleUrl }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /REFUSING to answer/);
});

test('ARM shape: CLI prints ONLY the resolved URL on stdout', () => {
  const r = runCli(JSON.stringify(GCCH_ARM_OUTPUTS));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, GCCH_ARM_OUTPUTS.frontDoorPublicUrl.value);
});

test('unwrapOutputValue is narrow — it only unwraps a plain object that HAS a `value`', () => {
  assert.equal(unwrapOutputValue({ type: 'String', value: 'https://x.example.us' }), 'https://x.example.us');
  assert.equal(unwrapOutputValue('https://x.example.us'), 'https://x.example.us', 'a flat azd value passes through');
  assert.equal(unwrapOutputValue(''), '');
  // No `value` property -> passed through untouched, so the unwrapper cannot
  // coerce it into a match.
  const noValue = { type: 'String' };
  assert.equal(unwrapOutputValue(noValue), noValue);
  const arr = ['https://x.example.us'];
  assert.equal(unwrapOutputValue(arr), arr, 'an array is not an ARM output wrapper');
  assert.equal(unwrapOutputValue(null), null);
});

test('unwrapping cannot invent a match from a NON-url ARM output (CONTROL)', () => {
  const picked = pickSmokeUrl({
    consoleUrl: { type: 'String', value: 'not-a-url' },
    frontDoorPublicUrl: { type: 'Object', value: { host: 'x.example.us' } },
  });
  assert.equal(picked.kind, null);
  assert.equal(picked.url, null);
});
