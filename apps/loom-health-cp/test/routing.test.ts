import { describe, expect, it } from 'vitest';
import { buildRoutingMap, RoutingPublisher, versionOf } from '../src/routing/publisher.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import type { RoutingMapDoc } from '../src/routing/types.js';
import { MemoryCollection } from './helpers.js';

const ts = '2026-10-24T00:00:00.000Z';
const stamp = (id: string, status: StampDoc['status'], extra: Partial<StampDoc> = {}): StampDoc => ({
  id, displayName: id, cloud: 'gcc-high', region: 'usgovvirginia', class: 'M', status,
  baseUrl: `https://${id}.example.us`, engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', ...extra,
});
const tenant = (id: string, stampId: string, status: TenantDoc['status'] = 'active', extra: Partial<TenantDoc> = {}): TenantDoc => ({
  id, displayName: id, stampId, status, quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: ts, updatedAt: ts, updatedBy: 't', ...extra,
});

describe('buildRoutingMap', () => {
  it('maps an active tenant on a healthy stamp to that stamp base URL', () => {
    const { entries } = buildRoutingMap([stamp('s1', 'healthy')], [tenant('t1', 's1')]);
    expect(entries).toEqual([{ tenantSlug: 't1', stampId: 's1', stampBaseUrl: 'https://s1.example.us', status: 'active' }]);
  });

  it('a draining tenant keeps routing to its SOURCE stamp (ADR-006)', () => {
    const { entries } = buildRoutingMap(
      [stamp('src', 'healthy'), stamp('dst', 'healthy')],
      [tenant('t1', 'src', 'draining', { drainTargetStampId: 'dst' })],
    );
    // breaks if the map follows drainTargetStampId: stampId would be 'dst'
    expect(entries[0]).toMatchObject({ stampId: 'src', status: 'active' });
  });

  it('a paused stamp answers paused with Retry-After and the recorded reason', () => {
    const { entries } = buildRoutingMap([stamp('s1', 'paused', { pauseReason: 'estate-power' })], [tenant('t1', 's1')]);
    expect(entries[0]).toMatchObject({ status: 'paused', retryAfterSeconds: 60, reason: 'estate-power' });
  });

  it.each([
    ['creating', 'unavailable', 'stamp-creating'],
    ['evacuated', 'unavailable', 'stamp-evacuated'],
  ] as const)('stamp %s => %s', (st, status, reason) => {
    expect(buildRoutingMap([stamp('s1', st)], [tenant('t1', 's1')]).entries[0]).toMatchObject({ status, reason });
  });

  it('tenant states: creating and suspended are unavailable, destroying is omitted', () => {
    const r = buildRoutingMap(
      [stamp('s1', 'healthy')],
      [tenant('a', 's1', 'creating'), tenant('b', 's1', 'suspended'), tenant('c', 's1', 'destroying')],
    );
    expect(r.entries.map((e) => [e.tenantSlug, e.status])).toEqual([['a', 'unavailable'], ['b', 'unavailable']]);
    expect(r.skipped).toEqual([{ tenantSlug: 'c', reason: 'tenant-destroying' }]);
  });

  it('a tenant pointing at an unregistered stamp is skipped and reported, never routed', () => {
    const r = buildRoutingMap([stamp('s1', 'healthy')], [tenant('t1', 'ghost')]);
    expect(r.entries).toEqual([]);
    expect(r.skipped).toEqual([{ tenantSlug: 't1', reason: 'stamp-not-registered' }]);
  });

  it('is order-independent: version depends on content, not registry order', () => {
    const s = [stamp('s1', 'healthy')];
    const a = versionOf(buildRoutingMap(s, [tenant('a', 's1'), tenant('b', 's1')]).entries);
    const b = versionOf(buildRoutingMap(s, [tenant('b', 's1'), tenant('a', 's1')]).entries);
    expect(a).toBe(b);
    expect(versionOf(buildRoutingMap(s, [tenant('a', 's1')]).entries)).not.toBe(a); // different content, different version
  });
});

describe('RoutingPublisher.publish', () => {
  function setup() {
    const stamps = new MemoryCollection<StampDoc>();
    const tenants = new MemoryCollection<TenantDoc>();
    const routing = new MemoryCollection<RoutingMapDoc>();
    return { stamps, tenants, routing, pub: new RoutingPublisher(stamps, tenants, routing, () => new Date(ts)) };
  }

  it('writes once, then a second publish of an unchanged registry is a no-op', async () => {
    const { stamps, tenants, routing, pub } = setup();
    await stamps.create(stamp('s1', 'healthy'));
    await tenants.create(tenant('t1', 's1'));
    expect((await pub.publish()).published).toBe(true);
    const etagAfterFirst = routing.docs.get('current')?._etag;
    expect((await pub.publish()).published).toBe(false);
    expect(routing.docs.get('current')?._etag).toBe(etagAfterFirst); // a second write would bump the etag
  });

  it('republishes when a stamp is paused', async () => {
    const { stamps, tenants, pub } = setup();
    const s = await stamps.create(stamp('s1', 'healthy'));
    await tenants.create(tenant('t1', 's1'));
    const v1 = (await pub.publish()).version;
    await stamps.replace({ ...s, status: 'paused' });
    const r = await pub.publish();
    expect(r.published).toBe(true);
    expect(r.version).not.toBe(v1);
  });

  it('refuses to replace a non-empty published map with an empty one (last-known-good)', async () => {
    const { stamps, tenants, routing, pub } = setup();
    await stamps.create(stamp('s1', 'healthy'));
    const t = await tenants.create(tenant('t1', 's1'));
    await pub.publish();
    await tenants.replace({ ...t, status: 'destroying' }); // map would become empty
    await expect(pub.publish()).rejects.toMatchObject({ status: 409 });
    expect(routing.docs.get('current')?.entries).toHaveLength(1); // still the old map
  });
});
