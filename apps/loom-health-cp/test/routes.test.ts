import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminToken, readerToken, reporterToken, startHarness, stampBody, tenantBody, type Harness } from './helpers.js';

let h: Harness;
let admin: string;
beforeEach(async () => {
  h = await startHarness();
  admin = await adminToken();
});
afterEach(async () => {
  await h.close();
});

describe('GET /api/health/stamps', () => {
  it('returns the registered stamps with status and engine versions', async () => {
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-a') });
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-b') });
    const r = await h.call('GET', '/api/health/stamps', { token: await readerToken() });
    expect(r.status).toBe(200);
    // exactly the two ids we created, in id order: an empty/placeholder list fails here
    expect(r.json.data.stamps.map((s: { id: string }) => s.id)).toEqual(['stamp-a', 'stamp-b']);
    expect(r.json.data.stamps[0]).toMatchObject({ status: 'creating', class: 'M', cloud: 'gcc-high', engineVersions: {} });
  });

  it('is empty on a fresh registry rather than invented', async () => {
    const r = await h.call('GET', '/api/health/stamps', { token: admin });
    expect(r.json).toEqual({ ok: true, data: { stamps: [] } });
  });
});

describe('stamp CRUD and validation', () => {
  it('creates (201), rejects a duplicate (409), reads one, 404 for unknown', async () => {
    expect((await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() })).status).toBe(201);
    expect((await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() })).status).toBe(409);
    expect((await h.call('GET', '/api/health/stamps/stamp-a', { token: admin })).json.data.id).toBe('stamp-a');
    expect((await h.call('GET', '/api/health/stamps/stamp-zz', { token: admin })).status).toBe(404);
  });

  it.each([
    ['uppercase/space id', { ...stampBody(), id: 'Bad Id' }],
    ['http (non-TLS) baseUrl', { ...stampBody(), baseUrl: 'http://x.example.us' }],
    ['baseUrl with credentials', { ...stampBody(), baseUrl: 'https://u:p@x.example.us' }],
    ['unknown cloud', { ...stampBody(), cloud: 'moon' }],
    ['unknown extra field', { ...stampBody(), isAdmin: true }],
    ['status supplied at create', { ...stampBody(), status: 'healthy' }],
  ])('400 for %s', async (_n, body) => {
    const r = await h.call('POST', '/api/health/stamps', { token: admin, body });
    expect(r.status).toBe(400); // each input above would be stored if validation were loosened
    expect(r.json.ok).toBe(false);
  });

  it('PATCH moves creating -> healthy and rejects an illegal jump to evacuated (409)', async () => {
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    const ok = await h.call('PATCH', '/api/health/stamps/stamp-a', { token: admin, body: { status: 'healthy', deploySha: 'abc1234' } });
    expect(ok.json.data).toMatchObject({ status: 'healthy', deploySha: 'abc1234' });
    const bad = await h.call('PATCH', '/api/health/stamps/stamp-a', { token: admin, body: { status: 'evacuated' } });
    expect(bad.status).toBe(409); // healthy -> evacuated skips draining
  });

  it('404 for a malformed path id; 400 for invalid JSON and a non-JSON content-type', async () => {
    expect((await h.call('GET', '/api/health/stamps/Bad_Id', { token: admin })).status).toBe(404); // not a route
    expect((await h.call('POST', '/api/health/stamps', { token: admin, raw: '{nope' })).status).toBe(400);
    expect((await h.call('POST', '/api/health/stamps', { token: admin, raw: '{}', contentType: 'text/plain' })).status).toBe(400);
  });

  it('413 for a body over the cap', async () => {
    const r = await h.call('POST', '/api/health/stamps', { token: admin, raw: JSON.stringify({ x: 'a'.repeat(70 * 1024) }) });
    expect(r.status).toBe(413); // 70 KiB > 64 KiB cap
  });

  it('405 for a known path with the wrong method', async () => {
    expect((await h.call('DELETE', '/api/health/stamps', { token: admin })).status).toBe(405);
  });
});

describe('tenants', () => {
  it('needs an existing stamp, then creates and reads back', async () => {
    const orphan = await h.call('POST', '/api/health/tenants', { token: admin, body: tenantBody() });
    expect(orphan.status).toBe(400); // stamp-a is not registered yet
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    const ok = await h.call('POST', '/api/health/tenants', { token: admin, body: tenantBody() });
    expect(ok.status).toBe(201);
    expect(ok.json.data).toMatchObject({ id: 'visn-01', stampId: 'stamp-a', status: 'creating' });
    const list = await h.call('GET', '/api/health/tenants', { token: admin });
    expect(list.json.data.tenants).toHaveLength(1);
  });

  it('refuses to move a tenant to draining without a target (400), and moves stampId only via the drain fields', async () => {
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    await h.call('POST', '/api/health/tenants', { token: admin, body: tenantBody() });
    await h.call('PATCH', '/api/health/tenants/visn-01', { token: admin, body: { status: 'active' } });
    const noTarget = await h.call('PATCH', '/api/health/tenants/visn-01', { token: admin, body: { status: 'draining' } });
    expect(noTarget.status).toBe(400);
    const direct = await h.call('PATCH', '/api/health/tenants/visn-01', { token: admin, body: { stampId: 'stamp-b' } });
    expect(direct.status).toBe(400); // stampId is not patchable: unknown field on a strict schema
  });
});

