/**
 * Self-test for scripts/measure/health/arm-path-probe.mjs (#5380).
 * Injected fetch; every printed field asserted. Each assertion names the value
 * that would break it.
 * Run: node --test scripts/ci/__tests__/lhds-arm-path-probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, runProbe, safeHeader, byteClass } from '../../measure/health/arm-path-probe.mjs';

const TOKEN = 'eyJSECRETTOKENVALUE.abc';
const cfg = (o = {}) => ({ subscription: '00000000-0000-0000-0000-000000000001', resourceGroup: 'rg-x', deployment: 'lhds-stamp-dev01',
  apiVersion: '2024-03-01', endpoint: 'https://management.azure.com', repeat: 1, intervalS: 0, token: TOKEN, ...o });
const resp = (status, body, headers = {}) => async () => new Response(body, { status, headers });
const run = async (c, f) => { const out = []; const r = await runProbe(c, { fetchImpl: f, sleep: async () => {}, out: (s) => out.push(s) }); return { r, out }; };

test('JSON 403 with correlation id: every field printed', async () => {
  const f = resp(403, JSON.stringify({ error: { code: 'AuthorizationFailed', message: 'SECRET-MSG' } }),
    { 'content-type': 'application/json; charset=utf-8', server: 'Microsoft-IIS/10.0', 'x-ms-request-id': 'req-1', 'x-ms-correlation-request-id': 'corr-1' });
  const { r, out } = await run(cfg(), f);
  assert.equal(r.code, 0, 'a 403 is a result: exit 0');
  const l = out[0];
  for (const want of ['attempt=1', 'status=403', 'content-type=application/json', 'server=Microsoft-IIS/10.0', 'x-ms-request-id=req-1',
    'x-ms-correlation-request-id=corr-1', 'error.code=AuthorizationFailed', 'first-byte={']) assert.ok(l.includes(want), `missing ${want} in ${l}`);
  assert.match(l, /utc=\d{4}-\d\d-\d\dT/, 'UTC time stamp absent');
  assert.match(l, /length=(measured:)?\d+ /, 'length (header or measured) absent');
  assert.ok(!l.includes('SECRET-MSG'), 'body message leaked');
  assert.ok(!out.join(' ').includes(TOKEN), 'token leaked');
});

test('content-length header is preferred over the measured length', async () => {
  const f = async () => ({ status: 200, text: async () => '{}', headers: new Map([['content-length', '4242']]) });
  const { out } = await run(cfg(), f);
  assert.ok(out[0].includes('length=4242'), `a 2-byte body must not override the header: ${out[0]}`);
});

test('bare 403 (empty body, no headers) is shown as empty / dashes', async () => {
  const { out } = await run(cfg(), resp(403, '', {}));
  assert.ok(out[0].includes('first-byte=empty') && out[0].includes('x-ms-correlation-request-id=-') && out[0].includes('error.code=-'), out[0]);
  assert.ok(out[0].includes('length=measured:0'), `an empty body with no content-length must measure 0: ${out[0]}`);
});

test('HTML body is classed < and not echoed', async () => {
  const { out } = await run(cfg(), resp(403, '<html>SECRETPAGE</html>', { 'content-type': 'text/html' }));
  assert.ok(out[0].includes('first-byte=<') && out[0].includes('content-type=text/html'), out[0]);
  assert.ok(!out.join(' ').includes('SECRETPAGE'), 'body leaked');
});

test('header-injection / oversize values print as invalid', async () => {
  assert.equal(safeHeader('abc\r\nSet-Cookie: x'), 'invalid', 'CRLF value must be invalid');
  assert.equal(safeHeader('a'.repeat(129)), 'invalid', '129 chars exceeds the cap');
  assert.equal(safeHeader('a'.repeat(128)), 'a'.repeat(128), 'control: 128 chars is at the cap and passes');
  assert.equal(safeHeader('ok-1'), 'ok-1', 'control: a plain token passes');
  const f = async () => ({ status: 403, text: async () => '', headers: new Map([['server', 'evil"<script>'], ['x-ms-request-id', 'a\tb'], ['content-type', 'text/html"x']]) });
  const { out } = await run(cfg(), f);
  assert.ok(out[0].includes('server=invalid') && out[0].includes('x-ms-request-id=invalid') && out[0].includes('content-type=invalid'), out[0]);
  assert.ok(!out[0].includes('script'), 'injected value echoed');
});

test('byte classes', () => {
  assert.equal(byteClass('  \n{'), '{');
  assert.equal(byteClass('['), '[');
  assert.equal(byteClass(' \n'), 'empty');
  assert.equal(byteClass('x'), 'other');
});

test('summary counts a mixed run and keeps going over a network error', async () => {
  const seq = [200, 403, 403, 'net'];
  let i = 0;
  const f = async () => { const s = seq[i++]; if (s === 'net') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); return new Response('{}', { status: s }); };
  const { r, out } = await run(cfg({ repeat: 4 }), f);
  assert.equal(r.code, 0, '3 of 4 measured => exit 0');
  assert.ok(out[3].includes('status=network-error') && out[3].includes('class=ECONNRESET'), out[3]);
  assert.ok(out.at(-1).includes('status[200=1 403=2 network-error=1]'), out.at(-1));
});

test('exit 1 when every attempt is a network error', async () => {
  const { r, out } = await run(cfg({ repeat: 2 }), async () => { throw new TypeError('fetch failed'); });
  assert.equal(r.code, 1);
  assert.ok(out.at(-1).startsWith('COULD NOT MEASURE'), out.at(-1));
});

test('exit 1 with no token, and fetch never called', async () => {
  let called = 0;
  const { r, out } = await run(cfg({ token: '' }), async () => { called++; return new Response('{}'); });
  assert.equal(r.code, 1);
  assert.equal(called, 0, 'must not call ARM without a token');
  assert.ok(out[0].includes('no bearer token'), out[0]);
});

test('exit 1 on a path-injection resource group', async () => {
  const { r } = await run(cfg({ resourceGroup: 'rg/../x' }), resp(200, '{}'));
  assert.equal(r.code, 1, 'slash in the RG must be refused');
});

test('request carries the bearer and the exact URL', async () => {
  let seen;
  await run(cfg(), async (u, o) => { seen = { u, o }; return new Response('{}'); });
  assert.equal(seen.u, 'https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-x/providers/Microsoft.Resources/deployments/lhds-stamp-dev01?api-version=2024-03-01');
  assert.equal(seen.o.headers.authorization, `Bearer ${TOKEN}`);
});

test('readConfig: arg beats env; token only from env, CR stripped', () => {
  const c = readConfig(['--repeat', '5', '--token', 'argtok'], { ARM_PROBE_REPEAT: '9', ARM_PROBE_TOKEN: 'envtok\r\n' });
  assert.equal(c.repeat, 5, 'arg must beat env');
  assert.equal(c.token, 'envtok', 'token must come from env and lose the CR');
});
