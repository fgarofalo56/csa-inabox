// Pure-function contract tests for the Authorization Server core: scope grammar,
// ceiling intersection, per-cloud hosts, signer and federation seams.
// Each assertion names, in a comment, the defect that turns it red.

import { createHash } from 'node:crypto';
import { createLocalJWKSet, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { GRAPH_BY_CLOUD, KEYVAULT_SUFFIX_BY_CLOUD } from '../src/auth/clouds.js';
import { createEntraFederation, createGraphMembership, GraphConsentRequiredError } from '../src/auth/federation.js';
import { computeGrant } from '../src/auth/grant.js';
import { ROLES, ROLE_IDS, ceilingsFor } from '../src/auth/role-map.js';
import { intersectWithCeilings, parseDataScope, parseRequest, serializeScope } from '../src/auth/scopes.js';
import { KeyVaultSigner, LocalSigner } from '../src/auth/signer.js';
import { mintAccessToken } from '../src/auth/tokens.js';
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
  it('refuses a nonce mismatch and a foreign audience', async () => {
    await expect((await setup({})).fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r', nonce: 'other' })).rejects.toThrow('nonce'); // breaks if nonce is unchecked
    await expect((await setup({}, 'someone-else')).fed.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r', nonce: 'n1' })).rejects.toThrow();
  });
});
