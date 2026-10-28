/**
 * `health-tenant` create-time auto-bind arm (#5161, auto-bind-by-default.md section 1).
 *
 * The control plane is a hand-written fake whose CALL COUNTS are asserted, so
 * "provisions on create" is a measured number of createTenant / submitJob calls.
 * Each test states the input that would break it (assertion-design.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/app/api/health/tenants/_lib/tenant-admin-gate', () => ({ enforceHealthTenantAdmin: vi.fn() }));

import { autoBindOnCreate, healthTenantAutoBindOnCreate } from '../auto-bind';
import { ensureHealthTenant, type EnsureDeps, type HealthBinding } from '@/lib/install/provisioners/health-tenant';
import { enforceHealthTenantAdmin } from '@/app/api/health/tenants/_lib/tenant-admin-gate';
import type { CpJob, CpStamp, CpTenant } from '@/app/api/health/tenants/_lib/cp-client';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const STAMP: CpStamp = { id: 'east-s1', displayName: 'East', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy' };
const SESSION: any = { claims: { oid: 'user-1' } };

const item = (over: Record<string, unknown> = {}): any => ({
  id: 'item-abc123', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General',
  state: {}, createdBy: 'u@x', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
});

interface Calls { createTenant: any[]; submitJob: any[]; persist: HealthBinding[] }
function fake(opts: { persistOk?: boolean; getTenant?: () => Promise<CpTenant | null> } = {}) {
  const tenants: Record<string, CpTenant> = {};
  const calls: Calls = { createTenant: [], submitJob: [], persist: [] };
  const deps: EnsureDeps = {
    readConfig: () => ({ baseUrl: 'https://cp', audience: 'api://cp' }),
    now: () => NOW,
    defaultStampId: undefined,
    persist: async (b) => { calls.persist.push(b); return opts.persistOk !== false; },
    cp: {
      listStamps: async () => [STAMP],
      getTenant: opts.getTenant ?? (async (id: string) => tenants[id] ?? null),
      createTenant: async (b: any) => {
        calls.createTenant.push(b);
        const t: CpTenant = { id: b.id, displayName: b.displayName, stampId: b.stampId, status: 'creating', createdAt: '2026-10-27T11:00:00.000Z', quotas: b.quotas };
        tenants[b.id] = t;
        return t;
      },
      submitJob: async (b: any) => {
        calls.submitJob.push(b);
        return { id: 'job-1', kind: 'tenant.create', subjectId: b.subjectId, state: 'queued', receipts: [], updatedAt: NOW.toISOString() } as CpJob;
      },
    } as unknown as EnsureDeps['cp'],
  };
  return { deps, calls, tenants };
}

beforeEach(() => {
  vi.mocked(enforceHealthTenantAdmin).mockReset();
  vi.mocked(enforceHealthTenantAdmin).mockResolvedValue(null); // null = allowed
});

describe('health-tenant create-time arm', () => {
  it('provisions the tenant on create: ONE createTenant, ONE job, name verbatim, binding recorded', async () => {
    const f = fake();
    const r = await autoBindOnCreate(item(), { session: SESSION, healthDeps: f.deps });
    expect(r).toBeNull();
    // Breaks if the arm is absent (0 calls) or runs twice (2 calls).
    expect(f.calls.createTenant).toHaveLength(1);
    expect(f.calls.submitJob).toHaveLength(1);
    // Breaks if the display name is altered (e.g. slug used as the name): names must match.
    expect(f.calls.createTenant[0].displayName).toBe('Mercy General');
    expect(f.calls.createTenant[0].id).toBe('mercy-general');
    // Breaks if the binding is not recorded on the item (first open could not adopt it by record).
    expect(f.calls.persist.at(-1)).toMatchObject({ tenantId: 'mercy-general', sourceName: 'Mercy General', stampId: 'east-s1', status: 'provisioning', tenantIdSanitized: true });
  });

  it('checks the Contributor capability with the creating session (D12)', async () => {
    const f = fake();
    await healthTenantAutoBindOnCreate(item(), SESSION, f.deps);
    // Breaks if the gate is skipped (0 calls) or checked at a different role.
    expect(enforceHealthTenantAdmin).toHaveBeenCalledWith(SESSION, 'Contributor');
  });

  it('a caller WITHOUT the capability provisions nothing (paired with the positive case above)', async () => {
    vi.mocked(enforceHealthTenantAdmin).mockResolvedValue({ status: 403 } as any);
    const f = fake();
    const r = await healthTenantAutoBindOnCreate(item(), SESSION, f.deps);
    expect(r).toBeNull();
    // Breaks if the gate result is ignored: any denied caller would produce 1 createTenant.
    expect(f.calls.createTenant).toHaveLength(0);
    expect(f.calls.submitJob).toHaveLength(0);
    expect(f.calls.persist).toHaveLength(0);
  });

  it('no session (a create path that cannot identify the caller) provisions nothing', async () => {
    const f = fake();
    await autoBindOnCreate(item(), { healthDeps: f.deps });
    // Breaks if the arm falls back to an ambient identity: createTenant would be 1.
    expect(f.calls.createTenant).toHaveLength(0);
    expect(enforceHealthTenantAdmin).not.toHaveBeenCalled();
  });

  it('is scoped to health-tenant: another item type never reaches the control plane', async () => {
    const f = fake();
    const r = await healthTenantAutoBindOnCreate(item({ itemType: 'notebook' }), SESSION, f.deps);
    expect(r).toBeNull();
    // Breaks if the itemType guard is removed: a notebook would create a tenant.
    expect(f.calls.createTenant).toHaveLength(0);
  });

  it('ignores a tenant id smuggled in via the create body state', async () => {
    const f = fake();
    const smuggled = { healthTenant: { tenantId: 'someone-elses-tenant', stampId: 'east-s1', status: 'bound', resources: [] } };
    await autoBindOnCreate(item({ state: smuggled }), { session: SESSION, healthDeps: f.deps });
    // Breaks if the prior binding in the body is trusted: createTenant would use / skip 'someone-elses-tenant'.
    expect(f.calls.createTenant.map((c) => c.id)).toEqual(['mercy-general']);
  });

  it('never fails item creation: a throwing control plane resolves null', async () => {
    const f = fake({ getTenant: async () => { throw new Error('boom'); } });
    await expect(autoBindOnCreate(item(), { session: SESSION, healthDeps: f.deps })).resolves.toBeNull();
    // Breaks if a failure is swallowed AS success: nothing may be created on a failed read.
    expect(f.calls.createTenant).toHaveLength(0);
  });

  it('is deadline-bounded: a hung control plane releases the create within timeoutMs', async () => {
    const f = fake({ getTenant: () => new Promise<CpTenant | null>(() => {}) });
    const t0 = Date.now();
    await expect(autoBindOnCreate(item(), { session: SESSION, healthDeps: f.deps, timeoutMs: 30 })).resolves.toBeNull();
    // Breaks if the arm is awaited without the race: the promise would never settle (test times out).
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('first-open still self-heals: a lost create-time state write is re-derived, not duplicated', async () => {
    const f = fake({ persistOk: false });
    await autoBindOnCreate(item(), { session: SESSION, healthDeps: f.deps });
    expect(f.calls.createTenant).toHaveLength(1);
    // The editor's first open sees NO recorded binding (the write did not land).
    const open = await ensureHealthTenant({ itemId: 'item-abc123', displayName: 'Mercy General', state: {} }, f.deps);
    // Breaks if create-time provisioning is not adoptable: a 2nd createTenant would appear (duplicate tenant).
    expect(f.calls.createTenant).toHaveLength(1);
    expect(open.phase).toBe('provisioning');
    if (open.phase === 'provisioning') expect(open.binding.tenantId).toBe('mercy-general');
  });
});
