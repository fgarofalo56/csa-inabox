/**
 * Self-test for scripts/csa-loom/health-tenant-destroy.mjs (#5405).
 * A fake control plane (injected fetch) answers each route; each assertion states the
 * value or mutation that would turn it red.
 * Run: node --test scripts/ci/__tests__/lhds-tenant-destroy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, validate, redact, runDestroy } from '../../csa-loom/health-tenant-destroy.mjs';

const TOKEN = 'eyJSECRETTOKENVALUE.abc';
const SUB = '0b5e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const cfg = (o = {}) => ({ cpUrl: 'https://cp.internal.example', tenant: 'g1-202611200813', stamp: 'dev01',
  idempotencyKey: 'retry-1', allowNonSynthetic: false, allowMissingStorage: false,
  timeoutS: 60, intervalS: 0, token: TOKEN, ...o });
const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const tenantOk = (stampId = 'dev01', status = 'destroying') => json(200, { ok: true, data: { id: 'g1-202611200813', stampId, status } });
const job = (state, receipts = [], extra = {}) => ({ id: 'job-tenant.destroy-abc', state, receipts, ...extra });

/** routes: { 'GET /api/health/tenants/<t>': [resp, resp...], ... } - each route pops in order, last repeats. */
function fakeCp(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname;
    const key = `${opts.method} ${path}`;
    calls.push({ key, url, opts });
    if (calls.length > 200) throw new TypeError('fake CP call cap reached (an unbounded poll)');
    const q = routes[key];
    if (!q) throw new Error(`unrouted ${key}`);
    const r = q.length > 1 ? q.shift() : q[0];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, calls };
}
const run = async (c, routes, now) => {
  const cp = fakeCp(routes);
  const out = [];
  const r = await runDestroy(c, { fetchImpl: cp.fetchImpl, sleep: () => new Promise((res) => setImmediate(res)), out: (s) => out.push(s), ...(now ? { now } : {}) });
  return { r, out, calls: cp.calls, text: out.join('\n') };
};
const T = '/api/health/tenants/g1-202611200813';

test('happy path: submits the exact destroy body, prints each receipt once, exits 0', async () => {
  const r1 = { at: '2026-11-21T00:00:01Z', step: 'tenant.destroying', detail: 'tenant=g1-202611200813' };
  const r2 = { at: '2026-11-21T00:00:09Z', step: 'resource.deleted', detail: `identity id=/subscriptions/${SUB}/resourceGroups/rg/x` };
  const { r, calls, text, out } = await run(cfg(), {
    [`GET ${T}`]: [tenantOk(), json(200, { ok: true, data: { status: 'destroying' } })],
    'POST /api/health/jobs': [json(202, { ok: true, data: job('queued') })],
    'GET /api/health/jobs/job-tenant.destroy-abc': [json(200, { ok: true, data: job('running', [r1]) }), json(200, { ok: true, data: job('succeeded', [r1, r2]) })],
  });
  assert.equal(r.code, 0, 'a succeeded job must exit 0 (breaks if the success state is mis-tested)');
  const post = calls.find((c) => c.key === 'POST /api/health/jobs');
  assert.deepEqual(JSON.parse(post.opts.body), { kind: 'tenant.destroy', subjectType: 'tenant', subjectId: 'g1-202611200813',
    idempotencyKey: 'retry-1', input: { confirmTenantId: 'g1-202611200813' } },
  'breaks if confirmTenantId is dropped, the key is not passed through, or allowMissingStorage leaks in by default');
  assert.equal(post.opts.headers.authorization, `Bearer ${TOKEN}`, 'breaks if the bearer is not sent');
  assert.equal(out.filter((l) => l.includes('tenant.destroying')).length, 1, 'r1 is in two job reads; breaks if receipts are re-printed');
  assert.ok(text.includes('resource.deleted'), 'breaks if the second receipt is never printed');
  assert.ok(text.includes('RESULT job=job-tenant.destroy-abc state=succeeded receipts=2'), text);
  assert.ok(!text.includes(SUB), 'the subscription GUID must be redacted from public output');
  assert.ok(text.includes('/subscriptions/<guid>/'), 'positive control: the redacted id is still printed');
  assert.ok(!text.includes(TOKEN), 'token leaked');
  assert.ok(out.every((l) => l.startsWith('lhds-tenant-destroy: ')), 'every line carries the fixed prefix (no workflow-command injection)');
});

