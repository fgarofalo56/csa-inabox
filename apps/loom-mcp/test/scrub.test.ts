/**
 * Secret-scrub tests — PRP §5.2 + the mutation-proof.
 *
 * The headline assertion: a `loom_pat_<id>_<secret>` token and a storage
 * connection string put into a tool result do NOT survive `scrub()`. This test
 * is the mutation-proof for `src/core/scrub.ts`: revert `scrub` to a passthrough
 * (`return value`) and this test goes RED because the token reappears in the
 * output. A green run here therefore *proves* the scrub is doing work, not that
 * it merely exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, scrubString, isSecretKey } from '../src/core/scrub.js';

const PAT = 'loom_pat_ABC123_supersecrethalf9999';
const CONN = 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=Zm9vYmFyS0VZ==;EndpointSuffix=core.windows.net';
const ARM = '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-loom/providers/Microsoft.Storage/x';

test('scrub strips a PAT embedded in a value', () => {
  const out = scrub({ note: `token is ${PAT} keep going` });
  const json = JSON.stringify(out);
  assert.ok(!json.includes(PAT), 'full PAT must not appear');
  assert.ok(!json.includes('supersecrethalf9999'), 'secret half must not appear');
  assert.match(json, /REDACTED_PAT/);
});

test('scrub strips a connection string and its account key', () => {
  const out = scrub({ conn: CONN });
  const json = JSON.stringify(out);
  // `conn`… the key is not secret-named, so value-level scrub must catch AccountKey=.
  assert.ok(!json.includes('Zm9vYmFyS0VZ=='), 'account key must not appear');
});

test('scrub redacts secret-named keys wholesale', () => {
  const out = scrub({
    connectionString: CONN,
    accountKey: 'Zm9vYmFyS0VZ==',
    password: 'hunter2',
    token: PAT,
    subscriptionId: '11111111-2222-3333-4444-555555555555',
  }) as Record<string, unknown>;
  assert.equal(out.connectionString, '[REDACTED]');
  assert.equal(out.accountKey, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.subscriptionId, '[REDACTED]');
});

test('scrub strips full ARM resource ids but keeps benign GUID ids', () => {
  const out = scrub({
    resourceId: ARM,
    workspaceId: '99999999-8888-7777-6666-555555555555',
    itemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }) as Record<string, unknown>;
  const json = JSON.stringify(out);
  assert.ok(!json.includes('resourceGroups/rg-loom'), 'ARM id must not appear');
  // Legitimate catalog output survives — a workspace/item id is not a secret.
  assert.equal(out.workspaceId, '99999999-8888-7777-6666-555555555555');
  assert.equal(out.itemId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('scrub strips a loom_session cookie and a Bearer header value', () => {
  const out = scrub({ h: 'Cookie: loom_session=deadbeefsecret; Path=/', a: 'Bearer eyAbcDef123456789' });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('deadbeefsecret'));
  assert.ok(!json.includes('eyAbcDef123456789'));
});

test('scrub is non-mutating, cycle-safe, and depth-bounded', () => {
  const input: Record<string, unknown> = { password: 'hunter2', nested: { a: 1 } };
  (input as { self?: unknown }).self = input; // cycle
  const before = input.password;
  const out = scrub(input) as Record<string, unknown>;
  assert.equal(input.password, before, 'input must not be mutated');
  assert.equal(out.password, '[REDACTED]');
  // deep nesting does not throw / hang
  let deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 60; i++) {
    const next: Record<string, unknown> = {};
    cur.child = next;
    cur = next;
  }
  assert.doesNotThrow(() => scrub(deep));
});

test('isSecretKey matches secret-bearing names and spares ids', () => {
  for (const k of ['password', 'connectionString', 'AccountKey', 'clientSecret', 'sasToken', 'token', 'cookie', 'subscriptionId']) {
    assert.equal(isSecretKey(k), true, `${k} should be secret`);
  }
  for (const k of ['id', 'workspaceId', 'itemId', 'displayName', 'itemType', 'description', 'name']) {
    assert.equal(isSecretKey(k), false, `${k} should NOT be secret`);
  }
});

test('scrubString is a no-op on clean text', () => {
  assert.equal(scrubString('Bronze lakehouse in Analytics workspace'), 'Bronze lakehouse in Analytics workspace');
});