describe('routing map', () => {
  it('404 before the first publish, then publish builds it from the registries', async () => {
    expect((await h.call('GET', '/api/health/routing-map', { token: admin })).status).toBe(404);
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    await h.call('PATCH', '/api/health/stamps/stamp-a', { token: admin, body: { status: 'healthy' } });
    await h.call('POST', '/api/health/tenants', { token: admin, body: tenantBody() });
    await h.call('PATCH', '/api/health/tenants/visn-01', { token: admin, body: { status: 'active' } });
    const pub = await h.call('POST', '/api/health/routing-map/publish', { token: admin });
    expect(pub.json.data).toMatchObject({ published: true, entryCount: 1 });
    const map = await h.call('GET', '/api/health/routing-map', { token: await readerToken() });
    expect(map.json.data.entries).toEqual([
      { tenantSlug: 'visn-01', stampId: 'stamp-a', stampBaseUrl: 'https://stamp-a.health.example.us', status: 'active' },
    ]);
    expect(map.json.data.cacheTtlSeconds).toBe(60);
  });
});

describe('SLO API', () => {
  it('reporter submits a sample; the aggregate reflects it; reader cannot submit', async () => {
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    const sample = {
      windowStart: '2026-10-24T00:00:00Z', windowEnd: '2026-10-24T01:00:00Z',
      totalRequests: 100000, goodRequests: 99000, p95LatencyMs: 180, capacityUsedPercent: 40,
    };
    expect((await h.call('PUT', '/api/health/stamps/stamp-a/slo', { token: await readerToken(), body: sample })).status).toBe(403);
    expect((await h.call('PUT', '/api/health/stamps/stamp-a/slo', { token: await reporterToken(), body: sample })).status).toBe(200);
    const r = await h.call('GET', '/api/health/slo', { token: admin });
    expect(r.json.data.stamps[0]).toMatchObject({ stampId: 'stamp-a', state: 'breached', availability: 0.99 });
    expect(r.json.data.fleet.state).toBe('breached');
  });

  it('400 when goodRequests exceeds totalRequests; 404 for an unknown stamp', async () => {
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    const bad = { windowStart: '2026-10-24T00:00:00Z', windowEnd: '2026-10-24T01:00:00Z', totalRequests: 10, goodRequests: 11, p95LatencyMs: 1, capacityUsedPercent: 1 };
    expect((await h.call('PUT', '/api/health/stamps/stamp-a/slo', { token: admin, body: bad })).status).toBe(400);
    expect((await h.call('PUT', '/api/health/stamps/stamp-q/slo', { token: admin, body: { ...bad, goodRequests: 5 } })).status).toBe(404);
  });
});

describe('jobs API', () => {
  it('submits routing.publish, runs it, is idempotent on the same key, and rejects unknown kinds', async () => {
    const body = { kind: 'routing.publish', subjectType: 'routing', subjectId: 'current', idempotencyKey: 'run-1' };
    const first = await h.call('POST', '/api/health/jobs', { token: admin, body });
    expect(first.status).toBe(202);
    await h.app.jobs.idle();
    const done = await h.call('GET', `/api/health/jobs/${first.json.data.id}`, { token: admin });
    expect(done.json.data.state).toBe('succeeded');
    expect(done.json.data.receipts[0].step).toBe('routing.published');
    const again = await h.call('POST', '/api/health/jobs', { token: admin, body });
    expect(again.status).toBe(200); // not 202: nothing new was created
    expect(again.json.data.id).toBe(first.json.data.id);
    const unknown = await h.call('POST', '/api/health/jobs', { token: admin, body: { ...body, kind: 'tenant.create' } });
    expect(unknown.status).toBe(400); // W1-2 has not registered tenant.create in this service yet
  });

  it('404 for a job whose subject does not exist', async () => {
    const r = await h.call('POST', '/api/health/jobs', {
      token: admin, body: { kind: 'routing.publish', subjectType: 'routing', subjectId: 'other-id', idempotencyKey: 'k1' },
    });
    expect(r.status).toBe(404);
  });
});

describe('error hygiene', () => {
  it('a store fault is a generic 500 that leaks neither message nor endpoint', async () => {
    const secretish = 'https://cosmos-acct.documents.azure.us/dbs/x key=SECRETVALUE';
    h.stores.stamps.failWith = new Error(secretish);
    const r = await h.call('GET', '/api/health/stamps', { token: admin });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: { code: 'internal', message: 'internal error' } });
    // the message must be absent from the response AND from the logs
    expect(JSON.stringify(r.json)).not.toContain('cosmos-acct');
    expect(h.logs.join('\n')).not.toContain('SECRETVALUE');
    expect(h.logs.join('\n')).toContain('http.internal_error'); // positive control: the fault was logged (class only)
  });
});
