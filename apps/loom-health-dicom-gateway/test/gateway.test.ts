import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PdpRequest, Pdp } from '../src/pdp.js';
import { call, startGateway, stubArchive, stubPdp, type Gateway, type StubArchive } from './helpers.js';

const STUDY_A1 = '1.2.826.0.1.1';
const STUDY_A2 = '1.2.826.0.1.2';
const bytesA1 = Buffer.from('tenant-a study one: pixel bytes \x00\x01\x02\xff'.repeat(50));
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const P = (tenant: string, rest: string): string => `/${tenant}/dicomweb/v1/${rest}`;

let a: StubArchive;
let b: StubArchive;
let gw: Gateway;
let seen: PdpRequest[];

async function boot(over: { pdp?: Pdp; auditThrows?: boolean; cfg?: Parameters<typeof startGateway>[0]['cfg'] } = {}): Promise<void> {
  gw = await startGateway({ archives: { acme: a, other: b }, pdp: over.pdp ?? stubPdp(seen), auditThrows: over.auditThrows, cfg: over.cfg });
}

beforeEach(async () => {
  seen = [];
  a = await stubArchive('acme', { [STUDY_A1]: bytesA1, [STUDY_A2]: Buffer.from('two') });
  b = await stubArchive('other', {}); // tenant B holds no studies
});
afterEach(async () => {
  await gw?.close();
  await a.close();
  await b.close();
});

describe('authentication and fail-closed authorization', () => {
  it('no Authorization header is 401 and the archive is never contacted', async () => {
    await boot();
    const r = await call(gw.url, P('acme', 'studies'));
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(a.hits).toHaveLength(0);
    expect(seen).toHaveLength(0); // no token, so the PDP is not even asked
  });

  it('a non-Bearer or malformed Authorization is 401', async () => {
    await boot();
    for (const h of ['Basic abc', 'Bearer', 'Bearer a b', 'bearer acme.reader']) {
      const r = await call(gw.url, P('acme', 'studies'), { headers: { authorization: h } });
      expect(r.status, h).toBe(401);
    }
    expect(a.hits).toHaveLength(0);
  });

  it('a token the PDP calls invalid (token-invalid) is 401, archive untouched', async () => {
    await boot();
    const r = await call(gw.url, P('acme', 'studies'), { token: 'garbage' });
    expect(r.status).toBe(401);
    expect(a.hits).toHaveLength(0);
  });

  it('PDP permit forwards (positive control for every deny row)', async () => {
    await boot();
    const r = await call(gw.url, P('acme', 'studies'), { token: 'acme.reader' });
    expect(r.status).toBe(200);
    expect(a.hits).toHaveLength(1);
  });

  it('PDP receives tenant from the ROUTE and a base built from config, not the Host header', async () => {
    await boot();
    await call(gw.url, P('acme', 'studies'), { token: 'acme.reader', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(seen).toEqual([{ service: 'dicom', interaction: 'qido', tenant: 'acme', base: 'https://stamp.health.example/acme/dicomweb' }]);
  });

  it('a PDP outage is 503 with Retry-After, never a pass-through, and the archive is untouched', async () => {
    const down: Pdp = async () => ({ kind: 'unavailable', cause: 'pdp-timeout' });
    await boot({ pdp: down });
    for (const path of [P('acme', 'studies'), P('acme', `studies/${STUDY_A1}`)]) {
      const r = await call(gw.url, path, { token: 'acme.reader' });
      expect(r.status, path).toBe(503);
      expect(r.headers['retry-after']).toBe('5');
    }
    const s = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: { 'content-type': 'multipart/related' }, body: Buffer.from('x') });
    expect(s.status).toBe(503);
    expect(a.hits, 'a fail-open gateway would have reached the archive').toHaveLength(0);
  });

  it('a PDP that THROWS is treated as deny by the pipeline (503, no data)', async () => {
    const boom: Pdp = async () => {
      throw new Error('bug in pdp wrapper');
    };
    await boot({ pdp: boom });
    const r = await call(gw.url, P('acme', 'studies'), { token: 'acme.reader' });
    expect(r.status).toBe(503);
    expect(a.hits).toHaveLength(0);
    expect(r.body.toString()).not.toContain('bug in pdp wrapper');
  });

  it('role-denied is 403: a reader cannot STOW (positive: writer can)', async () => {
    await boot();
    const hdr = { 'content-type': 'multipart/related; type="application/dicom"; boundary=x' };
    const denied = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.reader', headers: hdr, body: Buffer.from('p') });
    expect(denied.status).toBe(403);
    expect(a.hits).toHaveLength(0);
    const ok = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: hdr, body: Buffer.from('p') });
    expect(ok.status).toBe(200);
    expect(a.hits).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it("tenant B's token: 0 QIDO rows on B's own route, 403 on A's QIDO and on a direct study fetch of A's study", async () => {
    await boot();
    // positive control: A's token on A's route sees A's two studies and the study bytes
    const aq = await call(gw.url, P('acme', 'studies'), { token: 'acme.reader' });
    expect(aq.status).toBe(200);
    expect(JSON.parse(aq.body.toString())).toHaveLength(2);
    const aw = await call(gw.url, P('acme', `studies/${STUDY_A1}`), { token: 'acme.reader' });
    expect(aw.status).toBe(200);
    expect(sha(aw.body)).toBe(sha(bytesA1));
    const aHitsBefore = a.hits.length;

    // B on B's route: B's archive holds nothing -> 0 rows (204 No Content per QIDO)
    const bq = await call(gw.url, P('other', 'studies'), { token: 'other.reader' });
    expect(bq.status).toBe(204);
    expect(bq.body.length).toBe(0);

    // B's token against A's route: denied at the PDP, A's archive never contacted
    const cross = await call(gw.url, P('acme', 'studies'), { token: 'other.reader' });
    expect(cross.status).toBe(403);
    expect(JSON.parse(cross.body.toString()).reason).toBe('tenant-mismatch');
    const direct = await call(gw.url, P('acme', `studies/${STUDY_A1}`), { token: 'other.reader' });
    expect(direct.status).toBe(403);
    expect(direct.body.includes(bytesA1.subarray(0, 20))).toBe(false);
    expect(a.hits.length, 'cross-tenant calls must not reach tenant A archive').toBe(aHitsBefore);
  });

  it('a request is only ever forwarded to the archive of its ROUTE tenant', async () => {
    await boot();
    await call(gw.url, P('other', 'studies'), { token: 'other.reader' });
    expect(b.hits).toHaveLength(1);
    expect(a.hits).toHaveLength(0);
  });
});

