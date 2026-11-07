import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const bicep = resolve(dir, '../../../platform/fiab/bicep');
const cp = readFileSync(resolve(bicep, 'modules/health/control-plane.bicep'), 'utf8');
const health = readFileSync(resolve(bicep, 'health.bicep'), 'utf8');
// The container names and env names the service reads, lifted from its own source at runtime.
const types = readFileSync(resolve(dir, '../src/auth/types.ts'), 'utf8');

describe('control-plane.bicep authorization-server infra (W1-4)', () => {
  it('creates exactly the three auth containers the service names, replay and grants with TTL -1', () => {
    // Input that breaks it: a renamed container (service says health-auth-replay, bicep says health-auth-jti)
    // or defaultTtl 0 / missing on replay or grants (per-item ttl silently ignored, replay ids never expire).
    const names = [...types.matchAll(/'(health-auth-[a-z]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['health-auth-config', 'health-auth-grants', 'health-auth-replay']);
    for (const n of names) expect(cp, n).toContain(`name: '${n}'`);
    expect(cp).toContain("{ name: 'health-auth-replay', defaultTtl: -1 }");
    expect(cp).toContain("{ name: 'health-auth-grants', defaultTtl: -1 }");
    expect(cp).toContain("{ name: 'health-auth-config', defaultTtl: 0 }");
    expect(cp).toContain('defaultTtl: c.defaultTtl == 0 ? null : c.defaultTtl');
  });

  it('sets the env names src/auth/config.ts reads (read from that file when it exists on this branch)', () => {
    // Input that breaks it: a typo such as LOOM_HEALTH_CP_ISSUER (the service would report it missing at startup).
    for (const name of ['LOOM_HEALTH_CP_ISSUER_URL', 'LOOM_HEALTH_CP_FHIR_BASE_URL', 'LOOM_HEALTH_CP_AS_CLIENT_ID', 'LOOM_HEALTH_CP_SIGNING_KEY_ID', 'LOOM_HEALTH_CP_GRAPH_CONSENT_URL']) {
      expect(cp, name).toContain(`name: '${name}'`);
    }
    let cfg: string | undefined;
    try {
      cfg = readFileSync(resolve(dir, '../src/auth/config.ts'), 'utf8');
    } catch {
      cfg = undefined; // the auth server wiring lands in a separate PR (W1-4); the bicep names are pinned above
    }
    if (cfg) for (const m of cfg.matchAll(/'(LOOM_HEALTH_CP_[A-Z_]+)'/g)) expect(cp, m[1]).toContain(`name: '${m[1]}'`);
  });

  it('never emits an empty env value, and never reports the federated credential as configured', () => {
    expect(cp).toContain('filter(authEnvSource, e => !empty(e.value))');
    expect(cp).toContain('output authFederatedCredential object');
    expect(health).toContain('authServerMissing: cpAuthMissing');
  });

  it('signing key is EC P-384 sign/verify with no rotation policy, and Crypto User is scoped to that key', () => {
    // Input that breaks it: RSA (the service rejects any key that is not EC P-384), a rotation policy (a
    // new version the JWKS does not publish), or a vault-scope Crypto User grant.
    const key = cp.slice(cp.indexOf("resource signingKey "), cp.indexOf('// Crypto User on the signing key'));
    expect(key).toContain("kty: 'EC-HSM'");
    expect(key).toContain("curveName: 'P-384'");
    expect(key).toContain("keyOps: ['sign', 'verify']");
    expect(key).not.toContain('rotationPolicy');
    const grant = cp.slice(cp.indexOf('resource cpSigningKeyUser'), cp.indexOf('var signingKeyIdEffective'));
    expect(grant).toContain('scope: signingKey');
    expect(grant).toContain('kvCryptoUserRoleId');
    expect(cp).toContain("var kvCryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'");
  });
});
