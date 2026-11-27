// Pure-function contract tests for the Authorization Server core: scope grammar,
// ceiling intersection, per-cloud hosts, signer and federation seams.
// Each assertion names, in a comment, the defect that turns it red.

import { constants, createHash, generateKeyPairSync, privateEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, createLocalJWKSet, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { GRAPH_BY_CLOUD, KEYVAULT_SUFFIX_BY_CLOUD } from '../src/auth/clouds.js';
import { createEntraFederation, createGraphMembership, FederationError, GraphConsentRequiredError } from '../src/auth/federation.js';
import { computeGrant } from '../src/auth/grant.js';
import { ROLES, ROLE_IDS, ceilingsFor } from '../src/auth/role-map.js';
import { intersectWithCeilings, parseDataScope, parseRequest, serializeScope } from '../src/auth/scopes.js';
import { ID_TOKEN_KEY_NAME, KeyVaultHttpError, KeyVaultRsaSigner, KeyVaultSigner, LocalSigner, idTokenKeyUrlFrom } from '../src/auth/signer.js';
import { mintAccessToken, mintIdToken } from '../src/auth/tokens.js';
import type { Cloud } from '../src/config.js';

const V2 = { v1: false };
const grantFor = (roles: string[], scope: string, grant: 'authorization_code' | 'client_credentials' = 'authorization_code', extra = {}) =>
  computeGrant({ grant, request: parseRequest(scope, V2), roleIds: roles, clientAllowed: ['user/*.cruds', 'patient/*.cruds', 'system/*.cruds'], fhirUserResolved: false, ...extra });
const scopes = (g: { scope: string[] }) => g.scope.join(' ');

describe('scope grammar (A2)', () => {
  it('accepts in-order v2 perms and rejects out-of-order, repeated and unknown letters', () => {
    expect(parseDataScope('user/Observation.rs', V2)).toBeDefined(); // paired permit
    // breaks if the parser sorts or accepts `.sr`
    expect(parseDataScope('user/Observation.sr', V2)).toBeUndefined();
    expect(parseDataScope('user/Observation.rr', V2)).toBeUndefined();
    expect(parseDataScope('user/Observation.x', V2)).toBeUndefined();
  });
  it('rejects unknown resource types and v1 forms unless the tenant flag is on', () => {
    expect(parseDataScope('user/NotAType.rs', V2)).toBeUndefined();
    expect(parseDataScope('user/Observation.read', V2)).toBeUndefined();
    // breaks if the flag is ignored: with it on, read -> rs
    expect(serializeScope(parseDataScope('user/Observation.read', { v1: true })!)).toBe('user/Observation.rs');
    expect(serializeScope(parseDataScope('user/Observation.write', { v1: true })!)).toBe('user/Observation.cud');
  });
  it('accepts exactly one category constraint on the three constrained types only (N8)', () => {
    expect(parseDataScope('patient/Observation.rs?category=laboratory', V2)?.constraint).toBe('category=laboratory');
    // breaks if the AS strips an unsupported constraint and widens the scope
    expect(parseDataScope('patient/Observation.rs?code=1234-5', V2)).toBeUndefined();
    expect(parseDataScope('patient/Patient.rs?category=laboratory', V2)).toBeUndefined();
    expect(parseDataScope('patient/Observation.rs?category=a&category=b', V2)).toBeUndefined();
  });
  it('collapses duplicates and refuses to parse launch/encounter, online_access, profile', () => {
    const r = parseRequest('user/Patient.rs user/Patient.rs launch/encounter online_access profile', V2);
    expect(r.data).toHaveLength(1); // breaks if duplicates are kept
    expect(r.context).toEqual([]);
    expect(r.rejected).toEqual(['launch/encounter', 'online_access', 'profile']);
  });
});

describe('ceiling intersection (A4)', () => {
  it('N9: smart-user asking user/Patient.cruds gets user/Patient.rs exactly', () => {
    // breaks if the intersection returns the request unmodified (mutation arm i)
    expect(scopes(grantFor(['fhir-smart-user'], 'user/Patient.cruds'))).toBe('user/Patient.rs');
    expect(scopes(grantFor(['fhir-data-reader'], 'user/Patient.rs'))).toBe('user/Patient.rs'); // paired permit
  });
  it('worked examples from the design: narrowed and dropped', () => {
    expect(scopes(grantFor(['fhir-data-reader'], 'user/*.cruds', 'authorization_code'))).toBe('user/*.rs');
    // user/Observation.c against user/*.rs grants nothing
    expect(scopes(grantFor(['fhir-data-reader'], 'user/Observation.c'))).toBe('');
  });
  it('N10: health-tenant-admin alone yields no data scope; adding the reader role yields one', () => {
    expect(scopes(grantFor(['health-tenant-admin'], 'user/Patient.rs'))).toBe(''); // breaks if admin inherits data access (D12)
    expect(scopes(grantFor(['health-tenant-admin', 'fhir-data-reader'], 'user/Patient.rs'))).toBe('user/Patient.rs');
  });
  it('N11/N12: compartment is tied to the grant type in both directions', () => {
    expect(scopes(grantFor(['fhir-data-reader', 'fhir-data-exporter'], 'system/*.rs user/*.rs'))).toBe('user/*.rs'); // system dropped
    expect(scopes(grantFor(['fhir-data-exporter'], 'system/*.rs', 'client_credentials'))).toBe('system/*.rs'); // paired permit
    expect(scopes(grantFor(['fhir-data-exporter'], 'patient/*.rs user/*.rs', 'client_credentials'))).toBe('');
  });
  it('a role never grants by itself and the client registration caps the result', () => {
    expect(scopes(grantFor(['fhir-data-writer'], 'openid'))).toBe('openid'); // no requested data scope => none granted
    const capped = computeGrant({ grant: 'authorization_code', request: parseRequest('user/Patient.cruds', V2), roleIds: ['fhir-data-writer'], clientAllowed: ['user/*.rs'], fhirUserResolved: false });
    expect(scopes(capped)).toBe('user/Patient.rs'); // breaks if the client allow-list is skipped (writer alone would give .cruds)
  });
  it('a constrained ceiling requires an identical constraint on the request', () => {
    const c = [parseDataScope('user/Observation.rs?category=laboratory', V2)!];
    expect(intersectWithCeilings([parseDataScope('user/Observation.rs', V2)!], c)).toEqual([]);
    expect(intersectWithCeilings([parseDataScope('user/Observation.rs?category=laboratory', V2)!], c)).toHaveLength(1);
  });
  it('patient/ scopes are dropped without a patient context; with one they survive (N21 issuance side)', () => {
    expect(scopes(grantFor(['fhir-data-reader'], 'patient/*.rs'))).toBe('');
    expect(scopes(grantFor(['fhir-data-reader'], 'patient/*.rs'))).not.toContain('patient/');
    expect(scopes(grantFor(['fhir-data-reader'], 'patient/*.rs', 'authorization_code', { patient: 'p1' }))).toBe('patient/*.rs');
  });
  it('context scopes: fhirUser only when resolved, offline_access only with a data scope', () => {
    expect(scopes(grantFor(['fhir-data-reader'], 'openid fhirUser user/*.rs offline_access'))).toBe('user/*.rs openid offline_access');
    expect(scopes(grantFor(['fhir-data-reader'], 'openid fhirUser user/*.rs', 'authorization_code', { fhirUserResolved: true }))).toBe('user/*.rs openid fhirUser');
    expect(scopes(grantFor(['health-tenant-admin'], 'openid offline_access'))).toBe('openid'); // breaks if a refresh is allowed with no data scope
    expect(scopes(grantFor(['fhir-data-exporter'], 'openid', 'client_credentials'))).toBe(''); // client creds carry no context scopes
  });
});

describe('role-scope map', () => {
  it('every role id is in the JSON and the loader returns the JSON ceilings, not a copy', () => {
    expect(ROLES.length).toBe(14); // breaks if a role row is added without a test pass
    expect(ROLE_IDS.has('fhir-smart-user')).toBe(true);
    expect(ceilingsFor(['fhir-smart-user'], 'client_credentials')).toEqual([]);
    expect(ceilingsFor(['no-such-role'], 'authorization_code')).toEqual([]);
  });
});

describe('per-cloud hosts (A5)', () => {
  const cases: [Cloud, string, string][] = [
    ['commercial', 'graph.microsoft.com', 'vault.azure.net'],
    ['gcc', 'graph.microsoft.com', 'vault.azure.net'],
    ['gcc-high', 'graph.microsoft.us', 'vault.usgovcloudapi.net'],
    ['il5', 'graph.microsoft.us', 'vault.usgovcloudapi.net'],
    ['dod', 'dod-graph.microsoft.us', 'vault.usgovcloudapi.net'],
  ];
  for (const [cloud, graph, kv] of cases) {
    it(`${cloud}: graph ${graph}, key vault ${kv}`, () => {
      expect(GRAPH_BY_CLOUD[cloud]).toBe(graph); // breaks if DoD collapses into the GCC-High host
      expect(KEYVAULT_SUFFIX_BY_CLOUD[cloud]).toBe(kv);
    });
  }
  it('Graph membership calls the cloud host (gcc-high vs commercial)', async () => {
    for (const [cloud, graph] of [['gcc-high', 'graph.microsoft.us'], ['dod', 'dod-graph.microsoft.us']] as const) {
      const urls: string[] = [];
      const g = createGraphMembership({
        cloud,
        getToken: async (scope) => (scope === `https://${graph}/.default` ? 't' : 'wrong-scope'),
        fetchImpl: (async (u: string, init: RequestInit) => {
          urls.push(u);
          expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      await g.memberOf('11111111-1111-1111-1111-111111111111', ['aaaaaaaa-0000-0000-0000-000000000001']);
      expect(urls[0]).toContain(`https://${graph}/v1.0/directoryObjects/`);
    }
  });
});

describe('Graph membership', () => {
  const oid = '11111111-1111-1111-1111-111111111111';
  const gid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  it('chunks at 20 ids and only returns ids that were asked about', async () => {
    const calls: number[] = [];
    const g = createGraphMembership({
      cloud: 'commercial',
      getToken: async () => 't',
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const ids = (JSON.parse(init.body as string) as { groupIds: string[] }).groupIds;
        calls.push(ids.length);
        return new Response(JSON.stringify({ value: [ids[0], gid(999)] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const asked = Array.from({ length: 21 }, (_, i) => gid(i + 1));
    const got = await g.memberOf(oid, asked);
    expect(calls).toEqual([20, 1]); // breaks if one call carries >20 ids
    expect(got).toEqual([gid(1), gid(21)]); // gid(999) was never asked about => dropped
  });
  it('403 is the consent gate, not "no membership"; a non-GUID oid never reaches the URL', async () => {
    const g = createGraphMembership({ cloud: 'commercial', getToken: async () => 't', fetchImpl: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch });
    await expect(g.memberOf(oid, [gid(1)])).rejects.toBeInstanceOf(GraphConsentRequiredError);
    await expect(g.memberOf('../../users', [gid(1)])).rejects.toThrow('GUID');
  });
});

describe('signers', () => {
  it('LocalSigner publishes a public JWK with no private member and signs verifiably (ES384)', async () => {
    const s = new LocalSigner();
    const jwk = await s.publicJwk();
    expect('d' in jwk).toBe(false); // breaks if the private scalar leaks into the JWKS
    const jwt = await mintAccessToken(s, { issuer: 'https://as.test/auth', audience: 'https://t.test/fhir', tenant: 'visn-01', subType: 'user', sub: 'o', clientId: 'c', scope: ['user/*.rs'], roles: ['fhir-data-reader'], pou: ['TREAT'], now: new Date() });
    const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet({ keys: [jwk] }), { issuer: 'https://as.test/auth', audience: 'https://t.test/fhir' });
    expect(protectedHeader.typ).toBe('at+jwt');
    expect(protectedHeader.alg).toBe('ES384');
    expect(payload.lhds_ver).toBe('lhds-at/1');
    expect((payload.exp as number) - (payload.iat as number)).toBe(300); // breaks if the lifetime drifts from the contract
    expect('act' in payload || 'cnf' in payload).toBe(false); // reserved claims are never issued
    // a different key must not verify
    await expect(jwtVerify(jwt, createLocalJWKSet({ keys: [await new LocalSigner().publicJwk()] }))).rejects.toThrow();
  });

  it('KeyVaultSigner signs a SHA-384 digest remotely and never sees a private key; rejects a wrong-cloud key id', async () => {
    const local = new LocalSigner();
    const calls: { url: string; body?: { alg: string; value: string } }[] = [];
    const keyId = `https://kv-test.vault.usgovcloudapi.net/keys/lhds-as/${'a'.repeat(32)}`;
    const fetchImpl = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) });
      if (init.method === 'GET') {
        const j = await local.publicJwk();
        return new Response(JSON.stringify({ key: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: Buffer.alloc(96, 1).toString('base64url') }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new KeyVaultSigner({ cloud: 'gcc-high', keyId, getToken: async (scope) => (scope === 'https://vault.usgovcloudapi.net/.default' ? 't' : 'wrong'), fetchImpl });
    const sig = await s.sign(Buffer.from('abc'));
    expect(sig.length).toBe(96);
    const signCall = calls.find((c) => c.body)!;
    expect(signCall.body!.alg).toBe('ES384');
    // sha384('abc') base64url; breaks if the raw input (or another hash) is sent instead of the digest
    expect(signCall.body!.value).toBe(createHash('sha384').update('abc').digest('base64url'));
    expect(signCall.body!.value).not.toBe(Buffer.from('abc').toString('base64url'));
    expect((await s.publicJwk()).kid).toBeTruthy();
    expect(() => new KeyVaultSigner({ cloud: 'commercial', keyId, getToken: async () => 't', fetchImpl })).toThrow('key id must be');
  });

  // Live 2026-11-21 (dev01): the signing key is HSM-backed and Key Vault returns kty "EC-HSM".
  // Breaks if publicJwk() accepts only "EC" (every token request then 500s at kid()), or if
  // the published JWK keeps the non-standard "EC-HSM" kty (relying parties reject it).
  it('KeyVaultSigner accepts an HSM-backed key (kty EC-HSM) and publishes a standard EC JWK', async () => {
    const local = new LocalSigner();
    const j = await local.publicJwk();
    const keyId = `https://kv-test.vault.azure.net/keys/lhds-as/${'b'.repeat(32)}`;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ key: { kty: 'EC-HSM', crv: j.crv, x: j.x, y: j.y } }), { status: 200 })) as unknown as typeof fetch;
    const s = new KeyVaultSigner({ cloud: 'commercial', keyId, getToken: async () => 't', fetchImpl });
    const pub = await s.publicJwk();
    expect(pub.kty).toBe('EC');
    expect(pub.crv).toBe('P-384');
    expect(await s.kid()).toBe(pub.kid);
    // Same key material => same RFC 7638 thumbprint as the in-process key, so the kid is not
    // derived from the HSM label.
    expect(pub.kid).toBe(j.kid);
  });

  // Breaks if a rejected read is cached (`this.pub ??= promise` without clearing on failure):
  // the second call would re-throw the first failure instead of re-reading Key Vault.
  it('KeyVaultSigner does not cache a failed key read: the next call reads Key Vault again', async () => {
    const local = new LocalSigner();
    const j = await local.publicJwk();
    const keyId = `https://kv-test.vault.azure.net/keys/lhds-as/${'c'.repeat(32)}`;
    let gets = 0;
    const fetchImpl = (async () => {
      gets += 1;
      if (gets === 1) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({ key: { kty: 'EC', crv: j.crv, x: j.x, y: j.y } }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new KeyVaultSigner({ cloud: 'commercial', keyId, getToken: async () => 't', fetchImpl });
    await expect(s.kid()).rejects.toThrow('key vault returned 503');
    expect(await s.kid()).toBe(j.kid);
    expect(gets).toBe(2);
    // and a success IS cached: no third read
    await s.kid();
    expect(gets).toBe(2);
  });
});

// ---- #5454 A7: the RS256 id_token key, get-or-create in the stamp vault ----

/** DER DigestInfo prefix for SHA-256 (RFC 8017 9.2): what an RSA-HSM prepends before PKCS#1 v1.5 padding. */
const DIGEST_INFO_SHA256 = Buffer.from('3031300d060960864801650304020105000420', 'hex');
const KV_KEY = 'https://kv-t.vault.azure.net/keys/lhds-as-idtoken-rs256';

/** A Key Vault fake for one RSA key: GET latest, create, list versions, GET a version, sign a digest. */
class FakeRsaVault {
  versions: Array<{ ver: string; created: number; enabled: boolean; priv: KeyObject }> = [];
  calls: Array<{ method: string; host: string; path: string; body?: Record<string, unknown> }> = [];
  createStatus = 200;
  /** When set, the versions list is paged: page 1 is empty and points here; a URL with `page=2` returns the list. */
  firstPageNext: string | undefined;
  /** Versions whose /sign answers 403 (disabled out-of-band). */
  refuseSign = new Set<string>();
  private clock = 1_000;
  add(created = this.clock++, enabled = true): string {
    const ver = randomBytes(16).toString('hex');
    this.versions.push({ ver, created, enabled, priv: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey });
    return ver;
  }
  private jwkOf(v: FakeRsaVault['versions'][number]) {
    const { n, e } = v.priv.export({ format: 'jwk' });
    return { kid: `${KV_KEY}/${v.ver}`, kty: 'RSA-HSM', n, e, key_ops: ['sign', 'verify'] };
  }
  readonly fetch = (async (u: string, init: RequestInit) => {
    const parsed = new URL(u);
    const path = parsed.pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    this.calls.push({ method, host: parsed.host, path, ...(body ? { body } : {}) });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    const base = new URL(KV_KEY).pathname;
    if (method === 'GET' && path === base) {
      const latest = this.versions.at(-1);
      return latest ? json(200, { key: this.jwkOf(latest) }) : json(404, { error: { code: 'KeyNotFound' } });
    }
    if (method === 'POST' && path === `${base}/create`) {
      if (this.createStatus !== 200) return json(this.createStatus, { error: { code: 'Forbidden', message: 'not allowed' } });
      const ver = this.add();
      return json(200, { key: this.jwkOf(this.versions.find((v) => v.ver === ver)!) });
    }
    // Answers on ANY host, so only the signer's own origin check can keep a request off a foreign host.
    if (method === 'GET' && path.endsWith('/versions') && this.firstPageNext && !parsed.searchParams.has('page')) {
      return json(200, { value: [], nextLink: this.firstPageNext });
    }
    if (method === 'GET' && path.endsWith('/versions')) {
      return json(200, { value: this.versions.map((v) => ({ kid: `${KV_KEY}/${v.ver}`, attributes: { enabled: v.enabled, created: v.created } })), nextLink: null });
    }
    const m = new RegExp(`^${base}/([0-9a-f]{32})(/sign)?$`).exec(path);
    const v = m && this.versions.find((x) => x.ver === m[1]);
    if (!v) return json(404, { error: { code: 'KeyNotFound' } });
    if (method === 'GET') return json(200, { key: this.jwkOf(v) });
    if (this.refuseSign.has(v.ver)) return json(403, { error: { code: 'Forbidden' } });
    const digest = Buffer.from(String(body!.value), 'base64url');
    const sig = privateEncrypt({ key: v.priv, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO_SHA256, digest]));
    return json(200, { kid: `${KV_KEY}/${v.ver}`, value: sig.toString('base64url') });
  }) as unknown as typeof fetch;
}

describe('KeyVaultRsaSigner: the RS256 id_token key (#5454 A7)', () => {
  const make = (kv: FakeRsaVault, slept: number[] = []) =>
    new KeyVaultRsaSigner({ cloud: 'commercial', keyUrl: KV_KEY, getToken: async () => 't', fetchImpl: kv.fetch, sleep: async (ms) => void slept.push(ms) });
  const thumb = (kv: FakeRsaVault, ver: string) => {
    const { n, e } = kv.versions.find((v) => v.ver === ver)!.priv.export({ format: 'jwk' });
    return calculateJwkThumbprint({ kty: 'RSA', n: n!, e: e! }, 'sha256');
  };

  it('a 404 GET creates an RSA-HSM key, waits to settle, and the id_token it signs verifies RS256 against publicJwks', async () => {
    const kv = new FakeRsaVault();
    const slept: number[] = [];
    const s = make(kv, slept);
    const jwt = await mintIdToken(s, { issuer: 'https://as.test/auth/visn-01', clientId: 'app-1', sub: 'o', now: new Date() });
    const create = kv.calls.filter((c) => c.path.endsWith('/create'));
    // Breaks if a 404 does not lead to exactly one create, or the create asks for a non-HSM / non-RSA / exportable key.
    expect(create).toHaveLength(1);
    expect(create[0]!.body).toEqual({ kty: 'RSA-HSM', key_size: 3072, key_ops: ['sign', 'verify'] });
    expect(slept).toEqual([3000]); // breaks if the race settle is skipped after a create
    // Real verification over the fake HSM's PKCS#1 v1.5 signature: breaks on a wrong digest, alg or kid.
    const { protectedHeader } = await jwtVerify(jwt, createLocalJWKSet({ keys: await s.publicJwks() }), { algorithms: ['RS256'], audience: 'app-1' });
    expect(protectedHeader.kid).toBe(await thumb(kv, kv.versions[0]!.ver));
    // Breaks if signing goes to the unversioned key URL.
    expect(kv.calls.find((c) => c.path.endsWith('/sign'))!.path).toBe(`${new URL(KV_KEY).pathname}/${kv.versions[0]!.ver}/sign`);
  });

  it('a 200 GET uses the existing key: no create, no settle wait', async () => {
    const kv = new FakeRsaVault();
    const ver = kv.add();
    const slept: number[] = [];
    const s = make(kv, slept);
    expect(await s.kid()).toBe(await thumb(kv, ver));
    // Breaks if an existing key is re-created (a new version on every start).
    expect(kv.calls.some((c) => c.path.endsWith('/create'))).toBe(false);
    expect(kv.calls.some((c) => c.path === new URL(KV_KEY).pathname)).toBe(true); // positive control: the GET happened
    expect(slept).toEqual([]);
  });

  it('a 403 on create surfaces an error naming the 403, signs nothing, and is not cached', async () => {
    const kv = new FakeRsaVault();
    kv.createStatus = 403;
    const s = make(kv);
    const err = await s.kid().catch((e: unknown) => e);
    // Breaks if the failure is swallowed, rephrased as another cause, or loses the status classifyError logs.
    expect(err).toBeInstanceOf(KeyVaultHttpError);
    expect((err as KeyVaultHttpError).statusCode).toBe(403);
    expect((err as Error).message).toBe('key vault returned 403 (Forbidden) creating id_token key lhds-as-idtoken-rs256');
    await expect(mintIdToken(s, { issuer: 'https://as.test', clientId: 'c', sub: 'o', now: new Date() })).rejects.toThrow('403');
    expect(kv.calls.some((c) => c.path.endsWith('/sign'))).toBe(false); // no signature from any key
    // Not cached: once creation is allowed, the next call reads and creates again. Breaks on a cached rejection.
    kv.createStatus = 200;
    expect(await s.kid()).toBe(await thumb(kv, kv.versions[0]!.ver));
    // GUARD, not no-fallback evidence: `alg` is a readonly constant, so no input can make this fail. It only pins the
    // declared value against a future edit. The no-fallback evidence is the server-level step=id_token 500 test.
    expect(s.alg).toBe('RS256');
  });

  it('with several versions (a create race) it signs with the OLDEST enabled one and publishes every enabled one', async () => {
    const kv = new FakeRsaVault();
    const disabled = kv.add(50, false); // oldest of all, but disabled
    const newer = kv.add(200); // listed before `older`
    const older = kv.add(100);
    const s = make(kv);
    // Breaks if the pick is first-listed or latest (`newer`), or ignores `enabled` (`disabled`): replicas would diverge.
    expect(await s.kid()).toBe(await thumb(kv, older));
    const kids = (await s.publicJwks()).map((k) => k.kid);
    // Breaks if only the signing version is published (another replica's pick would be missing from this JWKS).
    expect(kids).toEqual([await thumb(kv, older), await thumb(kv, newer)]);
    expect(kids).not.toContain(await thumb(kv, disabled)); // paired with the positive list above
    await s.sign(Buffer.from('x'));
    expect(kv.calls.find((c) => c.path.endsWith('/sign'))!.path).toContain(older);
  });

  it('the sign call sends alg RS256 and the 32-byte SHA-256 digest of the signing input', async () => {
    const kv = new FakeRsaVault();
    kv.add();
    const s = make(kv);
    const sig = await s.sign(Buffer.from('header.payload'));
    expect(sig.length).toBe(256); // 2048-bit fake key; breaks if the length check is dropped and a short value passes
    const body = kv.calls.find((c) => c.path.endsWith('/sign'))!.body!;
    expect(body.alg).toBe('RS256'); // breaks on ES384 / RS384 / PS256
    const digest = Buffer.from(String(body.value), 'base64url');
    expect(digest.length).toBe(32); // breaks on SHA-384 (48) or the raw input (14)
    expect(digest.equals(createHash('sha256').update('header.payload').digest())).toBe(true);
  });

  it('a nextLink off the vault origin is refused before any request or token; a same-origin nextLink is followed', async () => {
    const vaultHost = new URL(KV_KEY).host;
    for (const evil of ['https://evil.example/keys/x/versions?page=2', `https://${vaultHost}.evil.example/keys/lhds-as-idtoken-rs256/versions?page=2`]) {
      const kv = new FakeRsaVault();
      kv.add();
      kv.firstPageNext = evil;
      const scopes: string[] = [];
      const s = new KeyVaultRsaSigner({ cloud: 'commercial', keyUrl: KV_KEY, getToken: async (sc) => (scopes.push(sc), 't'), fetchImpl: kv.fetch });
      // Breaks if the link is followed (the fake answers any host). The second URL starts with `https://<vault-host>`,
      // so a prefix check without the trailing slash would let it through.
      await expect(s.kid()).rejects.toThrow('key vault link left the vault origin');
      expect(kv.calls.filter((c) => c.host !== vaultHost)).toEqual([]);
      expect(kv.calls.some((c) => c.path.endsWith('/versions'))).toBe(true); // positive: page 1 WAS read on the vault
      // Breaks if getToken runs before the origin check: one token per vault call, none for the refused URL.
      expect(scopes).toHaveLength(kv.calls.length);
    }
    // Paired permit: the same paging with a same-origin nextLink resolves.
    const good = new FakeRsaVault();
    const ver = good.add();
    good.firstPageNext = `${KV_KEY}/versions?page=2`;
    const s = new KeyVaultRsaSigner({ cloud: 'commercial', keyUrl: KV_KEY, getToken: async () => 't', fetchImpl: good.fetch });
    expect(await s.kid()).toBe(await thumb(good, ver)); // breaks if same-origin paging is refused or page 2 is not read
  });

  it('a 4xx on sign drops the resolved version, so the next sign re-resolves instead of hitting the old kid', async () => {
    const kv = new FakeRsaVault();
    const old = kv.add(100);
    const s = make(kv);
    await s.sign(Buffer.from('a')); // resolves and signs with `old`
    // Out of band: the old version is disabled and a new one exists; the vault now refuses signing with `old`.
    kv.versions.find((v) => v.ver === old)!.enabled = false;
    kv.refuseSign.add(old);
    const fresh = kv.add(200);
    await expect(s.sign(Buffer.from('b'))).rejects.toThrow('403');
    await s.sign(Buffer.from('c'));
    const signs = kv.calls.filter((c) => c.path.endsWith('/sign')).map((c) => c.path);
    expect(signs).toHaveLength(3);
    expect(signs[1]).toContain(old); // positive control: the refused call really was the old version
    // Breaks if the state stays cached after the 403: the third sign hits `old` again and throws.
    expect(signs[2]).toContain(fresh);
    expect(await s.kid()).toBe(await thumb(kv, fresh));
  });

  it('idTokenKeyUrlFrom derives the same vault from the access-token key id, and the signer refuses a wrong-cloud URL', () => {
    // Breaks on another host, a versioned path, or a name other than the fixed one.
    expect(idTokenKeyUrlFrom('gcc-high', `https://kv-x.vault.usgovcloudapi.net/keys/lhds-as-signing/${'a'.repeat(32)}`)).toBe(
      `https://kv-x.vault.usgovcloudapi.net/keys/${ID_TOKEN_KEY_NAME}`,
    );
    expect(() => new KeyVaultRsaSigner({ cloud: 'gcc-high', keyUrl: KV_KEY, getToken: async () => 't' })).toThrow('id_token key url must be');
  });
});

describe('Entra federation exchange', () => {
  const AUTH = 'login.microsoftonline.us';
  const TID = '11111111-1111-1111-1111-111111111111';
  const CLIENT = 'cccccccc-0000-0000-0000-000000000001';
  async function setup(claims: Record<string, unknown>, aud = CLIENT) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ oid: 'o-1', tid: TID, nonce: 'n1', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(`https://${AUTH}/${TID}/v2.0`)
      .setAudience(aud)
      .setExpirationTime('5m')
      .sign(privateKey);
    const sent: string[] = [];
    const fed = createEntraFederation({
      authorityHost: AUTH,
      entraTenantId: TID,
      clientId: CLIENT,
      getClientAssertion: async () => 'assertion-value',
      keyResolver: async () => publicKey,
      fetchImpl: (async (u: string, init: RequestInit) => {
        sent.push(u, String(init.body));
        return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { fed, sent };
  }
  it('verifies issuer, audience and nonce; sends PKCE verifier and a client assertion (no secret)', async () => {
    const { fed, sent } = await setup({});
    expect(await fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'https://as/cb', nonce: 'n1' })).toEqual({ oid: 'o-1', tid: TID });
    expect(sent[0]).toBe(`https://${AUTH}/${TID}/oauth2/v2.0/token`);
    expect(sent[1]).toContain('code_verifier=v');
    expect(sent[1]).toContain('client_assertion=assertion-value');
    expect(sent[1]).not.toContain('client_secret');
    const url = new URL(fed.authorizeUrl({ state: 's', nonce: 'n', codeChallenge: 'ch', redirectUri: 'https://as/cb' }));
    expect(url.host).toBe(AUTH);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
  it('asks Entra for exactly "openid profile" on the authorize URL and the token request', async () => {
    // Breaks on scope "openid" alone: Entra then omits `oid` from the id_token (Learn, id-token-claims-reference)
    // and every real sign-in fails the requiredClaims check, which is what happened live on 2026-11-27.
    const { fed, sent } = await setup({});
    const url = new URL(fed.authorizeUrl({ state: 's', nonce: 'n', codeChallenge: 'ch', redirectUri: 'https://as/cb' }));
    expect(url.searchParams.get('scope')).toBe('openid profile');
    await fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'https://as/cb', nonce: 'n1' });
    expect(new URLSearchParams(sent[1]).get('scope')).toBe('openid profile'); // breaks if the token request drifts from the authorize scope
  });
  it('refuses a nonce mismatch and a foreign audience', async () => {
    await expect((await setup({})).fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r', nonce: 'other' })).rejects.toMatchObject({ reason: 'nonce_mismatch' }); // breaks if nonce is unchecked
    await expect((await setup({}, 'someone-else')).fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r', nonce: 'n1' })).rejects.toThrow();
  });
});

describe('Entra federation failure reasons (FederationError)', () => {
  const AUTH = 'login.microsoftonline.com';
  const TID = '11111111-1111-1111-1111-111111111111';
  const CLIENT = 'cccccccc-0000-0000-0000-000000000001';
  async function fedWith(respond: (idToken: string) => Response, claims: Record<string, unknown>) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(`https://${AUTH}/${TID}/v2.0`)
      .setAudience(CLIENT)
      .setExpirationTime('5m')
      .sign(privateKey);
    return createEntraFederation({
      authorityHost: AUTH, entraTenantId: TID, clientId: CLIENT, getClientAssertion: async () => 'assertion-value', keyResolver: async () => publicKey,
      fetchImpl: (async () => respond(idToken)) as unknown as typeof fetch,
    });
  }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const caught = async (fed: Awaited<ReturnType<typeof fedWith>>, nonce = 'n1') => {
    try {
      await fed.exchange({ code: 'the-auth-code', codeVerifier: 'v', redirectUri: 'https://as/cb', nonce });
    } catch (e) {
      return e as FederationError;
    }
    throw new Error('exchange did not throw');
  };

  it('an openid-only id_token (no oid) is id_token_invalid naming the claim, not a bare throw', async () => {
    // The live 2026-11-27 failure: tid + nonce present, oid absent. Breaks if oid is not required, or if the
    // reason loses the jose code or the claim NAME.
    const e = await caught(await fedWith((t) => json({ id_token: t }), { tid: TID, nonce: 'n1' }));
    expect(e).toBeInstanceOf(FederationError);
    expect(e.reason).toBe('id_token_invalid:ERR_JWT_CLAIM_VALIDATION_FAILED:oid');
  });
  it('a token-endpoint 400 carries status, Entra error token and first error code, and nothing from the body', async () => {
    const body = { error: 'invalid_grant', error_description: 'AADSTS70008: secret-trace-xyz', error_codes: [70008, 1], trace_id: 'trace-123' };
    const e = await caught(await fedWith(() => json(body, 400), {}));
    expect([e.reason, e.entraError, e.entraErrorCode]).toEqual(['token_endpoint_400', 'invalid_grant', 70008]); // breaks on the old untyped Error
    expect(JSON.stringify({ ...e, m: e.message })).not.toMatch(/secret-trace-xyz|trace-123|the-auth-code/); // breaks if the body or the code is copied in
  });
  it('a non-JSON token-endpoint 502 is the status class with no Entra fields; a bad Entra error token is dropped', async () => {
    const e = await caught(await fedWith(() => new Response('<html>gateway</html>', { status: 502 }), {}));
    expect([e.reason, e.entraError, e.entraErrorCode]).toEqual(['token_endpoint_502', undefined, undefined]);
    const e2 = await caught(await fedWith(() => json({ error: 'Not An OAuth <token>', error_codes: ['70008'] }, 400), {}));
    expect([e2.reason, e2.entraError, e2.entraErrorCode]).toEqual(['token_endpoint_400', undefined, undefined]); // breaks if free text or a string code is logged
  });
  it('id_token_missing, nonce_mismatch and a signature failure each get their own class', async () => {
    expect((await caught(await fedWith(() => json({ access_token: 'x' }), {}))).reason).toBe('id_token_missing');
    const good = { oid: 'o-1', tid: TID, nonce: 'n1' };
    expect((await caught(await fedWith((t) => json({ id_token: t }), good), 'other'))).toMatchObject({ reason: 'nonce_mismatch' });
    // Tamper the signature: ERR_JWS_SIGNATURE_VERIFICATION_FAILED, no claim suffix.
    expect((await caught(await fedWith((t) => json({ id_token: `${t.slice(0, -4)}AAAA` }), good))).reason).toBe('id_token_invalid:ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
  });
});
