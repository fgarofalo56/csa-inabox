import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectionBundleSource, MAX_BUNDLE_BYTES } from '../src/pdp/bundles.js';
import { adminToken, memoryStores, readerToken, startHarness, stampBody, type Harness } from './helpers.js';

const run = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../loom-health-pdp/tools/publish-bundle.mjs');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const B = (id: string) => `/api/health/pdp/stamps/${id}/bundle`;
const body = (b: Buffer, revision = 'r1') => ({ revision, sha256: sha(b), bundleBase64: b.toString('base64') });

let h: Harness;
let admin: string;
let tmp: string;
beforeEach(async () => {
  admin = await adminToken();
  tmp = mkdtempSync(join(tmpdir(), 'lhds-publish-'));
  const stores = memoryStores();
  h = await startHarness({ stores, bundles: new CollectionBundleSource(stores.pdpBundles, () => new Date('2026-11-03T00:00:00Z')) });
  for (const id of ['stamp-a', 'stamp-b']) {
    expect((await h.call('POST', '/api/health/stamps', { token: admin, body: stampBody(id) })).status).toBe(201);
  }
});
afterEach(async () => {
  await h.close();
  rmSync(tmp, { recursive: true, force: true });
});

const served = async (id: string) => fetch(h.url + `${B(id)}.tar.gz`, { headers: { authorization: `Bearer ${admin}` } });

