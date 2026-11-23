// #5422 decision 13: the engine pins its PUBLIC FHIR base. The chain `engine server address == PDP bundle base == token aud`
// must hold byte for byte, so the CP renders the engine's address from the SAME function the bundle's bases come from.

import { describe, expect, it } from 'vitest';
import { renderEngineConfig } from '../src/jobs/fhir-tenant-config.js';
import { JobFailure } from '../src/jobs/types.js';
import { buildPdpStampInputs, tenantBases, tenantFhirBase } from '../src/pdp/pdp-stamp-data.js';
import type { RoutingEntry } from '../src/routing/types.js';

const IDENT = { name: 'id-lhds-dev01-acme-health-fhir', clientId: '11111111-2222-3333-4444-555555555555', principalId: 'aaaaaaaa-2222-3333-4444-555555555555' };
const input = (stampBaseUrl: string, tenantId = 'acme-health') => ({
  tenantId,
  stampId: 'dev01',
  stampBaseUrl,
  postgresFqdn: 'pg-dev01.postgres.database.azure.com',
  identity: IDENT,
  maxRequestsPerMinute: 600,
  pdpUrl: 'http://pdp.lhds.svc.cluster.local:8181',
  pgAdminName: 'id-lhds-dev01-pgadmin',
});

describe('engine public FHIR base (decision 13)', () => {
  it('renders HAPI_FHIR_SERVER_ADDRESS equal to the exact base the PDP bundle holds, for the same inputs', () => {
    // Breaks when: the env var is dropped (undefined), or the address is derived by any other string
    // (e.g. keeps the trailing slash, drops the tenant, ends in /fhir/ or /dicomweb).
    for (const raw of ['https://edge.example', 'https://edge.example/', 'https://edge.example///', 'https://edge.example/lhds']) {
      const env = renderEngineConfig(input(raw)).env;
      const entry: RoutingEntry = { tenantSlug: 'acme-health', stampId: 'dev01', stampBaseUrl: raw, status: 'active', maxRequestsPerMinute: 600 };
      const bundle = buildPdpStampInputs('dev01', [entry], 'https://issuer.example/auth', '{"keys":[{"kid":"k"}]}').stamp.tenants['acme-health']?.bases;
      expect(env.HAPI_FHIR_SERVER_ADDRESS, raw).toBe(tenantBases(raw, 'acme-health')[0]);
      expect(bundle?.[0], raw).toBe(env.HAPI_FHIR_SERVER_ADDRESS);
      expect(env.HAPI_FHIR_SERVER_ADDRESS, raw).toBe(tenantFhirBase(raw, 'acme-health'));
    }
    // A literal, so the helper cannot be wrong in the same way on both sides of the comparison.
    expect(renderEngineConfig(input('https://edge.example/')).env.HAPI_FHIR_SERVER_ADDRESS).toBe('https://edge.example/acme-health/fhir');
  });

  it('the address is per tenant and is part of the revision (a changed base rolls the pod)', () => {
    const a = renderEngineConfig(input('https://edge.example'));
    expect(renderEngineConfig(input('https://edge.example', 'other-co')).env.HAPI_FHIR_SERVER_ADDRESS).toBe('https://edge.example/other-co/fhir');
    // Breaks when: the address is added to env after the revision is hashed.
    expect(renderEngineConfig(input('https://edge2.example')).revision).not.toBe(a.revision);
    expect(renderEngineConfig(input('https://edge.example/')).revision, 'a trailing slash is the same base').toBe(a.revision);
  });

  it('fails closed with a precise JobFailure when the stamp has no usable base URL, and never renders an engine without it', () => {
    // Breaks when: an empty or malformed base renders `/acme-health/fhir` (or nothing) and the engine comes up refusing every token.
    for (const bad of ['', 'not a url', 'http://edge.example', 'https://u@edge.example', 'https://edge.example/?q=1']) {
      let thrown: unknown;
      try {
        renderEngineConfig(input(bad));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(JobFailure);
      expect((thrown as JobFailure).code, JSON.stringify(bad)).toBe('stamp_base_url_invalid');
      expect((thrown as JobFailure).message, JSON.stringify(bad)).toContain('stamp dev01');
    }
    // Positive pair: a good base renders.
    expect(() => renderEngineConfig(input('https://edge.example'))).not.toThrow();
  });
});
