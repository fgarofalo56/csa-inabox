/**
 * Self-test for scripts/ci/check-url-boundary.mjs.
 *
 * WHY IT EXISTS. The guard was written to close the URL-substring-validation
 * class, and it shipped unable to see the spelling that STARTED the class:
 *
 *     host.endsWith('azconfig.io')   → evilazconfig.io   (CodeQL #540)
 *
 * `host-match.ts` names that spelling in its own header as case 4 of 5. The
 * guard's method alternation was `includes|indexOf|startsWith`. So the module
 * documented the bug, the guard claimed to enforce it, and the enforcement had
 * a hole exactly where the documentation pointed. Nothing was measuring the
 * guard, so nothing said so.
 *
 * These cases drive the REAL `scanLine()` — never a copy of its regex — so a
 * regex edit that narrows detection turns them red.
 *
 * Run: node --test scripts/ci/__tests__/url-boundary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLine } from '../check-url-boundary.mjs';

const flags = (line) => scanLine(line).map((f) => f.needle);

// ── the spelling the guard could not see (CodeQL #540) ─────────────────────

test('endsWith with NO leading dot is flagged — the #540 shape', () => {
  assert.deepEqual(flags("if (host.endsWith('azconfig.io')) return 'azconfig.io';"), ['azconfig.io']);
});

test('endsWith on a longer dot-less suffix is flagged too (azconfig.azure.us)', () => {
  assert.deepEqual(flags("if (host.endsWith('azconfig.azure.us')) {"), ['azconfig.azure.us']);
});

test('the other four spellings from host-match.ts are still flagged', () => {
  assert.deepEqual(flags("if (endpoint.includes('openai.azure.us')) {"), ['openai.azure.us']);
  assert.deepEqual(flags("if (vaultUri.includes('.usgovcloudapi.net')) {"), ['.usgovcloudapi.net']);
  assert.deepEqual(flags("if (url.startsWith('https://learn.microsoft.com')) {"), ['https://learn.microsoft.com']);
  assert.equal(flags("if (host.indexOf('contoso.com') >= 0) {").length, 1);
});

// ── CONTROLS: these must stay quiet BOTH before and after the endsWith rule ─
// A guard that flagged every endsWith would have three false positives on main
// (git-integration-client, updates/apply, git-credential) and would be switched
// off, which is the failure mode this repo keeps rediscovering.

test('CONTROL: endsWith WITH a leading dot is safe and stays quiet', () => {
  assert.deepEqual(flags("if (hostOnly.endsWith('.ghe.com')) {"), []);
  assert.deepEqual(flags("if (host.endsWith('.azurecr.io')) {"), []);
  assert.deepEqual(flags("if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure-devops';"), []);
});

test('CONTROL: startsWith on a full origin including the trailing slash stays quiet', () => {
  assert.deepEqual(flags("if (u.startsWith('https://learn.microsoft.com/')) {"), []);
});

test('CONTROL: a comment describing the bug is not a violation', () => {
  assert.deepEqual(flags(" *   host.endsWith('azconfig.io')  → evilazconfig.io"), []);
  assert.deepEqual(flags("// endpoint.includes('openai.azure.us') is wrong"), []);
});

test('CONTROL: an equality comparison against a host is not a substring check', () => {
  assert.deepEqual(flags("if (host === 'github.com') return 'github';"), []);
});

test('CONTROL: endsWith on a file extension is not a domain check', () => {
  assert.deepEqual(flags("if (name.endsWith('.ts')) push(name);"), []);
  assert.deepEqual(flags("if (file.endsWith('.tsx')) push(file);"), []);
});

test('CONTROL: the correct helper call is not flagged', () => {
  assert.deepEqual(flags("if (hostHasSuffix(host, 'azconfig.io')) return 'azconfig.io';"), []);
  assert.deepEqual(flags("if (urlHostHasSuffix(endpoint, 'azconfig.azure.us')) {"), []);
});

test('the reason text names the missing label boundary, not the generic one', () => {
  const [f] = scanLine("if (host.endsWith('azconfig.io')) {");
  assert.match(f.why, /leading dot/);
  assert.match(f.why, /#540/);
});
