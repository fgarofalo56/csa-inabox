import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideEdge,
  MAP_UNAVAILABLE_RETRY_AFTER_SECONDS,
  tenantFromPath,
  type EdgeRequest,
} from '../src/routing/edge.js';
import { buildRoutingMap, ROUTING_CACHE_TTL_SECONDS } from '../src/routing/publisher.js';
import type { RoutingMapDoc } from '../src/routing/types.js';
import { SLUG, type StampDoc, type TenantDoc } from '../src/registry/types.js';

const ts = '2026-10-24T00:00:00.000Z';
const stamp = (id: string, status: StampDoc['status'], extra: Partial<StampDoc> = {}): StampDoc => ({
  id, displayName: id, cloud: 'gcc-high', region: 'usgovvirginia', class: 'M', status,
  baseUrl: `https://${id}.example.us`, engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', ...extra,
});
const tenant = (id: string, stampId: string, rpm: number, status: TenantDoc['status'] = 'active'): TenantDoc => ({
  id, displayName: id, stampId, status, quotas: { maxRequestsPerMinute: rpm, maxStorageGiB: 1 }, createdAt: ts, updatedAt: ts, updatedBy: 't',
});

function mapOf(stamps: StampDoc[], tenants: TenantDoc[]): RoutingMapDoc {
  return { id: 'current', version: 'v', generatedAt: ts, cacheTtlSeconds: 60, entries: buildRoutingMap(stamps, tenants).entries };
}
const req = (path: string, tokenTenant: string[] | undefined, used = 0, reset = 17): EdgeRequest => ({
  path, tokenTenant, usedInWindow: used, windowResetsInSeconds: reset,
});