test('a FAILED job exits 1 and prints its error code and message', async () => {
  const { r, text } = await run(cfg(), {
    [`GET ${T}`]: [tenantOk()],
    'POST /api/health/jobs': [json(202, { ok: true, data: job('failed', [], { error: { code: 'shred_unverified', message: 'key did not read back' } }) })],
  });
  assert.equal(r.code, 1, 'breaks if a failed job is reported green');
  assert.ok(text.includes('state=failed error=shred_unverified: key did not read back'), text);
});

test('cancelled is terminal and NOT success', async () => {
  const { r } = await run(cfg(), { [`GET ${T}`]: [tenantOk()], 'POST /api/health/jobs': [json(200, { ok: true, data: job('cancelled') })] });
  assert.equal(r.code, 1, 'breaks if cancelled is treated as success');
});

test('refuses a tenant on another stamp and never submits', async () => {
  const { r, calls, text } = await run(cfg(), { [`GET ${T}`]: [tenantOk('prod01')], 'POST /api/health/jobs': [json(202, { ok: true, data: job('queued') })] });
  assert.equal(r.code, 1);
  assert.equal(calls.filter((c) => c.key.startsWith('POST')).length, 0, 'breaks if the stamp check is skipped: a POST would be made');
  assert.ok(text.includes("on stamp 'prod01', not 'dev01'"), text);
});

test('control: the SAME call on the right stamp DOES submit', async () => {
  const { calls } = await run(cfg(), { [`GET ${T}`]: [tenantOk('dev01')], 'POST /api/health/jobs': [json(202, { ok: true, data: job('succeeded') })] });
  assert.equal(calls.filter((c) => c.key.startsWith('POST')).length, 1, 'the refusal test above is only meaningful if this submits');
});

test('unregistered tenant (404) is refused with nothing submitted', async () => {
  const { r, calls, text } = await run(cfg(), { [`GET ${T}`]: [json(404, { ok: false, error: { code: 'not_found', message: 'tenant' } })] });
  assert.equal(r.code, 1);
  assert.equal(calls.length, 1, 'only the tenant read is allowed');
  assert.ok(text.includes('not in the control-plane registry'), text);
});

test('403 on the tenant read names the role + allowlist', async () => {
  const { r, text } = await run(cfg(), { [`GET ${T}`]: [json(403, { ok: false, error: { code: 'forbidden', message: 'no role' } })] });
  assert.equal(r.code, 1);
  assert.ok(text.includes('HTTP 403 forbidden: no role') && text.includes('HealthCP.Admin'), text);
});

test('submit network error = outcome UNKNOWN, exit 1, names the key for a re-read', async () => {
  const { r, text } = await run(cfg(), { [`GET ${T}`]: [tenantOk()], 'POST /api/health/jobs': [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })] });
  assert.equal(r.code, 1);
  assert.ok(text.includes('SUBMIT OUTCOME UNKNOWN') && text.includes('class=ECONNRESET') && text.includes('retry-1'), text);
});

test('timeout: a job still running at the deadline exits 1, NOT verified', { timeout: 5000 }, async () => {
  let t = 0;
  const now = () => { t += 30_000; return t; }; // each read advances 30 s; timeoutS 60 => deadline after 2 reads
  const { r, text, calls } = await run(cfg({ timeoutS: 60 }), {
    [`GET ${T}`]: [tenantOk()],
    'POST /api/health/jobs': [json(202, { ok: true, data: job('queued') })],
    'GET /api/health/jobs/job-tenant.destroy-abc': [json(200, { ok: true, data: job('running') })],
  }, now);
  assert.equal(r.code, 1, 'breaks if the poll is unbounded (the test would hang) or a timeout reads green');
  assert.ok(text.includes('TIMEOUT') && text.includes('Outcome NOT verified'), text);
  assert.ok(calls.filter((c) => c.key.startsWith('GET /api/health/jobs/')).length >= 1, 'it must have polled at least once');
});

