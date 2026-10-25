import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveAuthorityHost } from '../src/config.js';
import { Registry } from '../src/registry/registry.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { evaluateStamp, SloService, STALE_AFTER_MS } from '../src/slo/aggregate.js';
import type { SloSampleDoc } from '../src/slo/types.js';
import { MemoryCollection, stampBody, tenantBody } from './helpers.js';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('Registry', () => {
  function mk() {
    const stamps = new MemoryCollection<StampDoc>();
    const tenants = new MemoryCollection<TenantDoc>();
    return { stamps, tenants, reg: new Registry(stamps, tenants, () => NOW) };
  }

  it('retries an etag race and applies the patch on the fresh document', async () => {
    const { stamps, reg } = mk();
    await reg.createStamp(stampBody(), 'a');
    let raced = false;
    const realReplace = stamps.replace.bind(stamps);
    stamps.replace = async (doc) => {
      if (!raced) {
        raced = true;
        await realReplace({ ...(await stamps.get('stamp-a'))!, deploySha: 'deadbee' }); // concurrent writer
      }
      return realReplace(doc);
    };
    const out = await reg.updateStamp('stamp-a', { displayName: 'Renamed' }, 'b');
    expect(out.displayName).toBe('Renamed');
    expect(out.deploySha).toBe('deadbee'); // breaks if the retry reuses the stale read and overwrites the other writer
  });

  it('pauseReason is only kept while paused', async () => {
    const { reg } = mk();
    await reg.createStamp(stampBody(), 'a');
    await reg.updateStamp('stamp-a', { status: 'healthy' }, 'a');
    const p = await reg.updateStamp('stamp-a', { status: 'paused', pauseReason: 'estate-power' }, 'a');
    expect(p.pauseReason).toBe('estate-power');
    const r = await reg.updateStamp('stamp-a', { status: 'healthy' }, 'a');
    expect(r.pauseReason).toBeUndefined();
  });

  it('a draining or evacuated stamp cannot take a new tenant', async () => {
    const { reg } = mk();
    await reg.createStamp(stampBody(), 'a');
    await reg.updateStamp('stamp-a', { status: 'healthy' }, 'a');
    await reg.updateStamp('stamp-a', { status: 'draining' }, 'a');
    await expect(reg.createTenant(tenantBody(), 'a')).rejects.toMatchObject({ status: 409 });
  });

  it('records the acting identity on writes', async () => {
    const { reg } = mk();
    const s = await reg.createStamp(stampBody(), 'oid-123');
    expect(s.updatedBy).toBe('oid-123');
    expect(s.updatedAt).toBe(NOW.toISOString());
  });

  it('rejects a tenant drain to an unregistered stamp (400)', async () => {
    const { reg } = mk();
    await reg.createStamp(stampBody(), 'a');
    await reg.createTenant(tenantBody(), 'a');
    await reg.updateTenant('visn-01', { status: 'active' }, 'a');
    await expect(
      reg.updateTenant('visn-01', { status: 'draining', drainTargetStampId: 'ghost' }, 'a'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

const sample = (o: Partial<SloSampleDoc> = {}): SloSampleDoc => ({
  id: 'stamp-a', windowStart: 'x', windowEnd: 'y', totalRequests: 1_000_000, goodRequests: 1_000_000, p95LatencyMs: 100,
  capacityUsedPercent: 10, reportedAt: NOW.toISOString(), reportedBy: 'r', ...o,
});
const stampDoc = { id: 'stamp-a', status: 'healthy' } as StampDoc;

describe('SLO evaluation (target 0.999)', () => {
  it.each([
    ['all good, low capacity', sample(), 'ok'],
    ['availability exactly at target (1000 bad of 1,000,000) is at-risk, not breached', sample({ goodRequests: 999_000 }), 'at-risk'],
    ['availability below target', sample({ goodRequests: 998_999 }), 'breached'],
    ['budget 80% consumed (800 bad)', sample({ goodRequests: 999_200 }), 'at-risk'],
    ['budget 79% consumed (790 bad) stays ok', sample({ goodRequests: 999_210 }), 'ok'],
    ['capacity 85%', sample({ capacityUsedPercent: 85 }), 'at-risk'],
    ['capacity 84%', sample({ capacityUsedPercent: 84 }), 'ok'],
    ['zero requests', sample({ totalRequests: 0, goodRequests: 0 }), 'no-data'],
  ])('%s => %s', (_n, s, state) => {
    expect(evaluateStamp(stampDoc, s, 0.999, NOW).state).toBe(state);
  });

  it('no sample at all is no-data and stale', () => {
    expect(evaluateStamp(stampDoc, undefined, 0.999, NOW)).toMatchObject({ state: 'no-data', stale: true, availability: null });
  });

  it('flags a sample older than the stale window, but not one just inside it', () => {
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 1000).toISOString();
    const fresh = new Date(NOW.getTime() - STALE_AFTER_MS + 1000).toISOString();
    expect(evaluateStamp(stampDoc, sample({ reportedAt: old }), 0.999, NOW).stale).toBe(true);
    expect(evaluateStamp(stampDoc, sample({ reportedAt: fresh }), 0.999, NOW).stale).toBe(false);
  });

  it('error budget remaining is 0.5 at half consumption and never negative', () => {
    expect(evaluateStamp(stampDoc, sample({ goodRequests: 999_500 }), 0.999, NOW).errorBudgetRemaining).toBeCloseTo(0.5, 6);
    expect(evaluateStamp(stampDoc, sample({ goodRequests: 900_000 }), 0.999, NOW).errorBudgetRemaining).toBe(0);
  });

  it('fleet: worst state wins and availability is request-weighted, not a mean of stamp ratios', async () => {
    const stamps = new MemoryCollection<StampDoc>();
    const samples = new MemoryCollection<SloSampleDoc>();
    await stamps.create({ ...stampDoc, id: 'stamp-a' });
    await stamps.create({ ...stampDoc, id: 'stamp-b' });
    await stamps.create({ ...stampDoc, id: 'stamp-c' });
    await samples.create(sample({ id: 'stamp-a', totalRequests: 900_000, goodRequests: 900_000 }));
    await samples.create(sample({ id: 'stamp-b', totalRequests: 100_000, goodRequests: 50_000 }));
    const rep = await new SloService(stamps, samples, 0.999, () => NOW).report();
    expect(rep.fleet.state).toBe('breached');
    expect(rep.fleet.availability).toBeCloseTo(950_000 / 1_000_000, 9); // unweighted mean would be 0.75
    expect(rep.fleet.byState).toEqual({ ok: 1, 'at-risk': 0, breached: 1, 'no-data': 1 });
  });
});

describe('config', () => {
  const base = {
    LOOM_HEALTH_CP_CLOUD: 'gcc-high',
    LOOM_HEALTH_CP_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    LOOM_HEALTH_CP_AUDIENCE: 'api://a, api://b',
    LOOM_HEALTH_CP_COSMOS_ENDPOINT: 'https://acct.documents.azure.us:443/',
  };
  it.each([
    ['commercial', 'login.microsoftonline.com'],
    ['gcc', 'login.microsoftonline.com'],
    ['gcc-high', 'login.microsoftonline.us'],
    ['il5', 'login.microsoftonline.us'],
    ['dod', 'login.microsoftonline.us'],
  ])('cloud %s uses authority %s', (cloud, host) => {
    expect(loadConfig({ ...base, LOOM_HEALTH_CP_CLOUD: cloud }).authorityHost).toBe(host);
  });
  it('parses the audience list and defaults', () => {
    const c = loadConfig(base);
    expect(c.audiences).toEqual(['api://a', 'api://b']);
    expect(c).toMatchObject({ port: 8080, cosmosDatabase: 'loom-health-cp', sloAvailabilityTarget: 0.999 });
  });
  it('fails closed naming every missing variable, and on a bad cloud', () => {
    expect(() => loadConfig({})).toThrow(/LOOM_HEALTH_CP_CLOUD.*LOOM_HEALTH_CP_TENANT_ID.*LOOM_HEALTH_CP_AUDIENCE.*LOOM_HEALTH_CP_COSMOS_ENDPOINT/);
    expect(() => loadConfig({ ...base, LOOM_HEALTH_CP_CLOUD: 'moon' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LOOM_HEALTH_CP_COSMOS_ENDPOINT: 'http://insecure' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET: '1' })).toThrow(/between 0 and 1/);
  });
  it('an authority override must be a bare hostname', () => {
    expect(resolveAuthorityHost('commercial', 'login.example.us')).toBe('login.example.us');
    expect(() => resolveAuthorityHost('commercial', 'evil.com/path?x')).toThrow(ConfigError);
  });
});
