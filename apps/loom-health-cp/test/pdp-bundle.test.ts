import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';
import { FileBundleSource } from '../src/pdp/bundles.js';
import { adminToken, AUDIENCE, AUTHORITY, mintToken, startHarness, stampBody, TENANT, testKeyResolver } from './helpers.js';

let dir: string;
let server: Server | undefined;
let url: string;
let admin: string;

async function start(withBundles: boolean): Promise<void> {
  const stores = (await import('./helpers.js')).memoryStores();
  const app = compose({
    stores,
    auth: { authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [], keyResolver: testKeyResolver },
    sloAvailabilityTarget: 0.999,
    log: () => undefined,
    bundles: withBundles ? new FileBundleSource(dir) : undefined,
  });
  server = createServer((req, res) => void app.handler(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const id of ['stamp-a', 'stamp-b', 'stamp-c']) {
    const r = await fetch(`${url}/api/health/stamps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify(stampBody(id)),
    });
    expect(r.status).toBe(201);
  }
}

const get = (path: string, token: string | undefined = admin, headers: Record<string, string> = {}) =>
  fetch(url + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const P = (id: string) => `/api/health/pdp/stamps/${id}/bundle.tar.gz`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lhds-bundles-'));
  admin = await adminToken();
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health/pdp/stamps/{id}/bundle.tar.gz', () => {
  it('serves exactly the bytes published for THAT stamp, with a content etag', async () => {
    const a = gzipSync('bundle-for-a');
    const b = gzipSync('bundle-for-b');
    writeFileSync(join(dir, 'stamp-a.tar.gz'), a);
    writeFileSync(join(dir, 'stamp-b.tar.gz'), b);
    await start(true);
    const ra = await get(P('stamp-a'));
    const rb = await get(P('stamp-b'));
    expect(ra.status).toBe(200);
    expect(ra.headers.get('content-type')).toBe('application/gzip');
    // distinct fixtures: a handler that serves a fixed/first file fails one of these two
    expect(Buffer.from(await ra.arrayBuffer()).equals(a)).toBe(true);
    expect(Buffer.from(await rb.arrayBuffer()).equals(b)).toBe(true);
    expect(ra.headers.get('etag')).not.toBe(rb.headers.get('etag'));
  });

  it('304 on a matching If-None-Match, 200 on a stale one (a constant 304 or constant 200 fails)', async () => {
    writeFileSync(join(dir, 'stamp-a.tar.gz'), gzipSync('v1'));
    await start(true);
    const etag = (await get(P('stamp-a'))).headers.get('etag')!;
    const hit = await get(P('stamp-a'), admin, { 'if-none-match': etag });
    expect(hit.status).toBe(304);
    expect((await hit.arrayBuffer()).byteLength).toBe(0);
    writeFileSync(join(dir, 'stamp-a.tar.gz'), gzipSync('v2'));
    const stale = await get(P('stamp-a'), admin, { 'if-none-match': etag });
    expect(stale.status).toBe(200);
  });

  it('404 for an unregistered stamp even when a file exists; 404 for a registered stamp with no bundle', async () => {
    writeFileSync(join(dir, 'stamp-zz.tar.gz'), gzipSync('orphan'));
    await start(true);
    expect((await get(P('stamp-zz'))).status).toBe(404);
    expect((await get(P('stamp-c'))).status).toBe(404);
  });

  it('502 when the published file is not a gzip tarball (never hands OPA garbage as a bundle)', async () => {
    writeFileSync(join(dir, 'stamp-a.tar.gz'), Buffer.from('not gzip at all'));
    await start(true);
    const r = await get(P('stamp-a'));
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('bundle_invalid');
  });

  it('503 when no bundle store is configured (not an empty 200)', async () => {
    await start(false);
    const r = await get(P('stamp-a'));
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe('bundle_store_unconfigured');
  });

  it('401 without a token and 403 without a read role (the bundle is not public)', async () => {
    writeFileSync(join(dir, 'stamp-a.tar.gz'), gzipSync('v1'));
    await start(true);
    expect((await get(P('stamp-a'), '')).status).toBe(401);
    expect((await get(P('stamp-a'), await mintToken({ roles: ['HealthCP.StampReporter'] }))).status).toBe(403);
    expect((await get(P('stamp-a'), await mintToken({ roles: ['HealthCP.Reader'] }))).status).toBe(200);
  });

  it('route does not match a traversal id', async () => {
    await start(true);
    expect((await get('/api/health/pdp/stamps/..%2f..%2fetc/bundle.tar.gz')).status).toBe(404);
  });
});

describe('FileBundleSource', () => {
  it('refuses an id that is not a stamp slug instead of building a path from it', async () => {
    writeFileSync(join(dir, '..secret.tar.gz'), gzipSync('x'));
    const src = new FileBundleSource(dir);
    expect(await src.get('../x')).toBeUndefined();
    writeFileSync(join(dir, 'stamp-a.tar.gz'), gzipSync('x'));
    expect(await src.get('stamp-a')).toBeDefined(); // positive control: the source does read
  });
});

describe('harness sanity', () => {
  it('default harness has no bundle store (503)', async () => {
    const h = await startHarness();
    await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody() });
    const res = await fetch(h.url + P('stamp-a'), { headers: { authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(503);
    await h.close();
  });
});