describe('PUT /api/health/pdp/stamps/{id}/bundle', () => {
  it('stores exactly the published bytes per stamp; the GET serves them (a stamp with nothing published is still 404)', async () => {
    const a = gzipSync('bundle-a');
    const b = gzipSync('bundle-b-different');
    expect((await served('stamp-a')).status).toBe(404); // before: nothing published
    const put = await h.call('PUT', B('stamp-a'), { token: admin, body: body(a, 'rev-a') });
    expect(put.status).toBe(200);
    expect(put.json.data).toEqual({ stampId: 'stamp-a', revision: 'rev-a', sha256: sha(a), bytes: a.length });
    expect((await h.call('PUT', B('stamp-b'), { token: admin, body: body(b, 'rev-b') })).status).toBe(200);
    // distinct fixtures: a handler that keys every stamp to one document fails one of these
    expect(Buffer.from(await (await served('stamp-a')).arrayBuffer()).equals(a)).toBe(true);
    expect(Buffer.from(await (await served('stamp-b')).arrayBuffer()).equals(b)).toBe(true);
    // republish replaces
    const a2 = gzipSync('bundle-a-v2');
    await h.call('PUT', B('stamp-a'), { token: admin, body: body(a2, 'rev-a2') });
    expect(Buffer.from(await (await served('stamp-a')).arrayBuffer()).equals(a2)).toBe(true);
    expect(h.logs.join('\n')).toContain('"event":"pdp.bundle_published"');
  });

  it.each([
    ['sha256 of different bytes (tampered in transit)', () => ({ ...body(gzipSync('x')), sha256: sha(gzipSync('y')) })],
    ['uppercase sha256 (not the canonical form)', () => ({ ...body(gzipSync('x')), sha256: sha(gzipSync('x')).toUpperCase() })],
    ['bytes that are not gzip', () => body(Buffer.from('plain text, not a tarball'))],
    ['base64 junk (decodes to non-gzip bytes; rejected by the gzip and sha checks, no separate base64 check is claimed)', () => ({ ...body(gzipSync('x')), bundleBase64: '!!not-base64!!' })],
    ['revision with a space', () => body(gzipSync('x'), 'bad rev')],
    ['an extra field', () => ({ ...body(gzipSync('x')), extra: 1 })],
    ['a bundle over the size cap', () => body(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(MAX_BUNDLE_BYTES)]))],
  ])('400 and NOTHING stored for %s', async (_name, make) => {
    const r = await h.call('PUT', B('stamp-a'), { token: admin, body: make() });
    expect(r.status).toBe(400);
    expect((await served('stamp-a')).status).toBe(404); // the rejected publish stored nothing
    // positive control: the same stamp accepts a good bundle, so the 404 above is not a dead route
    expect((await h.call('PUT', B('stamp-a'), { token: admin, body: body(gzipSync('ok')) })).status).toBe(200);
  });

  it('404 for an unregistered stamp, 401 without a token, 403 for a Reader (publish needs write)', async () => {
    const good = body(gzipSync('x'));
    expect((await h.call('PUT', B('stamp-zz'), { token: admin, body: good })).status).toBe(404);
    expect((await h.call('PUT', B('stamp-a'), { body: good })).status).toBe(401);
    expect((await h.call('PUT', B('stamp-a'), { token: await readerToken(), body: good })).status).toBe(403);
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('503 when the configured source is read-only (file dir)', async () => {
    const ro = await startHarness({ bundles: { get: async () => undefined } });
    await ro.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-a') });
    const r = await ro.call('PUT', B('stamp-a'), { token: admin, body: body(gzipSync('x')) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('bundle_publish_unconfigured');
    await ro.close();
  });

  it('502 on read when the stored document no longer matches its recorded hash', async () => {
    await h.call('PUT', B('stamp-a'), { token: admin, body: body(gzipSync('x')) });
    const doc = h.stores.pdpBundles.docs.get('stamp-a') as { bundleBase64: string };
    doc.bundleBase64 = gzipSync('damaged').toString('base64'); // still gzip, different bytes
    const r = await served('stamp-a');
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('bundle_invalid');
  });
});

describe('infra the publish path needs', () => {
  it('control-plane.bicep creates the container the service names, lifted from src/store/types.ts', () => {
    // Input that breaks it: a renamed container on either side (the PUT would 500 at runtime against a missing container).
    const here = dirname(fileURLToPath(import.meta.url));
    const types = readFileSync(resolve(here, '../src/store/types.ts'), 'utf8');
    const name = /pdpBundles: '([a-z-]+)'/.exec(types)?.[1];
    expect(name).toBe('health-pdp-bundles');
    const bicep = readFileSync(resolve(here, '../../../platform/fiab/bicep/modules/health/control-plane.bicep'), 'utf8');
    expect(bicep).toContain(`{ name: '${name}', defaultTtl: 0 }`);
  });
});

describe('tools/publish-bundle.mjs (the pipeline publish step)', () => {
  const exec = (args: string[], token: string | undefined) =>
    run(process.execPath, [script, ...args], { env: { ...process.env, LHDS_CP_TOKEN: token ?? '' } }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );

  it('publishes through the real control plane and reads back identical bytes', async () => {
    const f = join(tmp, 'b.tar.gz');
    const bytes = gzipSync('real-bundle');
    writeFileSync(f, bytes);
    const r = await exec([f, 'stamp-a', h.url, 'rev-9'], admin);
    expect(r.out).toContain(`sha256=${sha(bytes)} (read back identical)`);
    expect(r.code).toBe(0);
    expect(Buffer.from(await (await served('stamp-a')).arrayBuffer()).equals(bytes)).toBe(true);
    expect(r.out).not.toContain(admin); // the token never reaches the output
  });

  it('fails closed when the control plane rejects it (Reader token): exit 1, says why, nothing stored', async () => {
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, gzipSync('x'));
    const r = await exec([f, 'stamp-a', h.url, 'rev-1'], await readerToken());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/publish rejected, HTTP 403/);
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('fails closed on a non-gzip file and on a missing token, before sending anything', async () => {
    const f = join(tmp, 'bad.tar.gz');
    writeFileSync(f, 'not gzip');
    const r1 = await exec([f, 'stamp-a', h.url, 'rev-1'], admin);
    expect(r1.code).toBe(1);
    expect(r1.out).toContain('not a gzip tarball');
    writeFileSync(f, gzipSync('x'));
    const r2 = await exec([f, 'stamp-a', h.url, 'rev-1'], undefined);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('LHDS_CP_TOKEN is not set');
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('rejects a plain-http non-local control plane URL', async () => {
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, gzipSync('x'));
    const r = await exec([f, 'stamp-a', 'http://cp.example.invalid', 'rev-1'], admin);
    expect(r.code).toBe(1);
    expect(r.out).toContain('must be https');
  });

  it('fails when the read-back does not match what was published (a control plane that serves other bytes)', async () => {
    // Stub CP: accepts the PUT with 200 but serves different bytes on GET.
    const liar: Server = createServer((req, res) => {
      if (req.method === 'PUT') {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
      } else { res.writeHead(200); res.end(gzipSync('someone else')); }
    });
    await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, gzipSync('mine'));
    const r = await exec([f, 'stamp-a', `http://127.0.0.1:${(liar.address() as AddressInfo).port}`, 'rev-1'], 'tok');
    await new Promise<void>((res) => liar.close(() => res()));
    expect(r.code).toBe(1);
    expect(r.out).toContain('read-back mismatch');
  });
});
