import { createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleSignerFromConfig } from '../src/pdp/bundle-key.js';
import { verificationKeyPem } from '../src/pdp/bundle-sign.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { localBundleSigner } from './bundle-fixtures.js';
import { adminToken, mintToken, readerToken, startHarness, stampBody, ADMIN_APP, type Harness } from './helpers.js';

const K = (id: string) => `/api/health/pdp/stamps/${id}/verification-key`;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function harness(over: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  h = await startHarness(over);
  expect((await h.call('POST', '/api/health/stamps', { token: await adminToken(), body: stampBody('stamp-a') })).status).toBe(201);
  return h;
}

describe('GET /api/health/pdp/stamps/{id}/verification-key', () => {
  it('returns the PEM public key of the signing key (the value pdpBundleVerificationPublicKeyPem takes), to a Reader', async () => {
    const s = localBundleSigner();
    const hh = await harness({ bundleKey: () => verificationKeyPem(s) });
    const r = await hh.call('GET', K('stamp-a'), { token: await readerToken() });
    expect(r.status).toBe(200);
    // Breaks if the route returns the private half, another key, or a PEM that is not an EC P-256 SPKI key.
    expect(r.json.data.alg).toBe('ES256');
    expect(r.json.data.keyId).toBe('global'); // must equal engines.bicep signing.keyid
    expect(r.json.data.publicKeyPem).toBe(s.publicPem());
    const k = createPublicKey(r.json.data.publicKeyPem);
    expect(k.asymmetricKeyType).toBe('ec');
    expect(k.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(JSON.stringify(r.json)).not.toContain('PRIVATE');
  });

  it('is gated like the bundle: 401 without a token, 403 without a HealthCP role, 403 for a caller app outside the allowlist, 404 for an unknown stamp', async () => {
    const s = localBundleSigner();
    const hh = await harness({ bundleKey: () => verificationKeyPem(s), allowedCallerAppIds: [ADMIN_APP] });
    expect((await hh.call('GET', K('stamp-a'))).status).toBe(401);
    expect((await hh.call('GET', K('stamp-a'), { token: await mintToken({ roles: [], azp: ADMIN_APP }) })).status).toBe(403);
    // A valid Reader whose app is NOT on the allowlist must be refused: the allowlist applies on this path (Front Door exposes it).
    expect((await hh.call('GET', K('stamp-a'), { token: await mintToken({ roles: ['HealthCP.Reader'], azp: 'bbbbbbbb-0000-0000-0000-000000000002' }) })).status).toBe(403);
    // Positive control: the same role from an allowlisted app passes, so the refusals above are the allowlist and not a dead route.
    expect((await hh.call('GET', K('stamp-a'), { token: await mintToken({ roles: ['HealthCP.Reader'], azp: ADMIN_APP }) })).status).toBe(200);
    expect((await hh.call('GET', K('stamp-zz'), { token: await mintToken({ roles: ['HealthCP.Reader'], azp: ADMIN_APP }) })).status).toBe(404);
  });

  it('503 bundle_key_unconfigured when signing is off, and 503 bundle_key_unavailable (cause not claimed) when Key Vault cannot be read', async () => {
    const off = await harness();
    const r1 = await off.call('GET', K('stamp-a'), { token: await readerToken() });
    expect([r1.status, r1.json.error.code]).toEqual([503, 'bundle_key_unconfigured']);
    await off.close();
    h = await startHarness({ bundleKey: async () => { throw new Error('secret-host.vault.azure.net: 403'); } });
    await h.call('POST', '/api/health/stamps', { token: await adminToken(), body: stampBody('stamp-a') });
    const r2 = await h.call('GET', K('stamp-a'), { token: await readerToken() });
    expect([r2.status, r2.json.error.code]).toEqual([503, 'bundle_key_unavailable']);
    expect(JSON.stringify(r2.json)).not.toContain('secret-host'); // the vault error text is not echoed
  });
});

describe('LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID', () => {
  const base = {
    LOOM_HEALTH_CP_CLOUD: 'commercial',
    LOOM_HEALTH_CP_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    LOOM_HEALTH_CP_AUDIENCE: 'api://a',
    LOOM_HEALTH_CP_COSMOS_ENDPOINT: 'https://acct.documents.azure.com:443/',
  };
  const id = `https://v.vault.azure.net/keys/lhds-pdp-bundle-sign/${'b'.repeat(32)}`;

  it('unset means signing off (undefined signer); a valid id builds a P-256 signer', () => {
    expect(bundleSignerFromConfig(loadConfig(base))).toBeUndefined();
    expect(bundleSignerFromConfig(loadConfig({ ...base, LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID: id }))?.alg).toBe('ES256');
  });

  it.each([
    ['a Gov vault id on a Commercial control plane', `https://v.vault.usgovcloudapi.net/keys/k/${'b'.repeat(32)}`],
    ['a versionless id (the signing version would drift from the published key)', 'https://v.vault.azure.net/keys/k'],
    ['http', `http://v.vault.azure.net/keys/k/${'b'.repeat(32)}`],
  ])('refuses %s at startup with a message naming the variable, not echoing the value', (_n, bad) => {
    const cfg = loadConfig({ ...base, LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID: bad });
    expect(() => bundleSignerFromConfig(cfg)).toThrow(ConfigError);
    expect(() => bundleSignerFromConfig(cfg)).toThrow(/LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID/);
    expect(() => bundleSignerFromConfig(cfg)).not.toThrow(new RegExp(bad.slice(8, 20)));
  });
});