describe('decideEdge (reference model of the APIM fragment)', () => {
  // acme quota 3, zeta quota 500: distinct on purpose, so a swapped lookup cannot pass.
  const map = mapOf([stamp('s1', 'healthy'), stamp('s2', 'healthy')], [tenant('acme', 's1', 3), tenant('zeta', 's2', 500)]);

  it('tenant A path with tenant B token is 403 even though both tenants exist', () => {
    // breaks if the check is missing or compares anything but the claim to the URL tenant: result would be 200
    expect(decideEdge(map, req('/acme/fhir/Patient/1', ['zeta']))).toMatchObject({ status: 403, code: 'tenant_mismatch' });
  });

  it('positive control: the matching token reaches the tenant stamp, not the other tenant stamp', () => {
    expect(decideEdge(map, req('/acme/fhir/Patient/1', ['acme']))).toEqual({ status: 200, stampBaseUrl: 'https://s1.example.us' });
    expect(decideEdge(map, req('/zeta/dicomweb/studies', ['zeta']))).toEqual({ status: 200, stampBaseUrl: 'https://s2.example.us' });
  });

  it('a mismatch on a tenant that does not exist is 403, not 404 (no tenant enumeration)', () => {
    expect(decideEdge(map, req('/ghost/fhir/Patient', ['acme'])).status).toBe(403);
  });

  it.each([
    ['missing claim', undefined],
    ['empty claim', []],
    ['two values incl. the right one', ['acme', 'zeta']],
    ['prefix of the tenant', ['acm']],
    ['case-different', ['ACME']],
  ])('token with %s is 403', (_n, claim) => {
    expect(decideEdge(map, req('/acme/fhir/Patient', claim as string[] | undefined)).status).toBe(403);
  });

  it('429 with Retry-After exactly at the quota boundary: call 3 of 3 passes, call 4 is refused', () => {
    expect(decideEdge(map, req('/acme/fhir/Patient', ['acme'], 2)).status).toBe(200);
    expect(decideEdge(map, req('/acme/fhir/Patient', ['acme'], 3))).toMatchObject({ status: 429, retryAfterSeconds: 17 });
  });

  it('the quota is the tenant own: acme at 3 is refused while zeta at 3 passes', () => {
    expect(decideEdge(map, req('/zeta/fhir/Patient', ['zeta'], 3)).status).toBe(200);
  });

  it('Retry-After is never 0 or negative', () => {
    expect(decideEdge(map, req('/acme/fhir/Patient', ['acme'], 9, 0)).retryAfterSeconds).toBe(1);
  });

  it('paused stamp: 503 with the published Retry-After, checked before the quota', () => {
    const m = mapOf([stamp('s1', 'paused', { pauseReason: 'estate-power' })], [tenant('acme', 's1', 3)]);
    expect(decideEdge(m, req('/acme/fhir/Patient', ['acme'], 99))).toMatchObject({ status: 503, code: 'tenant_paused', retryAfterSeconds: 60 });
  });

  it('unavailable tenant: 503 with a default Retry-After', () => {
    const m = mapOf([stamp('s1', 'healthy')], [tenant('acme', 's1', 3, 'suspended')]);
    expect(decideEdge(m, req('/acme/fhir/Patient', ['acme']))).toMatchObject({ status: 503, code: 'tenant_unavailable', retryAfterSeconds: 60 });
  });

  it('no map and no last-known-good: 503 with Retry-After, only after the token check', () => {
    expect(decideEdge(undefined, req('/acme/fhir/Patient', ['acme']))).toEqual({
      status: 503, code: 'routing_map_unavailable', retryAfterSeconds: MAP_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
    expect(decideEdge(undefined, req('/acme/fhir/Patient', ['zeta'])).status).toBe(403);
  });

  it.each(['/', '/A', '/-x/fhir', '/x-/fhir', '/a/fhir', ''])('path %j is not a tenant route: 404', (p) => {
    expect(decideEdge(map, req(p, ['acme'])).status).toBe(404);
  });

  it('tenantFromPath takes the first segment only', () => {
    expect(tenantFromPath('/acme/fhir/zeta')).toBe('acme');
  });
});

// ---- the fragment itself: pinned to the model, constants lifted from the sources ----
const fragmentPath = resolve(__dirname, '../../../platform/fiab/bicep/modules/health/policies/lhds-tenant-routing.fragment.xml');
const xml = readFileSync(fragmentPath, 'utf8');
const dec = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('lhds-tenant-routing.fragment.xml', () => {
  it('uses the exact SLUG pattern the registry enforces (lifted at runtime, not transcribed)', () => {
    expect(dec(xml)).toContain(`"${SLUG.source}"`);
  });

  it('403 is returned for the tenant mismatch and sits after validate-jwt and before the map fetch', () => {
    const jwt = xml.indexOf('<validate-jwt');
    const forbidden = xml.indexOf('<set-status code="403"');
    const fetch = xml.indexOf('<send-request');
    expect(jwt).toBeGreaterThan(-1);
    expect(forbidden).toBeGreaterThan(jwt);
    expect(fetch).toBeGreaterThan(forbidden);
    // the compared claim is the one the authorization server mints (tokens.ts: `tenant`)
    expect(dec(xml)).toContain('Claims.GetValueOrDefault("tenant"');
  });

  it('validate-jwt does not itself reject a tenant mismatch (that would be 401, not 403)', () => {
    const block = xml.slice(xml.indexOf('<validate-jwt'), xml.indexOf('</validate-jwt>'));
    expect(block).toContain('<claim name="tenant" match="any" />'); // presence only: no <value> children
    expect(block).not.toContain('<value>');
  });

  it('caches the map for the published TTL and keeps a longer last-known-good copy', () => {
    const ttls = [...xml.matchAll(/<cache-store-value key="([^"]+)"[^>]*duration="(\d+)"/g)].map((m) => [m[1], Number(m[2])]);
    expect(ttls).toEqual([['lhds-routing-map', ROUTING_CACHE_TTL_SECONDS], ['lhds-routing-map-lkg', 86400]]);
  });

  it('rate-limits per tenant in a 60 s window using the published per-tenant quota field', () => {
    expect(xml).toMatch(/renewal-period="60"/);
    expect(dec(xml)).toContain('counter-key="@("lhds-tenant-" + (string)context.Variables["lhdsTenant"])"');
    expect(dec(xml)).toContain('["maxRequestsPerMinute"]');
    expect(xml).not.toMatch(/counter-key="[^"]*(IpAddress|Subscription)/); // a caller-IP key would share one quota across tenants
  });

  it('uses only policies available in classic tiers and Gov (no *-v2-only, no llm-* / ai-* policies)', () => {
    const used = new Set([...xml.matchAll(/<([a-z][a-z-]+)[\s>/]/g)].map((m) => m[1]));
    for (const banned of ['llm-token-limit', 'azure-openai-token-limit', 'validate-azure-ad-token']) {
      expect(used.has(banned), banned).toBe(false);
    }
    expect(used.has('rate-limit-by-key')).toBe(true);
    expect(used.has('validate-jwt')).toBe(true);
  });

  it('leaves exactly the documented placeholders for ingress.bicep to substitute', () => {
    expect([...new Set(xml.match(/__[A-Z_]+__/g))].sort()).toEqual(
      ['__AS_ISSUER__', '__AS_OPENID_CONFIG_URL__', '__CP_AUDIENCE__', '__CP_BASE_URL__', '__DEFAULT_RPM__'],
    );
  });
});

describe('APIM quota ordering and bicep wiring (#5149)', () => {
  const rl = xml.indexOf('<rate-limit-by-key');
  it('the tenant quota is charged only after the tenant is authenticated, matched, known and active', () => {
    // Input that breaks it: moving <rate-limit-by-key> above validate-jwt / the 403 / the 404 lets an
    // unauthenticated caller or an unknown slug create and drain a per-tenant counter.
    expect(rl).toBeGreaterThan(xml.lastIndexOf('<validate-jwt'));
    expect(rl).toBeGreaterThan(xml.indexOf('<set-status code="403"'));
    expect(rl).toBeGreaterThan(xml.indexOf('<set-status code="404" reason="Not Found" />', xml.indexOf('lhdsRoute')));
    expect(rl).toBeGreaterThan(xml.indexOf('<set-status code="503" reason="Service Unavailable" />', xml.indexOf('lhdsRoute')));
    expect(rl).toBeLessThan(xml.indexOf('<set-backend-service')); // a 429 never reaches the stamp
  });

  const bicepDir = resolve(__dirname, '../../../platform/fiab/bicep');
  const health = readFileSync(resolve(bicepDir, 'health.bicep'), 'utf8');
  const access = readFileSync(resolve(bicepDir, 'modules/health/apim-access.bicep'), 'utf8');

  it('the discovery URL is tenant-independent (no tenant segment, not the per-tenant smart-configuration)', () => {
    // Input that breaks it: deriving the URL from '/{tenant}/.well-known/smart-configuration'.
    expect(health).toContain("'${apimIssuer}/.well-known/openid-configuration'");
    expect(health).not.toMatch(/authServerOpenIdConfigUrl:[^\n]*smart-configuration/);
  });

  it('APIM identity gets the built-in Reader role on the control-plane resource, not a group or subscription', () => {
    // Input that breaks it: a different role id (e.g. Contributor) or a resourceGroup()/subscription() scope.
    expect(access).toContain("var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'");
    const scopes = [...access.matchAll(/^\s+scope: (\w+)$/gm)].map((m) => m[1]).sort();
    expect(scopes).toEqual(['cluster', 'cpApp']);
  });

  it('health.bicep invokes both APIM modules only when the control plane is deployed', () => {
    expect(health).toMatch(/var apimDeploy = cpDeploy && /);
    expect(health).toMatch(/module healthApimFragment [^\n]*= if \(apimDeploy\)/);
    expect(health).toMatch(/module healthApimAccess [^\n]*= if \(apimDeploy\)/);
  });
});
