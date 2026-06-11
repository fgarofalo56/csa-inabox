'use strict';
/*
 * Zero-dependency unit tests for the shared Loom ADO task helper. Run with:
 *   node --test test/
 * No agent, no network — exercises the input parsing + URL handling that the
 * three tasks rely on. (The `##vso` logging-command emitters are thin
 * console.log wrappers and are not asserted here.)
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const L = require(path.join(__dirname, '..', 'common', 'loom-http.js'));

test('getInput reads INPUT_<UPPERCASE> with . and space normalized to _', () => {
  process.env.INPUT_LOOMBASEURL = '  https://loom.contoso.com  ';
  assert.strictEqual(L.getInput('loomBaseUrl', false), 'https://loom.contoso.com');
  delete process.env.INPUT_LOOMBASEURL;
});

test('getInput returns empty string for an unset, non-required input', () => {
  delete process.env.INPUT_DOESNOTEXIST;
  assert.strictEqual(L.getInput('doesNotExist', false), '');
});

test('getBool recognizes true/1/yes case-insensitively', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'Yes']) {
    process.env.INPUT_FLAG = v;
    assert.strictEqual(L.getBool('flag'), true, `expected ${v} → true`);
  }
  for (const v of ['false', '0', 'no', '']) {
    process.env.INPUT_FLAG = v;
    assert.strictEqual(L.getBool('flag'), false, `expected ${v} → false`);
  }
  delete process.env.INPUT_FLAG;
});

test('trimSlash drops trailing slashes only', () => {
  assert.strictEqual(L.trimSlash('https://x/'), 'https://x');
  assert.strictEqual(L.trimSlash('https://x///'), 'https://x');
  assert.strictEqual(L.trimSlash('https://x'), 'https://x');
});

test('parseItemLines parses itemType:sourceItemId lines, skipping blanks', () => {
  const raw = 'semantic-model:abc-123\n\nreport:def-456\n  paginated-report:ghi-789  ';
  assert.deepStrictEqual(L.parseItemLines(raw), [
    { itemType: 'semantic-model', sourceItemId: 'abc-123' },
    { itemType: 'report', sourceItemId: 'def-456' },
    { itemType: 'paginated-report', sourceItemId: 'ghi-789' },
  ]);
});

test('parseItemLines tolerates a bare id (no itemType)', () => {
  assert.deepStrictEqual(L.parseItemLines('abc-123'), [{ itemType: '', sourceItemId: 'abc-123' }]);
});

test('parseItemLines returns [] for empty input', () => {
  assert.deepStrictEqual(L.parseItemLines(''), []);
  assert.deepStrictEqual(L.parseItemLines(undefined), []);
});

test('request rejects an invalid base URL', async () => {
  await assert.rejects(() => L.request('GET', 'not a url', '/x', 't', 'oid', null), /Invalid loomBaseUrl/);
});

test('unauthorizedHint names the enable flag + token env vars', () => {
  const h = L.unauthorizedHint();
  assert.match(h, /LOOM_PIPELINE_CI_ENABLED/);
  assert.match(h, /LOOM_CI_TOKEN/);
  assert.match(h, /LOOM_INTERNAL_TOKEN/);
});
