/**
 * #5368 - scripts/csa-loom/seed-governance.mjs behaviour, with an injected fake Cosmos
 * (no network). Each assertion names the value that would turn it red
 * (assertion-design.md).
 *
 * Run: node --test scripts/ci/__tests__/seed-governance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocs, seed, main, describeFailure } from '../../csa-loom/seed-governance.mjs';

const NOW = '2026-11-19T00:00:00Z';
const ENDPOINT = 'https://cosmos-loom-test.documents.azure.com:443/';

/** Fake container client. `fail(container, id)` returns an Error (with .code) or undefined. */
function fakeCosmos(fail = () => undefined) {
  const calls = [];
  return {
    calls,
    async upsert(container, pk, doc) {
      calls.push({ container, pk, id: doc.id, doc });
      const e = fail(container, doc.id);
      if (e) throw e;
    },
  };
}
const coded = (code, msg) => Object.assign(new Error(msg), { code });
const quiet = { log: () => {}, logError: () => {} };

test('all 7 docs are upserted with the exact ids, containers and partition keys', async () => {
  const cosmos = fakeCosmos();
  const r = await seed({ cosmos, now: NOW, ...quiet });
  assert.deepEqual(r, { failed: 0, total: 7 });
  // Breaks if a doc is dropped/renamed (count != 7 or an id differs) or routed to the wrong container.
  assert.deepEqual(cosmos.calls.map((c) => `${c.container}/${c.id}`), [
    'tenant-settings/classifications:GLOBAL',
    'tenant-settings/sensitivity-labels:GLOBAL',
    'governance-domains/finance',
    'governance-domains/hr',
    'governance-domains/operations',
    'governance-domains/customer',
    'governance-domains/compliance',
  ]);
  // Breaks if pk is not the doc's own /tenantId (a swapped pk would land the doc in the wrong partition).
  for (const c of cosmos.calls) {
    assert.equal(c.pk, 'GLOBAL');
    assert.equal(c.doc.tenantId, 'GLOBAL');
  }
});

test('LOOM_SEED_TENANT changes BOTH the id suffix and the partition key', async () => {
  const cosmos = fakeCosmos();
  await seed({ cosmos, tenant: 'T-42', now: NOW, ...quiet });
  assert.equal(cosmos.calls[0].id, 'classifications:T-42');
  // Breaks if pk stays hard-coded to GLOBAL while the doc's tenantId is T-42.
  assert.ok(cosmos.calls.every((c) => c.pk === 'T-42' && c.doc.tenantId === 'T-42'));
});

test('doc bodies carry the taxonomy the BFF copies (counts and stamps)', () => {
  const docs = Object.fromEntries(buildDocs('GLOBAL', NOW).map(([, d]) => [d.id, d]));
  // Breaks if an entry is dropped: 7 classifications, 5 labels (the .sh seeded exactly these).
  assert.equal(docs['classifications:GLOBAL'].rules.length, 7);
  assert.equal(docs['sensitivity-labels:GLOBAL'].labels.length, 5);
  assert.equal(docs['classifications:GLOBAL'].rules[0].createdBy, 'csa-loom-seed');
  assert.equal(docs.hr.name, 'Human Resources');
  assert.equal(docs.hr.updatedBy, 'csa-loom-seed');
  // Backslashes survive (a JS string with one backslash would silently break the SSN regex).
  assert.equal(docs['classifications:GLOBAL'].rules[0].matchValue, '\\b\\d{3}-\\d{2}-\\d{4}\\b');
});

test('a 403 exits non-zero and the message names container, item and status', async () => {
  const cosmos = fakeCosmos((c) => (c === 'governance-domains' ? coded(403, 'Forbidden: blocked') : undefined));
  const errs = [];
  const prev = console.error; const prevLog = console.log;
  console.error = (m) => errs.push(m); console.log = () => {};
  let rc;
  try { rc = await main({ LOOM_COSMOS_ENDPOINT: ENDPOINT }, { cosmos }); } finally { console.error = prev; console.log = prevLog; }
  // Breaks if failures are downgraded to warnings or swallowed (rc 0).
  assert.equal(rc, 1);
  const text = errs.join('\n');
  assert.match(text, /HTTP 403/);
  assert.match(text, /container 'governance-domains' \(item 'finance'/);
  // The run continues past the first failure: all 5 domains are reported, not just the first.
  assert.equal(errs.filter((m) => m.includes('HTTP 403')).length, 5);
  assert.match(text, /5 of 7 upserts failed/);
  // Positive pair: the two tenant-settings docs that succeeded were still attempted.
  assert.equal(cosmos.calls.filter((c) => c.container === 'tenant-settings').length, 2);
});

test('a 403 states both possible causes, never one as fact', () => {
  const m = describeFailure('tenant-settings', 'classifications:GLOBAL', coded(403, 'x'));
  // Breaks if the text claims only a missing role: a firewall 403 is the same status (#5360 run 44239837032).
  assert.match(m, /lacks a data-plane role/);
  assert.match(m, /firewall/);
  assert.match(m, /status alone does not tell which/);
});

test('an unknown error asserts NO cause', () => {
  const m = describeFailure('tenant-settings', 'sensitivity-labels:GLOBAL', new Error('socket hang up'));
  assert.match(m, /container 'tenant-settings' \(item 'sensitivity-labels:GLOBAL'/);
  assert.match(m, /no HTTP status/);
  assert.match(m, /no cause is asserted/);
  // Breaks if an unknown failure is attributed to RBAC / firewall / missing container.
  assert.doesNotMatch(m, /lacks|Data Contributor|firewall|not found/i);
  const m500 = describeFailure('governance-domains', 'hr', coded(500, 'boom'));
  assert.match(m500, /HTTP 500/);
  assert.match(m500, /no cause is asserted/);
  assert.doesNotMatch(m500, /lacks|Data Contributor|firewall/i);
});

test('a 404 names the object-not-found meaning and nothing about roles', () => {
  const m = describeFailure('governance-domains', 'finance', coded(404, 'nf'));
  assert.match(m, /HTTP 404/);
  assert.match(m, /not found by that name/);
  assert.doesNotMatch(m, /lacks a data-plane role/);
});

test('a missing endpoint exits 2 and writes nothing', async () => {
  const cosmos = fakeCosmos();
  const prev = console.error; console.error = () => {};
  let rc; try { rc = await main({}, { cosmos }); } finally { console.error = prev; }
  assert.equal(rc, 2);
  assert.equal(cosmos.calls.length, 0);
});

test('success exits 0 (positive pair for the failure cases)', async () => {
  const prev = console.log; console.log = () => {};
  let rc; try { rc = await main({ LOOM_COSMOS_ENDPOINT: ENDPOINT }, { cosmos: fakeCosmos() }); } finally { console.log = prev; }
  assert.equal(rc, 0);
});
