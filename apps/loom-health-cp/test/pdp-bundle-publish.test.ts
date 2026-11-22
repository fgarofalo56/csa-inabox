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
import { signBundle } from '../src/pdp/bundle-sign.js';
import { CollectionBundleSource, MAX_BUNDLE_BYTES } from '../src/pdp/bundles.js';
import { bundleWithNameBytes, entriesOf, localBundleSigner, unsignedBundle, type LocalBundleSigner } from './bundle-fixtures.js';
import { adminToken, memoryStores, readerToken, startHarness, stampBody, type Harness } from './helpers.js';

const run = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../loom-health-pdp/tools/publish-bundle.mjs');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const B = (id: string) => `/api/health/pdp/stamps/${id}/bundle`;
const body = (b: Buffer, revision = 'r1') => ({ revision, sha256: sha(b), bundleBase64: b.toString('base64') });

let h: Harness;
let signer: LocalBundleSigner;
let admin: string;
let tmp: string;
beforeEach(async () => {
  admin = await adminToken();
  tmp = mkdtempSync(join(tmpdir(), 'lhds-publish-'));
  const stores = memoryStores();
  signer = localBundleSigner();
  h = await startHarness({
    stores,
    bundles: new CollectionBundleSource(stores.pdpBundles, () => new Date('2026-11-03T00:00:00Z'), signer),
    bundleKey: async () => signer.publicPem(),
  });
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
  const got = async (id: string) => Buffer.from(await (await served(id)).arrayBuffer());

  it('SIGNS the unsigned upload before storing it: the served archive is the upload plus a signature that verifies, never the upload as-is', async () => {
    const a = unsignedBundle('bundle-a');
    const b = unsignedBundle('bundle-b-different');
    expect((await served('stamp-a')).status).toBe(404); // before: nothing published
    const put = await h.call('PUT', B('stamp-a'), { token: admin, body: body(a, 'rev-a') });
    expect(put.status).toBe(200);
    const storedA = await got('stamp-a');
    // Breaks if the upload is stored as-is (storedA would equal a and carry no .signatures.json), or if the reported
    // sha256/bytes describe the upload instead of the stored archive the PDP downloads.
    expect(storedA.equals(a)).toBe(false);
    expect(put.json.data).toEqual({ stampId: 'stamp-a', revision: 'rev-a', sha256: sha(storedA), bytes: storedA.length });
    const files = entriesOf(storedA);
    expect(files.has('.signatures.json')).toBe(true);
    for (const [n, d] of entriesOf(a)) expect(files.get(n)?.equals(d), n).toBe(true);
    const jwt = JSON.parse((files.get('.signatures.json') as Buffer).toString()).signatures[0] as string;
    const [hd, pl, sg] = jwt.split('.') as [string, string, string];
    expect(signer.verifies(Buffer.from(`${hd}.${pl}`), Buffer.from(sg, 'base64url'))).toBe(true);
    expect((await h.call('PUT', B('stamp-b'), { token: admin, body: body(b, 'rev-b') })).status).toBe(200);
    // distinct fixtures: a handler that keys every stamp to one document fails one of these
    expect(entriesOf(await got('stamp-b')).get('policy.rego')?.toString()).toContain('bundle-b-different');
    expect(entriesOf(await got('stamp-a')).get('policy.rego')?.toString()).toContain('bundle-a');
    // republish replaces
    await h.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('bundle-a-v2'), 'rev-a2') });
    expect(entriesOf(await got('stamp-a')).get('policy.rego')?.toString()).toContain('bundle-a-v2');
    expect(h.logs.join('\n')).toContain('"event":"pdp.bundle_published"');
  });

  it('no signer configured: 503 and NOTHING stored (an unsigned bundle is never stored as-is)', async () => {
    const stores = memoryStores();
    const u = await startHarness({ stores, bundles: new CollectionBundleSource(stores.pdpBundles) });
    await u.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-a') });
    const r = await u.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('x')) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('bundle_signing_unconfigured');
    expect(stores.pdpBundles.docs.size).toBe(0); // the break value: a store that kept the upload would have 1 document
    await u.close();
  });

  it('an already-signed upload is refused (400), the vault is not called, nothing stored', async () => {
    const signedOnce = await signBundle(unsignedBundle('x'), signer);
    const calls = signer.calls;
    const r = await h.call('PUT', B('stamp-a'), { token: admin, body: body(signedOnce) });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/UNSIGNED/);
    expect(signer.calls).toBe(calls);
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('an entry name of 101 bytes is a 400 that names the name length, NOT a 502 "could not sign"; nothing stored, vault not called', async () => {
    const calls = signer.calls;
    const r = await h.call('PUT', B('stamp-a'), { token: admin, body: body(bundleWithNameBytes(101)) });
    // Breaks if the TarError from writeTar is reported as a signing/vault fault (502): that would blame Key Vault for the publisher's archive.
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/101 bytes/);
    expect(r.json.error.message).not.toMatch(/key vault|sign/i);
    expect(signer.calls).toBe(calls);
    expect((await served('stamp-a')).status).toBe(404);
    // Positive control: 100 bytes is accepted, so the 400 above is the name length and not a dead route.
    expect((await h.call('PUT', B('stamp-a'), { token: admin, body: body(bundleWithNameBytes(100)) })).status).toBe(200);
  });

  it('a vault that fails to sign is 502 and NOTHING stored (never a silently unsigned store)', async () => {
    const stores = memoryStores();
    const bad = { ...signer, sign: async () => { throw new Error('key vault returned 403'); } };
    const u = await startHarness({ stores, bundles: new CollectionBundleSource(stores.pdpBundles, undefined, bad) });
    await u.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-a') });
    const r = await u.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('x')) });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('bundle_signing_failed');
    expect(JSON.stringify(r.json)).not.toContain('403'); // the vault's text is not echoed
    expect(stores.pdpBundles.docs.size).toBe(0);
    await u.close();
  });

  it.each([
    ['sha256 of different bytes (tampered in transit)', () => ({ ...body(unsignedBundle('x')), sha256: sha(unsignedBundle('y')) })],
    ['uppercase sha256 (not the canonical form)', () => ({ ...body(unsignedBundle('x')), sha256: sha(unsignedBundle('x')).toUpperCase() })],
    ['bytes that are not gzip', () => body(Buffer.from('plain text, not a tarball'))],
    ['base64 junk (decodes to non-gzip bytes; rejected by the gzip and sha checks, no separate base64 check is claimed)', () => ({ ...body(unsignedBundle('x')), bundleBase64: '!!not-base64!!' })],
    ['revision with a space', () => body(unsignedBundle('x'), 'bad rev')],
    ['an extra field', () => ({ ...body(unsignedBundle('x')), extra: 1 })],
    ['a bundle over the size cap', () => body(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(MAX_BUNDLE_BYTES)]))],
  ])('400 and NOTHING stored for %s', async (_name, make) => {
    const r = await h.call('PUT', B('stamp-a'), { token: admin, body: make() });
    expect(r.status).toBe(400);
    expect((await served('stamp-a')).status).toBe(404); // the rejected publish stored nothing
    // positive control: the same stamp accepts a good bundle, so the 404 above is not a dead route
    expect((await h.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('ok')) })).status).toBe(200);
  });

  it('404 for an unregistered stamp, 401 without a token, 403 for a Reader (publish needs write)', async () => {
    const good = body(unsignedBundle('x'));
    expect((await h.call('PUT', B('stamp-zz'), { token: admin, body: good })).status).toBe(404);
    expect((await h.call('PUT', B('stamp-a'), { body: good })).status).toBe(401);
    expect((await h.call('PUT', B('stamp-a'), { token: await readerToken(), body: good })).status).toBe(403);
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('503 when the configured source is read-only (file dir)', async () => {
    const ro = await startHarness({ bundles: { get: async () => undefined } });
    await ro.call('POST', '/api/health/stamps', { token: admin, body: stampBody('stamp-a') });
    const r = await ro.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('x')) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('bundle_publish_unconfigured');
    await ro.close();
  });

  it('502 on read when the stored document no longer matches its recorded hash', async () => {
    await h.call('PUT', B('stamp-a'), { token: admin, body: body(unsignedBundle('x')) });
    const doc = h.stores.pdpBundles.docs.get('stamp-a') as { bundleBase64: string };
    doc.bundleBase64 = unsignedBundle('damaged').toString('base64'); // still gzip, different bytes
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
    const bytes = unsignedBundle('real-bundle');
    writeFileSync(f, bytes);
    const r = await exec([f, 'stamp-a', h.url, 'rev-9'], admin);
    const stored = Buffer.from(await (await served('stamp-a')).arrayBuffer());
    // The read-back is compared with the SIGNED stored archive's sha, which differs from the uploaded one: if the tool still
    // compared against the upload it would report a mismatch here.
    expect(r.out).toContain(`uploaded_sha256=${sha(bytes)} stored_sha256=${sha(stored)} (signed by the control plane, read back identical)`);
    expect(r.code).toBe(0);
    expect(sha(stored)).not.toBe(sha(bytes));
    expect(r.out).not.toContain(admin); // the token never reaches the output
  });

  it('fails closed when the control plane rejects it (Reader token): exit 1, says why, nothing stored', async () => {
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, unsignedBundle('x'));
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
    writeFileSync(f, unsignedBundle('x'));
    const r2 = await exec([f, 'stamp-a', h.url, 'rev-1'], undefined);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('LHDS_CP_TOKEN is not set');
    expect((await served('stamp-a')).status).toBe(404);
  });

  it('rejects a plain-http non-local control plane URL', async () => {
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, unsignedBundle('x'));
    const r = await exec([f, 'stamp-a', 'http://cp.example.invalid', 'rev-1'], admin);
    expect(r.code).toBe(1);
    expect(r.out).toContain('must be https');
  });

  it('fails when the PUT response reports no stored sha256 (an unverifiable publish is not a success)', async () => {
    const quiet: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    });
    await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, unsignedBundle('mine'));
    const r = await exec([f, 'stamp-a', `http://127.0.0.1:${(quiet.address() as AddressInfo).port}`, 'rev-1'], 'tok');
    await new Promise<void>((res) => quiet.close(() => res()));
    expect(r.code).toBe(1);
    expect(r.out).toContain('did not report the stored sha256');
  });

  it('fails when the read-back does not match what was published (a control plane that serves other bytes)', async () => {
    // Stub CP: accepts the PUT with 200 but serves different bytes on GET.
    const liar: Server = createServer((req, res) => {
      if (req.method === 'PUT') {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { sha256: 'a'.repeat(64) } })); });
      } else { res.writeHead(200); res.end(gzipSync('someone else')); }
    });
    await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
    const f = join(tmp, 'b.tar.gz');
    writeFileSync(f, unsignedBundle('mine'));
    const r = await exec([f, 'stamp-a', `http://127.0.0.1:${(liar.address() as AddressInfo).port}`, 'rev-1'], 'tok');
    await new Promise<void>((res) => liar.close(() => res()));
    expect(r.code).toBe(1);
    expect(r.out).toContain('read-back mismatch');
  });
});
