/**
 * Self-test for scripts/measure/health/edge-probe.mjs (#5149).
 *
 * The probe is the instrument that will judge a live APIM gateway, so each case
 * stands up an in-process stub gateway with ONE chosen behaviour and asserts the
 * probe's verdict. Every defective stub is the input that must turn a check red;
 * the "correct" stub is the control that must pass, so an always-red or
 * always-green probe fails one of them.
 *
 * Run: node --test scripts/ci/__tests__/lhds-edge-probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readConfig, runProbe } from '../../measure/health/edge-probe.mjs';

const QUOTA = 20;

/** Stub of the fragment: token claim `tenant` = the Authorization value (tA/tB). */
function gateway(opts = {}) {
  const counts = new Map([['acme', 0], ['zeta', 0]]);
  const srv = createServer((req, res) => {
    const tenant = req.url.split('/')[1];
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const tokenTenant = tok === 'tA' ? 'acme' : tok === 'tB' ? 'zeta' : '';
    if (opts.mismatchAllowed !== true && tokenTenant !== tenant) { res.statusCode = 403; return res.end('{}'); }
    if (opts.noPositive) { res.statusCode = 401; return res.end('{}'); }
    const key = opts.sharedCounter ? 'acme' : tenant;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!opts.noLimit && counts.get(key) > QUOTA) {
      res.statusCode = 429;
      if (opts.retryAfter !== null) res.setHeader('Retry-After', opts.retryAfter ?? '30');
      return res.end('{}');
    }
    res.statusCode = 200;
    res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function probe(opts, cfgOver = {}) {
  const srv = await gateway(opts);
  try {
    const { cfg, problems } = readConfig({
      LHDS_EDGE_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
      LHDS_TENANT_A: 'acme', LHDS_TENANT_B: 'zeta', LHDS_TOKEN_A: 'tA', LHDS_TOKEN_B: 'tB',
      LHDS_QUOTA_RPM: String(QUOTA), ...cfgOver,
    });
    assert.deepEqual(problems, []);
    const r = await runProbe(cfg);
    return { ...r, by: Object.fromEntries(r.results.map((x) => [x.name, x.verdict])) };
  } finally {
    srv.close();
  }
}

test('control: a correct gateway passes every check, exit 0', async () => {
  const r = await probe({});
  assert.equal(r.exit, 0, JSON.stringify(r.results));
  assert.deepEqual(r.by, { 'positive-control': 'PASS', 'cross-tenant-403': 'PASS', 'quota-429': 'PASS', 'retry-after': 'PASS', 'quota-isolation': 'PASS' });
});

test('defect: tenant A path accepts tenant B token (200 not 403) -> cross-tenant-403 FAIL, exit 1', async () => {
  const r = await probe({ mismatchAllowed: true });
  assert.equal(r.by['cross-tenant-403'], 'FAIL');
  assert.equal(r.exit, 1);
});

test('defect: no quota enforced (quota+5 requests, never 429) -> quota-429 FAIL, exit 1', async () => {
  const r = await probe({ noLimit: true });
  assert.equal(r.by['quota-429'], 'FAIL');
  assert.equal(r.exit, 1);
});

test('defect: 429 without Retry-After -> retry-after FAIL, exit 1 (while quota-429 still PASS)', async () => {
  const r = await probe({ retryAfter: null });
  assert.equal(r.by['quota-429'], 'PASS');
  assert.equal(r.by['retry-after'], 'FAIL');
  assert.equal(r.exit, 1);
});

test('defect: Retry-After of 0 is not a usable back-off -> FAIL', async () => {
  const r = await probe({ retryAfter: '0' });
  assert.equal(r.by['retry-after'], 'FAIL');
});

test('defect: one shared counter, so tenant B is limited by tenant A traffic -> quota-isolation not PASS', async () => {
  const r = await probe({ sharedCounter: true });
  assert.equal(r.by['quota-isolation'], 'FAIL');
  assert.equal(r.exit, 1);
});

test('failed positive control is UNMEASURED (exit 2) and the 403/429 checks are not run, never a pass', async () => {
  const r = await probe({ noPositive: true });
  assert.equal(r.by['positive-control'], 'UNMEASURED');
  assert.equal(r.by['cross-tenant-403'], undefined);
  assert.equal(r.exit, 2);
});

test('an unreachable gateway is UNMEASURED (exit 2), not FAIL and not PASS', async () => {
  const { cfg } = readConfig({ LHDS_EDGE_BASE_URL: 'http://127.0.0.1:1', LHDS_TENANT_A: 'acme', LHDS_TENANT_B: 'zeta', LHDS_TOKEN_A: 'tA', LHDS_TOKEN_B: 'tB', LHDS_QUOTA_RPM: '5' });
  const r = await runProbe(cfg);
  assert.equal(r.exit, 2);
  assert.equal(r.results[0].verdict, 'UNMEASURED');
});

test('config: plain-http non-loopback, equal tenants, missing token, zero quota are each refused', () => {
  const ok = { LHDS_EDGE_BASE_URL: 'https://gw.example', LHDS_TENANT_A: 'a', LHDS_TENANT_B: 'b', LHDS_TOKEN_A: 'x', LHDS_TOKEN_B: 'y', LHDS_QUOTA_RPM: '10' };
  assert.deepEqual(readConfig(ok).problems, []);
  assert.equal(readConfig({ ...ok, LHDS_EDGE_BASE_URL: 'http://gw.example' }).problems.length, 1);
  assert.equal(readConfig({ ...ok, LHDS_TENANT_B: 'a' }).problems.length, 1);
  assert.equal(readConfig({ ...ok, LHDS_TOKEN_B: '' }).problems.length, 1);
  assert.equal(readConfig({ ...ok, LHDS_QUOTA_RPM: '0' }).problems.length, 1);
});
