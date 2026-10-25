import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, mintToken, adminToken, readerToken, reporterToken, OTHER_TENANT, AUTHORITY, TENANT, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const PROTECTED = '/api/health/stamps';

describe('authentication: 401 (cannot be verified)', () => {
  it('rejects a request with no Authorization header', async () => {
    const r = await h.call('GET', PROTECTED); // breaks if the auth check is skipped: would be 200
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ ok: false, error: { code: 'unauthorized', message: 'authentication required' } });
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
  });

  it.each([
    ['not a JWT', 'not-a-token'],
    ['alg=none, empty signature', [{ alg: 'none' }, { roles: ['HealthCP.Admin'] }].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.'],
  ])('rejects %s', async (_n, tok) => {
    const r = await h.call('GET', PROTECTED, { token: tok }); // alg=none carrying the Admin role must NOT pass
    expect(r.status).toBe(401);
  });

  it('rejects a Basic scheme', async () => {
    const res = await fetch(h.url + PROTECTED, { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
  });

  it('rejects a token for another audience', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Admin'], aud: 'api://someone-else' }) });
    expect(r.status).toBe(401); // breaks if audience is not enforced
  });

  it('rejects a token from another Entra tenant (issuer mismatch)', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Admin'], tid: OTHER_TENANT }) });
    expect(r.status).toBe(401); // breaks if issuer is not pinned to the configured tenant
  });

  it('rejects the Commercial authority when the service runs at the Gov authority', async () => {
    const iss = `https://login.microsoftonline.com/${TENANT}/v2.0`;
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Admin'], iss }) });
    expect(r.status).toBe(401); // breaks if the issuer host is not taken from the cloud setting
  });

  it('rejects an expired token', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Admin'], expiresIn: '-1m' }) });
    expect(r.status).toBe(401);
  });

  it('rejects a token signed by a key not in the JWKS', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Admin'], signWithOtherKey: true }) });
    expect(r.status).toBe(401); // breaks if the signature is not verified
  });

  it('rejects an HS256 token (algorithm confusion)', async () => {
    const tok = await new SignJWT({ roles: ['HealthCP.Admin'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`https://${AUTHORITY}/${TENANT}/v2.0`)
      .setAudience('api://loom-health-cp-test')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    const r = await h.call('GET', PROTECTED, { token: tok });
    expect(r.status).toBe(401);
  });
});

describe('authorisation: 403 (verified but not permitted)', () => {
  it('rejects a valid token with no app role', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: [] }) });
    expect(r.status).toBe(403); // breaks if the role check is removed: would be 200
    expect(r.json.error.code).toBe('forbidden');
  });

  it('rejects a role from another app (HealthCP.Other)', async () => {
    const r = await h.call('GET', PROTECTED, { token: await mintToken({ roles: ['HealthCP.Other'] }) });
    expect(r.status).toBe(403);
  });

  it('Reader may read but not write', async () => {
    const t = await readerToken();
    expect((await h.call('GET', PROTECTED, { token: t })).status).toBe(200);
    // breaks if write routes accept the read role
    expect((await h.call('POST', PROTECTED, { token: t, body: {} })).status).toBe(403);
  });

  it('StampReporter may report SLO but not read the registry or write it', async () => {
    const t = await reporterToken();
    expect((await h.call('GET', PROTECTED, { token: t })).status).toBe(403);
    expect((await h.call('POST', PROTECTED, { token: t, body: {} })).status).toBe(403);
  });

  it('enforces the caller-app allowlist when configured', async () => {
    const strict = await startHarness({ allowedCallerAppIds: ['bbbbbbbb-0000-0000-0000-000000000002'] });
    try {
      // role is right, calling app (azp) is not on the allowlist
      const r = await strict.call('GET', PROTECTED, { token: await adminToken() });
      expect(r.status).toBe(403);
      const allowed = await mintToken({ roles: ['HealthCP.Admin'], azp: 'bbbbbbbb-0000-0000-0000-000000000002' });
      expect((await strict.call('GET', PROTECTED, { token: allowed })).status).toBe(200);
    } finally {
      await strict.close();
    }
  });
});

describe('fail-closed coverage and log hygiene', () => {
  it('every non-liveness route rejects an anonymous caller', async () => {
    const probes: [string, string][] = [
      ['GET', '/api/health/stamps'], ['POST', '/api/health/stamps'], ['GET', '/api/health/stamps/stamp-a'],
      ['PATCH', '/api/health/stamps/stamp-a'], ['PUT', '/api/health/stamps/stamp-a/slo'],
      ['GET', '/api/health/tenants'], ['POST', '/api/health/tenants'], ['GET', '/api/health/tenants/visn-01'],
      ['PATCH', '/api/health/tenants/visn-01'], ['GET', '/api/health/routing-map'],
      ['POST', '/api/health/routing-map/publish'], ['GET', '/api/health/slo'], ['GET', '/api/health/jobs'],
      ['GET', `/api/health/jobs/job-${'0'.repeat(32)}`], ['POST', '/api/health/jobs'],
      ['POST', `/api/health/jobs/job-${'0'.repeat(32)}/retry`], ['POST', `/api/health/jobs/job-${'0'.repeat(32)}/cancel`],
    ];
    for (const [m, p] of probes) {
      const r = await h.call(m, p, { body: m === 'GET' ? undefined : {} });
      expect(r.status, `${m} ${p}`).toBe(401); // a route added without authenticate() returns 400/404/200 here
    }
  });

  it('liveness needs no token and says nothing else', async () => {
    const r = await h.call('GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, data: { status: 'live' } });
  });

  it('never logs the bearer token or the request body', async () => {
    const t = await adminToken();
    const marker = 'ZZBODYPROBE-7f3a';
    await h.call('POST', '/api/health/stamps', { token: t, body: { id: 'bad id', displayName: marker } });
    const all = h.logs.join('\n');
    expect(all).not.toContain(t); // the JWT would appear if a header were logged
    expect(all).not.toContain(marker); // the sentinel would appear if a body were logged
    expect(all).toContain('"event":"http.request"'); // positive control: logging is on
    expect(all).toContain('oid-test-caller'); // the caller id (non-PHI) IS logged
  });
});
