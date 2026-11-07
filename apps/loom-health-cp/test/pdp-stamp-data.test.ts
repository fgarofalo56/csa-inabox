import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPdpStampInputs, tenantBases } from '../src/pdp/pdp-stamp-data.js';
import type { RoutingEntry } from '../src/routing/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STAGE = resolve(here, '../../loom-health-pdp/tools/stage-policies.mjs');
const ISS = 'https://health-cp.example.test';
const JWKS = JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-384', kid: 'k1', x: 'x', y: 'y' }] });

const entry = (over: Partial<RoutingEntry>): RoutingEntry => ({
  tenantSlug: 'visn-01',
  stampId: 'stamp-a',
  stampBaseUrl: 'https://a.health.example.test',
  status: 'active',
  maxRequestsPerMinute: 100,
  ...over,
});

describe('buildPdpStampInputs', () => {
  it('homes only ACTIVE tenants of THIS stamp, with path-prefix fhir + dicomweb bases', () => {
    const out = buildPdpStampInputs(
      'stamp-a',
      [
        entry({}),
        // Breaks if: the stamp filter is dropped (stamp-b's tenant would be homed on stamp-a).
        entry({ tenantSlug: 'other-stamp-t', stampId: 'stamp-b' }),
        // Breaks if: status is ignored (a suspended tenant would keep a live token working).
        entry({ tenantSlug: 'suspended-t', status: 'unavailable' }),
        entry({ tenantSlug: 'paused-t', status: 'paused' }),
      ],
      ISS,
      JWKS,
    );
    expect(Object.keys(out.stamp.tenants)).toEqual(['visn-01']);
    expect(out.stamp.tenants['visn-01']?.bases).toEqual([
      'https://a.health.example.test/visn-01/fhir',
      'https://a.health.example.test/visn-01/dicomweb',
    ]);
    expect(out.config).toEqual({ issuer: ISS, jwks: JWKS });
  });

  it('an unconfigured stamp (no entries) homes no tenant', () => {
    const out = buildPdpStampInputs('stamp-c', [entry({})], ISS, JWKS);
    expect(out.stamp.tenants).toEqual({});
  });

  it('trims a trailing slash on the stamp base so the aud compare is exact', () => {
    expect(tenantBases('https://a.example.test///', 't1')[0]).toBe('https://a.example.test/t1/fhir');
  });

  it.each([
    ['non-https issuer', 'http://health-cp.example.test', JWKS, 'issuer must be https'],
    ['issuer not a URL', 'not a url', JWKS, 'issuer is not a URL'],
    ['jwks not JSON', ISS, '{nope', 'jwks is not valid JSON'],
    ['jwks without keys', ISS, '{"keys":[]}', 'jwks has no keys'],
    ['jwks null', ISS, 'null', 'jwks has no keys'],
  ])('rejects %s', (_n, iss, jwks, msg) => {
    expect(() => buildPdpStampInputs('stamp-a', [entry({})], iss, jwks)).toThrow(msg);
  });
});

describe('stage-policies.mjs --stamp-inputs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lhds-stage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stage = (inputs: unknown) => {
    const f = join(dir, 'inputs.json');
    writeFileSync(f, JSON.stringify(inputs));
    return spawnSync('node', [STAGE, join(dir, 'out'), '--stamp-inputs', f], { encoding: 'utf8' });
  };

  it('writes data.lhds.config + data.lhds.stamp next to the staged role map', () => {
    const inputs = buildPdpStampInputs('stamp-a', [entry({})], ISS, JWKS);
    const r = stage(inputs);
    expect(r.status).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, 'out/lhds/config/data.json'), 'utf8'));
    const st = JSON.parse(readFileSync(join(dir, 'out/lhds/stamp/data.json'), 'utf8'));
    expect(cfg).toEqual({ issuer: ISS, jwks: JWKS });
    expect(st).toEqual(inputs.stamp);
    // the scope matrix is still the single role map, staged unchanged
    const map = JSON.parse(readFileSync(join(dir, 'out/lhds/rolemap/data.json'), 'utf8'));
    expect(map.version).toBe('lhds-scope-map/1');
  });

  it('without --stamp-inputs the bundle carries no config/stamp (denies everything)', () => {
    execFileSync('node', [STAGE, join(dir, 'bare')]);
    expect(() => readFileSync(join(dir, 'bare/lhds/config/data.json'))).toThrow();
    expect(readFileSync(join(dir, 'bare/lhds/rolemap/data.json'), 'utf8')).toContain('lhds-scope-map/1');
  });

  it.each([
    ['http issuer', { config: { issuer: 'http://x.test', jwks: JWKS } }],
    ['jwks without keys', { config: { issuer: ISS, jwks: '{"keys":[]}' } }],
    ['bad tenant slug', { stamp: { tenants: { 'Bad_Slug': { bases: ['https://a.test/x/fhir'] } } } }],
    ['tenant with no bases', { stamp: { tenants: { 'visn-01': { bases: [] } } } }],
    ['non-https base', { stamp: { tenants: { 'visn-01': { bases: ['http://a.test/x/fhir'] } } } }],
  ])('refuses to stage %s (exit 1, nothing written)', (_n, over) => {
    const good = buildPdpStampInputs('stamp-a', [entry({})], ISS, JWKS);
    const r = stage({ ...good, ...over });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('stamp inputs invalid');
    expect(() => readFileSync(join(dir, 'out/lhds/stamp/data.json'))).toThrow();
  });
});
