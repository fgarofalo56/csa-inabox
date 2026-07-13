/**
 * Vitest specs for the Landing-Zone Service Registry store
 * (attached-services-store) with Cosmos mocked by an in-memory fake:
 *   - create → view shape (no secretRef leak), idempotent re-attach,
 *   - list (tenant + per-LZ scoping),
 *   - resolveAttachedService (LZ match → hub fallback),
 *   - detach referential-integrity guard (AttachedServiceInUseError),
 *   - day-0 BYO seed reconcile from EXISTING_* env.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- In-memory Cosmos fake -------------------------------------------------
let attached: any[] = [];
let items: any[] = []; // workspace items (for the dependents guard)
let attachedQueryCount = 0; // counts fetchAll() calls against the registry container

function matchQuery(store: any[], spec: any): any[] {
  const p: Record<string, any> = {};
  for (const { name, value } of spec.parameters || []) p[name] = value;
  const q = spec.query as string;
  return store.filter((doc) => {
    if (q.includes('c.tenantId = @t') && doc.tenantId !== p['@t']) return false;
    if (q.includes('c.landingZoneId = @lz') && doc.landingZoneId !== p['@lz']) return false;
    if (q.includes('c.kind = @k') && doc.kind !== p['@k']) return false;
    if (q.includes('c.armResourceId = @arm') && doc.armResourceId !== p['@arm']) return false;
    if (q.includes('c.state.attachedServiceId = @id') && doc?.state?.attachedServiceId !== p['@id']) return false;
    return true;
  });
}

function fakeContainer(store: any[]) {
  return {
    items: {
      create: async (doc: any) => { store.push({ ...doc }); return { resource: { ...doc } }; },
      upsert: async (doc: any) => {
        const i = store.findIndex((d) => d.id === doc.id && d.tenantId === doc.tenantId);
        if (i >= 0) store[i] = { ...doc }; else store.push({ ...doc });
        return { resource: { ...doc } };
      },
      query: (spec: any) => ({ fetchAll: async () => { if (store === attached) attachedQueryCount++; return { resources: matchQuery(store, spec) }; } }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: store.find((d) => d.id === id && d.tenantId === pk) }),
      delete: async () => { const i = store.findIndex((d) => d.id === id && d.tenantId === pk); if (i >= 0) store.splice(i, 1); },
    }),
  };
}

vi.mock('../cosmos-client', () => ({
  attachedServicesContainer: async () => fakeContainer(attached),
  itemsContainer: async () => fakeContainer(items),
}));

const SESSION: any = { claims: { oid: 'user-oid', tid: 'tenant-1', upn: 'admin@contoso.com' } };

describe('attached-services-store', () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(async () => {
    attached = []; items = []; attachedQueryCount = 0;
    // The resolution cache is module-level; clear it so cases don't bleed.
    const { clearAttachedServiceCache } = await import('../attached-services-store');
    clearAttachedServiceCache();
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; vi.restoreAllMocks(); });

  it('creates a service and returns a no-secret view partitioned by tenant', async () => {
    const { createAttachedService } = await import('../attached-services-store');
    const view = await createAttachedService(SESSION, {
      landingZoneId: 'hub', kind: 'synapse', displayName: 'ws1',
      armResourceId: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/ws1',
      subscriptionId: 's', resourceGroup: 'r',
    });
    expect(view.kind).toBe('synapse');
    expect(view.tenantId).toBe('tenant-1'); // tenantScopeId = tid
    expect(view.status).toBe('attached');
    expect(view.chargebackIncluded).toBe(true);
    expect((view as any).secretRef).toBeUndefined();
    expect(view.hasSecret).toBe(false);
    expect(attached).toHaveLength(1);
  });

  it('rejects an unknown kind', async () => {
    const { createAttachedService } = await import('../attached-services-store');
    await expect(createAttachedService(SESSION, {
      landingZoneId: 'hub', kind: 'made-up' as any, displayName: 'x',
      armResourceId: '/subscriptions/s/resourceGroups/r/providers/Foo/bar/x', subscriptionId: 's', resourceGroup: 'r',
    })).rejects.toMatchObject({ status: 400 });
  });

  it('is idempotent — re-attaching the same resource updates in place', async () => {
    const { createAttachedService } = await import('../attached-services-store');
    const arm = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c1';
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'adx', displayName: 'c1', armResourceId: arm, subscriptionId: 's', resourceGroup: 'r' });
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'adx', displayName: 'c1-renamed', armResourceId: arm, subscriptionId: 's', resourceGroup: 'r' });
    expect(attached).toHaveLength(1);
    expect(attached[0].displayName).toBe('c1-renamed');
  });

  it('lists tenant-wide and scoped to a landing zone', async () => {
    const { createAttachedService, listAttachedServices } = await import('../attached-services-store');
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    await createAttachedService(SESSION, { landingZoneId: 'sub/rg-dlz', kind: 'adx', displayName: 'c', armResourceId: '/s/c', subscriptionId: 's', resourceGroup: 'rg-dlz' });
    expect(await listAttachedServices(SESSION)).toHaveLength(2);
    expect(await listAttachedServices(SESSION, 'hub')).toHaveLength(1);
    expect((await listAttachedServices(SESSION, 'hub'))[0].kind).toBe('synapse');
  });

  it('resolveAttachedService prefers the LZ match, else falls back to hub', async () => {
    const { createAttachedService, resolveAttachedService } = await import('../attached-services-store');
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'hub-ws', armResourceId: '/s/hub-ws', subscriptionId: 's', resourceGroup: 'r' });
    await createAttachedService(SESSION, { landingZoneId: 'sub/rg', kind: 'synapse', displayName: 'lz-ws', armResourceId: '/s/lz-ws', subscriptionId: 's', resourceGroup: 'rg' });
    const inLz = await resolveAttachedService('tenant-1', 'synapse', 'sub/rg');
    expect(inLz?.displayName).toBe('lz-ws');
    const fallback = await resolveAttachedService('tenant-1', 'synapse', 'sub/other');
    expect(fallback?.displayName).toBe('hub-ws'); // hub-scoped fallback
    expect(await resolveAttachedService('tenant-1', 'adx')).toBeNull();
  });

  it('caches the resolution — a second call does not re-query Cosmos', async () => {
    const { createAttachedService, resolveAttachedService } = await import('../attached-services-store');
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    attachedQueryCount = 0; // reset after the create's own reads
    const a = await resolveAttachedService('tenant-1', 'synapse', 'hub');
    expect(attachedQueryCount).toBe(1);
    const b = await resolveAttachedService('tenant-1', 'synapse', 'hub');
    expect(attachedQueryCount).toBe(1); // served from cache — no second query
    expect(a?.displayName).toBe('ws');
    expect(b?.displayName).toBe('ws');
  });

  it('caches NULL results — an empty registry does not re-query per call', async () => {
    const { resolveAttachedService } = await import('../attached-services-store');
    attachedQueryCount = 0;
    expect(await resolveAttachedService('tenant-1', 'adx')).toBeNull();
    expect(await resolveAttachedService('tenant-1', 'adx')).toBeNull();
    expect(attachedQueryCount).toBe(1); // the null was cached
  });

  it('invalidates the tenant cache on attach so a new service resolves immediately', async () => {
    const { createAttachedService, resolveAttachedService } = await import('../attached-services-store');
    // Prime a null into the cache.
    expect(await resolveAttachedService('tenant-1', 'synapse', 'hub')).toBeNull();
    // Attaching must invalidate that cached null.
    await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    const resolved = await resolveAttachedService('tenant-1', 'synapse', 'hub');
    expect(resolved?.displayName).toBe('ws'); // fresh, not the stale null
  });

  it('invalidates the tenant cache on detach so the service stops resolving', async () => {
    const { createAttachedService, detachService, resolveAttachedService } = await import('../attached-services-store');
    const v = await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    expect((await resolveAttachedService('tenant-1', 'synapse', 'hub'))?.displayName).toBe('ws'); // cache it
    await detachService(SESSION, v.id);
    expect(await resolveAttachedService('tenant-1', 'synapse', 'hub')).toBeNull(); // cache invalidated
  });

  it('detach removes the binding when no item depends on it', async () => {
    const { createAttachedService, detachService } = await import('../attached-services-store');
    const v = await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    await detachService(SESSION, v.id);
    expect(attached).toHaveLength(0);
  });

  it('detach refuses (409) when an item still binds the service', async () => {
    const { createAttachedService, detachService, AttachedServiceInUseError } = await import('../attached-services-store');
    const v = await createAttachedService(SESSION, { landingZoneId: 'hub', kind: 'synapse', displayName: 'ws', armResourceId: '/s/ws', subscriptionId: 's', resourceGroup: 'r' });
    items.push({ id: 'item-1', itemType: 'notebook', displayName: 'My NB', state: { attachedServiceId: v.id } });
    await expect(detachService(SESSION, v.id)).rejects.toBeInstanceOf(AttachedServiceInUseError);
    await detachService(SESSION, v.id).catch((e) => expect(e.status).toBe(409));
    expect(attached).toHaveLength(1); // not removed
  });

  it('day-0 seed reconcile upserts EXISTING_* reused services as day0-byo', async () => {
    process.env.EXISTING_SYNAPSE = 'ws-byo';
    process.env.EXISTING_SYNAPSE_SUB = 'sub-byo';
    process.env.EXISTING_SYNAPSE_RG = 'rg-byo';
    const { reconcileDay0Byo, listAttachedServices } = await import('../attached-services-store');
    const r = await reconcileDay0Byo(SESSION);
    expect(r.seeded).toBeGreaterThanOrEqual(1);
    expect(r.kinds).toContain('synapse');
    const list = await listAttachedServices(SESSION, 'hub');
    const syn = list.find((s) => s.kind === 'synapse');
    expect(syn?.origin).toBe('day0-byo');
    expect(syn?.armResourceId).toContain('sub-byo');
    // Idempotent: a second run skips the already-seeded service.
    const r2 = await reconcileDay0Byo(SESSION);
    expect(r2.seeded).toBe(0);
    expect(r2.skippedExisting).toBeGreaterThanOrEqual(1);
  });
});