describe('proxying', () => {
  it('WADO is byte-equal (sha256) and never forwards the Loom token or leaks archive headers', async () => {
    await boot();
    const r = await call(gw.url, P('acme', `studies/${STUDY_A1}`), { token: 'acme.reader', headers: { accept: 'multipart/related; type="application/dicom"', cookie: 'c=1' } });
    expect(r.status).toBe(200);
    expect(sha(r.body)).toBe(sha(bytesA1));
    const hit = a.hits[0]!;
    expect(hit.headers.authorization, 'token must not reach the archive').toBeUndefined();
    expect(hit.headers.cookie).toBeUndefined();
    expect(hit.headers.accept).toBe('multipart/related; type="application/dicom"');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers.server).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('archive RetrieveURL values are rewritten to the public gateway URL (QIDO and STOW)', async () => {
    await boot();
    const q = await call(gw.url, P('acme', 'studies'), { token: 'acme.reader' });
    const text = q.body.toString();
    expect(text).toContain(`https://stamp.health.example/acme/dicomweb/v1/studies/${STUDY_A1}`);
    expect(text, 'archive address must not leak').not.toContain(a.url);
    const s = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: { 'content-type': 'multipart/related; boundary=b' }, body: Buffer.from('x') });
    expect(s.body.toString()).toContain('https://stamp.health.example/acme/dicomweb/v1/studies/1.2.3');
    expect(s.body.toString()).not.toContain(a.url);
  });

  it('an unreachable archive is 502 with a true message', async () => {
    await boot();
    await a.close();
    const r = await call(gw.url, P('acme', 'studies'), { token: 'acme.reader' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body.toString()).error).toBe('archive-unreachable');
    a = await stubArchive('acme', {}); // so afterEach can close
  });

  it('paths outside the grammar are 404 before authentication (no archive hit, no PDP call)', async () => {
    await boot();
    for (const path of ['/acme/dicomweb/v1/changefeed', '/acme/dicomweb/v1/studies/1.2/../x', '/healthz/x']) {
      const r = await call(gw.url, path, { token: 'acme.reader' });
      expect(r.status, path).toBe(404);
    }
    expect(a.hits).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect((await call(gw.url, '/healthz')).status).toBe(200);
  });
});

