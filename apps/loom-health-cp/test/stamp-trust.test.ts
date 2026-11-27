// Real-TLS tests for the pinned stamp-ingress trust (tls/stamp-trust.ts). Every certificate is a self-signed
// one generated here with openssl, shaped like the Key Vault "Self" issuer policy in ingress-cert.ts
// (CA:FALSE, digitalSignature+keyEncipherment, serverAuth, CN and SAN = the host). A local https server
// presents it; the assertions are about what Node's TLS stack actually accepts, not about a mock.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { Agent } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyFetchFailure, createFhirPatientSearch } from '../src/auth/patient-search.js';
import { pinnedAgent, pinnedRequest, StampIngressTrust } from '../src/tls/stamp-trust.js';

const HOST = 'localhost';

interface Pair { key: string; cert: string; cer: string }

let dir: string;
function selfSigned(name: string, cn: string): Pair {
  const k = join(dir, `${name}-k`);
  const c = join(dir, `${name}-c`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-days', '2', '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${cn}`, '-addext', 'keyUsage=digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'basicConstraints=critical,CA:FALSE',
  ], { stdio: 'pipe' });
  const cert = readFileSync(c, 'utf8');
  // The vault's `cer` field: base64 DER of the public certificate.
  return { key: readFileSync(k, 'utf8'), cert, cer: new X509Certificate(cert).raw.toString('base64') };
}

const servers: Server[] = [];
async function serve(p: Pair): Promise<number> {
  const s = createServer({ key: p.key, cert: p.cert }, (req, res) => {
    if (req.url === '/hang') return; // never answers: the timeout test
    res.writeHead(200, { 'content-type': 'application/fhir+json' });
    res.end(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Ada' }] } }] }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, HOST, r));
  return (s.address() as AddressInfo).port;
}

let A: Pair; // the certificate the CP issued for this stamp
let B: Pair; // a DIFFERENT self-signed certificate for the same host
let C: Pair; // a self-signed certificate for ANOTHER host
let portA: number; // serves A
let portA2: number; // also serves A, on another origin
let portB: number; // serves B
let portC: number; // serves C

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lhds-stamp-trust-'));
  A = selfSigned('a', HOST);
  B = selfSigned('b', HOST);
  C = selfSigned('c', 'other.invalid');
  portA = await serve(A);
  portA2 = await serve(A);
  portB = await serve(B);
  portC = await serve(C);
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

type Log = { event: string; f: Record<string, string | number> };
function trustFor(port: number, fallback?: typeof fetch) {
  const logs: Log[] = [];
  const t = new StampIngressTrust({ fqdn: HOST, port, log: (event, f) => logs.push({ event, f }), ...(fallback ? { fallback } : {}) });
  return { t, logs };
}
const url = (port: number, path = '/t1/fhir/Patient?name=a') => `https://${HOST}:${port}${path}`;
const failureOf = async (p: Promise<unknown>) => classifyFetchFailure(await p.then(() => undefined, (e: unknown) => e));

describe('StampIngressTrust over real TLS', () => {
  it('the default trust REJECTS the stamp certificate; the pinned trust ACCEPTS it and reads the body', async () => {
    // The live defect, reproduced: breaks (the first assertion) if Node's default store ever trusted A, and
    // (the second) if the pin does not reach the TLS handshake - e.g. an Agent built without the pinned PEM.
    expect((await failureOf(fetch(url(portA)))).kind).toBe('tls');
    const { t } = trustFor(portA);
    t.setCertificate(A.cer);
    const r = await t.fetch(url(portA), { signal: AbortSignal.timeout(5000) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { resourceType: string }).resourceType).toBe('Bundle');
  });

  it('the pin is scoped to the stamp origin: another origin with the SAME cert, and the global fetch, still reject it', async () => {
    // Breaks if the dispatcher is used for every origin (portA2 would answer 200) or installed globally
    // (the plain fetch to portA would answer 200).
    const { t } = trustFor(portA);
    t.setCertificate(A.cer);
    expect((await failureOf(t.fetch(url(portA2)))).kind).toBe('tls');
    expect((await failureOf(fetch(url(portA)))).kind).toBe('tls');
    expect((await t.fetch(url(portA))).status).toBe(200); // positive control on the same trust instance
  });

  it('a DIFFERENT self-signed certificate is still rejected: pinning A does not trust B', async () => {
    // Breaks if the pin trusts any self-signed certificate (e.g. rejectUnauthorized off, or a wildcard CA list).
    const { t } = trustFor(portB);
    t.setCertificate(A.cer);
    const f = await failureOf(t.fetch(url(portB)));
    expect(f.kind).toBe('tls');
    expect(f.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
  });

  it('hostname verification stays ON: a trusted certificate for another host fails with ERR_TLS_CERT_ALTNAME_INVALID', async () => {
    // pinnedAgent is the factory StampIngressTrust pins with. C is in its CA list, so ONLY the host check can
    // reject C served at "localhost". Breaks if that factory disables checkServerIdentity.
    const f = await failureOf(pinnedRequest(pinnedAgent([C.cert]), new URL(url(portC))));
    expect(f).toEqual({ kind: 'tls', code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    // Reference (not coverage): a stock Agent with the same CA list fails identically, so the code above is Node's own host check.
    const stock = new Agent({ ca: [...rootCertificates, C.cert], keepAlive: false });
    expect(await failureOf(pinnedRequest(stock, new URL(url(portC))))).toEqual({ kind: 'tls', code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('a pinned request that never answers rejects as a timeout', async () => {
    const { t } = trustFor(portA);
    t.setCertificate(A.cer);
    expect(await failureOf(t.fetch(url(portA, '/hang'), { signal: AbortSignal.timeout(100) }))).toEqual({ kind: 'timeout' });
  });

  it('end to end: the AS patient search over the pinned fetch returns the patient; over the default fetch it is unavailable: tls', async () => {
    // Breaks if createFhirPatientSearch does not use the supplied fetch, or the TLS failure is mislabelled.
    const { t } = trustFor(portA);
    t.setCertificate(A.cer);
    const base = (tenant: string) => `https://${HOST}:${portA}/${tenant}/fhir`;
    const pinned = createFhirPatientSearch({ fhirBaseFor: base, token: async () => 'tok', fetch: t.fetch });
    expect(await pinned.search('t1', 'o', [], { name: 'a' })).toEqual([{ id: 'p1', name: 'Ada' }]);
    const plain = createFhirPatientSearch({ fhirBaseFor: base, token: async () => 'tok' });
    await expect(plain.search('t1', 'o', [], { name: 'a' })).rejects.toThrow(/unavailable: tls (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/);
  });

  it('rotation: a new certificate re-pins and the previous one stays trusted; the same one is a no-op', async () => {
    // Breaks if a rotation replaces without keeping the old cert (portA would fail after B is pinned), if the
    // new one is not pinned (portB would fail), or if re-reading the same cert re-pins (a second pinned log).
    const { t, logs } = trustFor(portA);
    t.setCertificate(A.cer);
    t.setCertificate(A.cer);
    expect(logs.filter((l) => l.event === 'tls.stamp_trust_pinned')).toHaveLength(1);
    t.setCertificate(B.cer);
    expect(t.state()).toEqual({ pinned: true, fingerprints: [new X509Certificate(B.cert).fingerprint256, new X509Certificate(A.cert).fingerprint256] });
    expect((await t.fetch(url(portA))).status).toBe(200);
    // The newly rotated-in certificate is trusted too: the same A-then-B sequence on a trust for B's server.
    const { t: tb } = trustFor(portB);
    tb.setCertificate(A.cer);
    tb.setCertificate(B.cer);
    expect((await tb.fetch(url(portB))).status).toBe(200);
  });
});

describe('StampIngressTrust fallback and refusal', () => {
  it('before any certificate is read, the stamp origin uses the default fetch and logs a distinct reason', async () => {
    // Breaks if an unpinned trust throws instead of falling back, or falls back silently.
    const seen: string[] = [];
    const fallback = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const { t, logs } = trustFor(portA, fallback);
    expect((await t.fetch(url(portA))).status).toBe(200);
    expect(seen).toEqual([url(portA)]);
    expect(logs).toEqual([{ event: 'tls.stamp_trust_default', f: { origin: `https://${HOST}:${portA}`, reason: 'the ingress certificate has not been read from the vault yet' } }]);
  });

  it('other origins go to the default fetch even when pinned', async () => {
    const seen: string[] = [];
    const fallback = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const { t } = trustFor(portA, fallback);
    t.setCertificate(A.cer);
    await t.fetch('https://login.microsoftonline.com/x');
    await t.fetch(url(portA));
    expect(seen).toEqual(['https://login.microsoftonline.com/x']); // breaks if the pinned origin also went to the fallback
  });

  it.each([
    [undefined, 'the vault returned no public certificate (cer)'],
    ['', 'the vault returned no public certificate (cer)'],
    ['bm90IGEgY2VydA==', 'the vault certificate could not be parsed as X.509'],
  ])('an unusable cer %j keeps the default trust with reason %j', (cer, reason) => {
    const { t, logs } = trustFor(portA);
    t.setCertificate(cer);
    expect(t.state()).toEqual({ pinned: false, reason });
    expect(logs.at(-1)).toEqual({ event: 'tls.stamp_trust_default', f: { origin: `https://${HOST}:${portA}`, reason } });
  });

  it('refuses to pin a certificate that does not name the stamp FQDN', () => {
    // Breaks if the vault's certificate is pinned without checking it is the stamp's own (C names other.invalid).
    const { t } = trustFor(portA);
    t.setCertificate(C.cer);
    expect(t.state()).toEqual({ pinned: false, reason: 'the vault certificate does not name the stamp FQDN' });
  });

  it('an unusable read after a good pin keeps the pin (the ingress still serves it)', async () => {
    const { t, logs } = trustFor(portA);
    t.setCertificate(A.cer);
    t.setCertificate(undefined);
    expect(t.state().pinned).toBe(true);
    expect(logs.at(-1)?.event).toBe('tls.stamp_trust_kept');
    expect((await t.fetch(url(portA))).status).toBe(200);
  });

  it('origin is https://<fqdn> on 443 (no port), as fhirBaseFor builds it from LOOM_HEALTH_CP_FHIR_BASE_URL', () => {
    const t = new StampIngressTrust({ fqdn: 'LHDS-dev01-x.centralus.cloudapp.azure.com', log: () => {} });
    expect(t.origin).toBe('https://lhds-dev01-x.centralus.cloudapp.azure.com');
  });
});