test('5 consecutive job-read failures stop the poll; a success in between resets the count', async () => {
  const fail = json(500, { ok: false, error: { code: 'internal', message: 'x' } });
  const okRun = json(200, { ok: true, data: job('running') });
  const done = json(200, { ok: true, data: job('succeeded') });
  const reset = await run(cfg(), { [`GET ${T}`]: [tenantOk()], 'POST /api/health/jobs': [json(202, { ok: true, data: job('queued') })],
    'GET /api/health/jobs/job-tenant.destroy-abc': [fail, fail, fail, fail, okRun, fail, done] });
  assert.equal(reset.r.code, 0, '4 failures, a good read, 1 failure, then success: breaks if the counter never resets');
  const stop = await run(cfg(), { [`GET ${T}`]: [tenantOk()], 'POST /api/health/jobs': [json(202, { ok: true, data: job('queued') })],
    'GET /api/health/jobs/job-tenant.destroy-abc': [fail, fail, fail, fail, fail, done] });
  assert.equal(stop.r.code, 1, 'the 6th read would succeed: breaks if the cap is above 5');
  assert.ok(stop.text.includes('COULD NOT READ the job after 5'), stop.text);
});

test('allowMissingStorage=true is passed through only when set', async () => {
  const { calls } = await run(cfg({ allowMissingStorage: true }), { [`GET ${T}`]: [tenantOk()], 'POST /api/health/jobs': [json(202, { ok: true, data: job('succeeded') })] });
  const body = JSON.parse(calls.find((c) => c.key.startsWith('POST')).opts.body);
  assert.deepEqual(body.input, { confirmTenantId: 'g1-202611200813', allowMissingStorage: true });
});

test('validate: synthetic-only by default, explicit opt-in for others', () => {
  assert.match(validate(cfg({ tenant: 'contoso' })), /not a G1 synthetic tenant/, 'breaks if a non-g1 tenant passes without opt-in');
  assert.equal(validate(cfg({ tenant: 'contoso', allowNonSynthetic: true })), null, 'control: the opt-in admits it');
  assert.match(validate(cfg({ tenant: 'g1-2026112008' })), /not a G1 synthetic/, '10 digits is not the 12-digit G1 shape');
  assert.match(validate(cfg({ tenant: 'g1-202611200813-x'.padEnd(22, 'x'), allowNonSynthetic: true })), /tenant must match/, '22 chars exceeds the 20 cap');
  assert.match(validate(cfg({ tenant: '../x', allowNonSynthetic: true })), /tenant must match/, 'path characters refused');
  assert.match(validate(cfg({ cpUrl: 'http://cp' })), /https/, 'plain http refused');
  assert.match(validate(cfg({ cpUrl: 'https://cp/?x=1' })), /bare https origin/, 'query refused');
  assert.match(validate(cfg({ token: '' })), /no bearer token/);
  assert.match(validate(cfg({ idempotencyKey: 'a b' })), /idempotency-key/);
  assert.match(validate(cfg({ timeoutS: 0 })), /timeout-s/);
  assert.equal(validate(cfg()), null, 'control: the default config is valid');
});

test('bad input exits 2 and never calls the control plane', async () => {
  const { r, calls } = await run(cfg({ tenant: 'contoso' }), {});
  assert.equal(r.code, 2);
  assert.equal(calls.length, 0, 'breaks if validation runs after the first call');
});

test('redact: GUIDs masked, control chars flattened, capped', () => {
  assert.equal(redact(`a ${SUB} b`), 'a <guid> b');
  assert.equal(redact('x\n::error::y'), 'x ::error::y', 'a newline must not start a new (workflow-command) line');
  assert.equal(redact('z'.repeat(401)).length, 403, '400 + "..."');
  assert.equal(redact('z'.repeat(400)), 'z'.repeat(400), 'control: exactly at the cap is untouched');
});

test('readConfig: arg beats env; token only from env, CR stripped; booleans strict', () => {
  const c = readConfig(['--tenant', 'g1-000000000001', '--allow-non-synthetic', 'TRUE', '--interval-s', '5'],
    { LHDS_TENANT: 'g1-999999999999', LHDS_CP_TOKEN: 'envtok\r\n', LHDS_INTERVAL_S: '9' });
  assert.equal(c.tenant, 'g1-000000000001', 'arg must beat env');
  assert.equal(c.token, 'envtok', 'token must come from env and lose the CR/LF');
  assert.equal(c.allowNonSynthetic, false, 'only the exact string "true" opts in');
  assert.equal(c.intervalS, 5);
  assert.ok(Number.isNaN(readConfig(['--timeout-s', '1e3'], {}).timeoutS), 'non-digit numbers are rejected, not coerced');
});
