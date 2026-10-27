// compose() must actually serve the Authorization Server and register the
// tenant jobs; main.ts must refuse to start without the AS configuration.
// Each assertion names the value that breaks it.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthServerConfig } from '../src/auth/config.js';
import { LocalSigner } from '../src/auth/signer.js';
import type { AuthStores } from '../src/auth/types.js';
import { compose } from '../src/compose.js';
import { ConfigError } from '../src/config.js';
import type { TenantArm } from '../src/jobs/tenant-arm.js';
import type { TenantDoc } from '../src/registry/types.js';
import { AUDIENCE, AUTHORITY, MemoryCollection, TENANT, memoryStores, testKeyResolver } from './helpers.js';

const ISSUER = 'https://cp.test/auth';
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function boot(wired: boolean, tenantArm?: TenantArm) {
  const stores = memoryStores();
  const base = { stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' };
  await (stores.tenants as unknown as MemoryCollection<TenantDoc>).create({ id: 'visn-01', displayName: 'V1', status: 'active', ...base });
  const app = compose({
    stores,
    auth: { authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [], keyResolver: testKeyResolver },
    sloAvailabilityTarget: 0.999,
    log: () => undefined,
    ...(tenantArm ? { tenantArm } : {}),
    ...(wired
      ? {
          authServer: {
            issuer: ISSUER,
            cloud: 'gcc-high' as const,
            entraTenantId: TENANT,
            stores: { bindings: new MemoryCollection(), clients: new MemoryCollection(), replay: new MemoryCollection(), grants: new MemoryCollection() } as unknown as AuthStores,
            signer: new LocalSigner(),
            federation: { authorizeUrl: () => 'https://entra.test/a', exchange: async () => ({ oid: 'o', tid: TENANT }) },
            graph: { memberOf: async () => [] },
            fhirBaseFor: (t: string) => `https://edge.test/${t}/fhir`,
            fetchJwks: async () => ({ keys: [], maxAgeS: 0 }),
          },
        }
      : {}),
  });
  const server = createServer((req, res) => void app.handler(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, get: async (p: string) => fetch(url + p) };
}

describe('authorization server is served by compose()', () => {
  it('jwks, discovery and the admin family answer only when wired', async () => {
    const off = await boot(false);
    // 404 breaks (turns 200) only if something else serves the path; the wired arm below is the paired permit.
    expect((await off.get('/auth/jwks.json')).status).toBe(404);
    expect((await off.get('/auth/visn-01/.well-known/smart-configuration')).status).toBe(404);
    expect((await off.get('/api/health/auth/readiness')).status).toBe(404);

    const on = await boot(true);
    const jwks = await on.get('/auth/jwks.json');
    expect(jwks.status).toBe(200);
    const key = ((await jwks.json()) as { keys: Array<Record<string, unknown>> }).keys[0]!;
    expect(key.crv).toBe('P-384'); // breaks if a non-ES384 key (or nothing) is published
    expect(key.d).toBeUndefined(); // breaks if the private scalar leaks
    const disc = (await (await on.get('/auth/visn-01/.well-known/smart-configuration')).json()) as { token_endpoint: string };
    expect(disc.token_endpoint).toBe(`${ISSUER}/visn-01/token`); // breaks if the issuer is not the configured one
    // Admin routes sit behind the control-plane authenticator: no bearer => 401, not 404 and not 200.
    expect((await on.get('/api/health/auth/readiness')).status).toBe(401);
  });

  it('existing control-plane routes still answer when the server is wired', async () => {
    const on = await boot(true);
    expect((await on.get('/healthz')).status).toBe(200); // breaks if the chain swallows paths the AS does not own
    expect((await on.get('/api/health/stamps')).status).toBe(401); // reaches the control-plane authenticator
  });
});

describe('tenant jobs are registered when an ARM adapter is supplied', () => {
  it('tenant.create / tenant.destroy exist only with tenantArm', async () => {
    expect((await boot(false)).app.jobs.kinds()).not.toContain('tenant.create');
    const withArm = (await boot(false, {} as TenantArm)).app.jobs.kinds();
    expect(withArm).toContain('tenant.create'); // breaks if compose does not register tenantHandlers
    expect(withArm).toContain('tenant.destroy');
    expect(withArm).toContain('routing.publish'); // paired: existing handlers are kept
  });
});

describe('authorization server config fails closed with the variable named', () => {
  const good = {
    LOOM_HEALTH_CP_ISSUER_URL: 'https://cp.example/auth/',
    LOOM_HEALTH_CP_FHIR_BASE_URL: 'https://edge.example',
    LOOM_HEALTH_CP_AS_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
    LOOM_HEALTH_CP_SIGNING_KEY_ID: `https://kv-x.vault.usgovcloudapi.net/keys/lhds-sign/${'a'.repeat(32)}`,
  };
  it('accepts a complete set and trims the trailing slash', () => {
    expect(loadAuthServerConfig('gcc-high', good).issuer).toBe('https://cp.example/auth');
  });
  for (const name of Object.keys(good)) {
    it(`names ${name} when it is the only one missing`, () => {
      const env = { ...good, [name]: '' };
      // Breaks (no throw, or another name in the message) if the required check is removed or reports the wrong variable.
      expect(() => loadAuthServerConfig('gcc-high', env)).toThrow(new ConfigError(`missing required environment for the authorization server: ${name}`));
    });
  }
  it('rejects a key id from the wrong cloud suffix without echoing it', () => {
    const env = { ...good, LOOM_HEALTH_CP_SIGNING_KEY_ID: `https://kv-x.vault.azure.net/keys/lhds-sign/${'a'.repeat(32)}` };
    expect(() => loadAuthServerConfig('gcc-high', env)).toThrow(/LOOM_HEALTH_CP_SIGNING_KEY_ID must be a versioned Key Vault key id/);
    expect(loadAuthServerConfig('commercial', env).signingKeyId).toBe(env.LOOM_HEALTH_CP_SIGNING_KEY_ID); // paired permit: same id, right cloud
  });
});