describe('QIDO caps (AHDS parity: limit 1-200, default 100)', () => {
  const q = (query: string): string => `${P('acme', 'studies')}?${query}`;
  it('limit 0, 201, 1.5, -1, abc and a duplicated limit are 400 and never reach the archive', async () => {
    await boot();
    for (const bad of ['limit=0', 'limit=201', 'limit=1.5', 'limit=-1', 'limit=abc', 'limit=10&limit=20', 'offset=-1', 'offset=x']) {
      const r = await call(gw.url, q(bad), { token: 'acme.reader' });
      expect(r.status, bad).toBe(400);
    }
    expect(a.hits).toHaveLength(0);
  });
  it('boundaries 1 and 200 pass through unchanged; absent limit becomes 100', async () => {
    await boot();
    for (const l of ['1', '200']) {
      expect((await call(gw.url, q(`limit=${l}`), { token: 'acme.reader' })).status).toBe(200);
    }
    expect(a.hits.map((h) => new URL(h.url, 'http://x').searchParams.get('limit'))).toEqual(['1', '200']);
    await call(gw.url, q('PatientName=DOE*&includefield=all'), { token: 'acme.reader' });
    const last = new URL(a.hits.at(-1)!.url, 'http://x').searchParams;
    expect(last.get('limit')).toBe('100');
    expect(last.get('PatientName')).toBe('DOE*'); // fuzzy matching is the archive's; the gateway must not drop it
    expect(last.get('includefield')).toBe('all');
  });
});

describe('audit', () => {
  it('records decision + completion per interaction, with no query VALUES (PHI) and no token', async () => {
    await boot();
    const tok = 'acme.reader';
    await call(gw.url, `${P('acme', 'studies')}?PatientName=SECRETDOE&limit=5`, { token: tok });
    await call(gw.url, P('acme', 'studies'), { token: 'other.reader' }); // denied
    await call(gw.url, P('acme', 'studies')); // unauthenticated
    const [dec, done, deny, unauth] = gw.audit;
    expect(dec).toMatchObject({ phase: 'decision', outcome: 'permit', tenant: 'acme', interaction: 'qido', method: 'GET', policyVersion: 'v1' });
    expect(dec!.queryKeys).toEqual(['PatientName', 'limit']);
    expect(done).toMatchObject({ phase: 'complete', outcome: 'permit', status: 200 });
    expect(done!.bytesOut).toBeGreaterThan(0);
    expect(deny).toMatchObject({ phase: 'complete', outcome: 'deny', reason: 'tenant-mismatch', status: 403 });
    expect(unauth).toMatchObject({ outcome: 'unauthenticated', reason: 'no-bearer-token', status: 401 });
    const all = JSON.stringify(gw.audit);
    expect(all, 'query value must not be audited').not.toContain('SECRETDOE');
    expect(all).not.toContain(tok);
    expect(new Set(gw.audit.map((e) => e.requestId)).size).toBe(3);
  });

  it('is fail-closed: if the decision record cannot be written, no data flows (503)', async () => {
    await boot({ auditThrows: true });
    const r = await call(gw.url, P('acme', `studies/${STUDY_A1}`), { token: 'acme.reader' });
    expect(r.status).toBe(503);
    expect(a.hits).toHaveLength(0);
  });
});

describe('STOW', () => {
  const hdr = { 'content-type': 'multipart/related; type="application/dicom"; boundary=b' };

  it('requires multipart/related (415) and rejects a declared Content-Length over the cap (413) before the archive', async () => {
    await boot({ cfg: { stowMaxBytes: 1000 } });
    const t = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') });
    expect(t.status).toBe(415);
    const big = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: hdr, body: Buffer.alloc(1001, 1) });
    expect(big.status).toBe(413);
    expect(a.hits).toHaveLength(0);
  });

  it('cap holds when Content-Length is absent (chunked): 1001 bytes against a 1000 cap is 413, 1000 passes', async () => {
    await boot({ cfg: { stowMaxBytes: 1000 } });
    const chunked = (n: number): NodeJS.ReadableStream => {
      return Readable.from([Buffer.alloc(n, 7)]);
    };
    const over = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: hdr, body: chunked(1001) });
    expect(over.status).toBe(413);
    expect(JSON.parse(over.body.toString()).maxBytes).toBe(1000);
    const ok = await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: hdr, body: chunked(1000) });
    expect(ok.status).toBe(200);
    expect(a.hits.at(-1)!.bytes).toBe(1000);
  });

  it('forwards the exact body bytes to the archive', async () => {
    await boot();
    const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    await call(gw.url, P('acme', 'studies'), { method: 'POST', token: 'acme.writer', headers: hdr, body: payload });
    expect(a.hits[0]!.bytes).toBe(payload.length);
  });
});
