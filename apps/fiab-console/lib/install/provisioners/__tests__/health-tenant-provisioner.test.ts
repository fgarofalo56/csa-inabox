/**
 * health-tenant provisioner (LHDS W1-7).
 *
 * Every assertion names the value that would break it. The control plane is a
 * hand-written fake whose call counts are asserted, so "idempotent" means a
 * measured number of createTenant / submitJob calls, not an absence of errors.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));

import {
  ensureHealthTenant,
  healthTenantCollisionSlug,
  healthTenantSlugFor,
  pickStamp,
  resourcesFromReceipts,
  toProvisionResult,
  VERIFY_TTL_MS,
  type EnsureDeps,
  type HealthBinding,
} from '../health-tenant';
import { CpError, CpNotConfiguredError, type CpJob, type CpStamp, type CpTenant } from '@/app/api/health/tenants/_lib/cp-client';

// The registry's slug rule, lifted from the control plane's source at runtime so a typo here
// cannot make the probe disagree with the implementation (assertion-design.md rule 3).
const CP_TYPES = readFileSync(resolve(__dirname, '../../../../../loom-health-cp/src/registry/types.ts'), 'utf8');
const SLUG_SRC = /export const SLUG = (\/.+\/);/.exec(CP_TYPES)?.[1];
const CP_SLUG = SLUG_SRC ? new RegExp(SLUG_SRC.slice(1, -1)) : undefined;

const NOW = new Date('2026-10-26T12:00:00.000Z');
const STAMP: CpStamp = { id: 'east-s1', displayName: 'East', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy' };

function tenant(over: Partial<CpTenant> = {}): CpTenant {
  return { id: 'mercy-general', displayName: 'Mercy General', stampId: 'east-s1', status: 'active', quotas: { maxRequestsPerMinute: 6000, maxStorageGiB: 1024 }, createdAt: '2026-10-26T10:00:00.000Z', ...over };
}
function job(state: CpJob['state'], over: Partial<CpJob> = {}): CpJob {
  return { id: 'job-aaaa', kind: 'tenant.create', subjectId: 'mercy-general', state, receipts: [], updatedAt: NOW.toISOString(), ...over };
}
const RB = (kind: string, id: string) => ({ at: NOW.toISOString(), step: 'readback', detail: `${kind} exists=true id=${id}` });

interface Fake {
  deps: EnsureDeps;
  calls: { createTenant: any[]; submitJob: any[]; retryJob: string[]; persist: HealthBinding[] };
}
function fake(opts: {
  tenants?: Record<string, CpTenant>;
  stamps?: CpStamp[];
  job?: CpJob;
  getTenantThrows?: Error;
  configured?: boolean;
  defaultStampId?: string;
}): Fake {
  const tenants = { ...(opts.tenants ?? {}) };
  const calls: Fake['calls'] = { createTenant: [], submitJob: [], retryJob: [], persist: [] };
  const deps: EnsureDeps = {
    readConfig: () => {
      if (opts.configured === false) throw new CpNotConfiguredError(['LOOM_HEALTH_CP_URL']);
      return { baseUrl: 'https://cp', audience: 'api://cp' };
    },
    now: () => NOW,
    defaultStampId: opts.defaultStampId,
    persist: async (b) => { calls.persist.push(b); return true; },
    cp: {
      listStamps: async () => opts.stamps ?? [STAMP],
      listTenants: async () => Object.values(tenants),
      getTenant: async (id: string) => {
        if (opts.getTenantThrows) throw opts.getTenantThrows;
        return tenants[id] ?? null;
      },
      createTenant: async (b: any) => {
        calls.createTenant.push(b);
        const t = tenant({ id: b.id, displayName: b.displayName, stampId: b.stampId, status: 'creating' });
        tenants[b.id] = t;
        return t;
      },
      submitJob: async (b: any) => { calls.submitJob.push(b); return opts.job ?? job('queued'); },
      retryJob: async (id: string) => { calls.retryJob.push(id); return job('queued', { id }); },
      getJob: async () => opts.job ?? job('queued'),
    } as unknown as EnsureDeps['cp'],
  };
  return { deps, calls };
}

const input = (state?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ itemId: '1234abcd-0000-0000-0000-000000000000', displayName: 'Mercy General', state, ...extra });

const BOUND: HealthBinding = {
  tenantId: 'mercy-general', sourceName: 'Mercy General', tenantIdSanitized: true, stampId: 'east-s1',
  createJobId: 'job-aaaa', status: 'bound', boundAt: '2026-10-25T00:00:00.000Z', verifiedAt: NOW.toISOString(),
  resources: [{ kind: 'database', id: '/x/databases/lhds_mercy_general', name: 'lhds_mercy_general' }],
};

describe('healthTenantSlugFor', () => {
  it('lifts the registry slug rule from the control-plane source (control: the lift itself worked)', () => {
    expect(SLUG_SRC, 'SLUG literal not found in loom-health-cp types.ts - the file moved').toBeTruthy();
    expect(CP_SLUG!.test('mercy-general')).toBe(true);
    expect(CP_SLUG!.test('Mercy General')).toBe(false);
  });

  it.each([
    ['Mercy General Hospital!', 'mercy-general-hospital', true],
    ['mercy', 'mercy', false],
    ['  --Mercy   &  Co--  ', 'mercy-co', true],
    ['A', 'a-tenant', true],
    ['!!!', 'health-tenant', true],
  ])('%j -> %j, accepted by the control plane, sanitized=%s', (name, want, sanitized) => {
    const r = healthTenantSlugFor(name);
    expect(r.slug).toBe(want);
    expect(r.sanitized).toBe(sanitized);
    expect(CP_SLUG!.test(r.slug), `control plane would reject ${r.slug}`).toBe(true);
  });

  it('never ends in a hyphen after truncation (a 29-char name followed by a space cuts at the hyphen)', () => {
    // 29 a's + ' ' + 'bbb' -> after hyphenation the 30-char cut ends exactly on '-'. Without the
    // post-slice trim the slug is 'a...a-' and the control plane rejects it.
    const r = healthTenantSlugFor(`${'a'.repeat(29)} bbb`);
    expect(r.slug).toBe('a'.repeat(29));
    expect(CP_SLUG!.test(r.slug)).toBe(true);
  });

  it('collision slug is stable per item, differs from the base, and is registry-valid', () => {
    const a = healthTenantCollisionSlug('mercy-general', '1234abcd-0000');
    expect(a).toBe('mercy-general-1234ab');
    expect(healthTenantCollisionSlug('mercy-general', '1234abcd-0000')).toBe(a);
    expect(healthTenantCollisionSlug('mercy-general', '9999ffff-0000')).not.toBe(a);
    expect(CP_SLUG!.test(healthTenantCollisionSlug('x'.repeat(30), 'abcdef123'))).toBe(true);
    expect(healthTenantCollisionSlug('x'.repeat(30), 'abcdef123').length).toBeLessThanOrEqual(30);
  });
});

describe('pickStamp', () => {
  it('refuses a preferred stamp that is not healthy and names its status (paused, not "missing")', () => {
    const r = pickStamp([{ ...STAMP, status: 'paused', pauseReason: 'cost pause' }], 'east-s1');
    expect('reason' in r && r.reason).toMatch(/paused.*cost pause/);
  });
  it('refuses a preferred stamp that is not registered', () => {
    const r = pickStamp([STAMP], 'west-s9');
    expect('reason' in r && r.reason).toMatch(/west-s9.*not registered/);
  });
  it('picks the lexically first HEALTHY stamp when none is preferred, skipping an earlier unhealthy one', () => {
    const r = pickStamp([{ ...STAMP, id: 'a-stamp', status: 'draining' }, { ...STAMP, id: 'c-stamp' }, { ...STAMP, id: 'b-stamp' }], undefined);
    expect('stamp' in r && r.stamp.id).toBe('b-stamp');
  });
});

describe('resourcesFromReceipts', () => {
  it('keeps only readback receipts that report exists=true and takes the Azure name from the id', () => {
    const rs = resourcesFromReceipts({ receipts: [
      RB('database', '/subs/s/pg/databases/lhds_mercy_general'),
      { at: 'x', step: 'readback', detail: 'identity exists=false id=/subs/s/uami/id-gone' },
      { at: 'x', step: 'tenant.deployed', detail: 'deployment=lhds-tenant-mercy-general rg=rg' },
      { at: 'x', step: 'key.state', detail: 'key=t-mercy-general-a exists=true enabled=true' },
    ] });
    expect(rs).toEqual([{ kind: 'database', id: '/subs/s/pg/databases/lhds_mercy_general', name: 'lhds_mercy_general' }]);
  });
});

describe('ensureHealthTenant', () => {
  it('reports the control-plane gate (not an error) when LOOM_HEALTH_CP_URL is unset, and calls nothing', async () => {
    const f = fake({ configured: false });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'unconfigured', gateId: 'health-control-plane', missing: ['LOOM_HEALTH_CP_URL'] });
    expect(f.calls.createTenant).toHaveLength(0);
    expect(f.calls.submitJob).toHaveLength(0);
  });

  it('with no healthy stamp returns the stamp-capacity gate and creates NO tenant', async () => {
    const f = fake({ stamps: [{ ...STAMP, status: 'creating' }] });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'no-stamp', gateId: 'health-stamp-capacity' });
    expect(f.calls.createTenant).toHaveLength(0);
  });

  it('an UNREACHABLE control plane is a cp-error carrying its code, never "absent" (R7): no tenant is created', async () => {
    const f = fake({ getTenantThrows: new CpError(0, 'unreachable', 'connect ETIMEDOUT') });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'cp-error', code: 'unreachable' });
    expect(f.calls.createTenant, 'treating a failed read as "tenant absent" would create a duplicate').toHaveLength(0);
  });

  it('creates the tenant with the item display name VERBATIM and a derived id, then reports provisioning', async () => {
    const f = fake({ job: job('running', { receipts: [{ at: 'x', step: 'tenant.deployed', detail: 'd' }] }) });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(f.calls.createTenant).toEqual([{
      id: 'mercy-general', displayName: 'Mercy General', stampId: 'east-s1',
      quotas: { maxRequestsPerMinute: 6000, maxStorageGiB: 1024 },
    }]);
    expect(f.calls.submitJob[0]).toMatchObject({ kind: 'tenant.create', subjectType: 'tenant', subjectId: 'mercy-general' });
    expect(f.calls.submitJob[0].idempotencyKey).toMatch(/^create-/);
    expect(o.phase).toBe('provisioning');
    expect(f.calls.persist.at(-1)).toMatchObject({ tenantId: 'mercy-general', sourceName: 'Mercy General', tenantIdSanitized: true, status: 'provisioning' });
  });

  it('is idempotent: a second open while provisioning creates NO second tenant', async () => {
    const f = fake({ job: job('running') });
    await ensureHealthTenant(input(), f.deps);
    const second = await ensureHealthTenant(input({ healthTenant: f.calls.persist.at(-1) }), f.deps);
    expect(f.calls.createTenant).toHaveLength(1);
    expect(second.phase).toBe('provisioning');
    // Same incarnation, same key, so the control plane answers with the SAME job.
    expect(f.calls.submitJob[1].idempotencyKey).toBe(f.calls.submitJob[0].idempotencyKey);
  });

  it('binds only when the job succeeded AND the tenant is active AND resources read back; names come from Azure ids', async () => {
    const f = fake({
      tenants: { 'mercy-general': tenant() },
      job: job('succeeded', { finishedAt: NOW.toISOString(), receipts: [RB('database', '/s/pg/databases/lhds_mercy_general'), RB('eventhub', '/s/ns/eventhubs/eh-t-mercy-general')] }),
    });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o.phase).toBe('bound');
    if (o.phase !== 'bound') return;
    expect(o.binding.resources.map((r) => r.name)).toEqual(['lhds_mercy_general', 'eh-t-mercy-general']);
    expect(o.binding.verifiedAt).toBe(NOW.toISOString());
    expect(toProvisionResult(o).status).toBe('created');
  });

  it('adopts an existing tenant with the SAME display name when the state write was lost (no duplicate create)', async () => {
    const f = fake({ tenants: { 'mercy-general': tenant() }, job: job('running') });
    const o = await ensureHealthTenant(input(undefined), f.deps);
    expect(f.calls.createTenant).toHaveLength(0);
    expect(o.steps.join(' ')).toMatch(/Adopted existing tenant/);
  });

  it('takes the item-suffixed id when the plain slug belongs to a DIFFERENT tenant', async () => {
    const f = fake({ tenants: { 'mercy-general': tenant({ displayName: 'Mercy-General (other)' }) }, job: job('running') });
    await ensureHealthTenant(input(), f.deps);
    expect(f.calls.createTenant[0].id).toBe('mercy-general-1234ab');
    expect(f.calls.createTenant[0].displayName).toBe('Mercy General');
  });

  it('SELF-HEALS a tenant deleted from the control plane: re-registers it instead of erroring', async () => {
    const f = fake({ tenants: {}, job: job('running') });
    const o = await ensureHealthTenant(input({ healthTenant: BOUND }), f.deps);
    expect(f.calls.createTenant).toHaveLength(1);
    expect(o.steps.join(' ')).toMatch(/removed from the control plane/);
  });

  it('a bound tenant verified an hour ago is NOT re-verified (no job); one verified past the TTL is', async () => {
    const recent = fake({ tenants: { 'mercy-general': tenant() } });
    const r = await ensureHealthTenant(input({ healthTenant: BOUND }), recent.deps);
    expect(r.phase).toBe('bound');
    expect(recent.calls.submitJob).toHaveLength(0);

    const old = { ...BOUND, verifiedAt: new Date(NOW.getTime() - VERIFY_TTL_MS - 60_000).toISOString() };
    const stale = fake({ tenants: { 'mercy-general': tenant() }, job: job('running') });
    await ensureHealthTenant(input({ healthTenant: old }), stale.deps);
    expect(stale.calls.submitJob).toHaveLength(1);
    expect(stale.calls.submitJob[0].idempotencyKey).toBe('verify-20261026');
  });

  it('a succeeded job on a tenant that is still "creating" is a failure, not a bind (stale job from a prior incarnation)', async () => {
    const f = fake({ tenants: { 'mercy-general': tenant({ status: 'creating' }) }, job: job('succeeded', { receipts: [RB('database', '/s/pg/databases/lhds_mercy_general')] }) });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'failed', code: 'readback_missing' });
  });

  it('a succeeded job with ZERO readback receipts is a failure (binding on nothing read back would be a lie)', async () => {
    const f = fake({ tenants: { 'mercy-general': tenant() }, job: job('succeeded', { receipts: [{ at: 'x', step: 'tenant.deployed', detail: 'd' }] }) });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'failed', code: 'readback_missing' });
  });

  it('a failed job surfaces the job error code and message; retry:true retries THAT job', async () => {
    const failedJob = job('failed', { error: { code: 'stamp_not_ready', message: 'the stamp is paused' } });
    const f = fake({ tenants: { 'mercy-general': tenant({ status: 'creating' }) }, job: failedJob });
    const o = await ensureHealthTenant(input(), f.deps);
    expect(o).toMatchObject({ phase: 'failed', code: 'stamp_not_ready', message: 'the stamp is paused' });
    expect(f.calls.retryJob).toHaveLength(0);

    const f2 = fake({ tenants: { 'mercy-general': tenant({ status: 'creating' }) }, job: failedJob });
    await ensureHealthTenant(input(undefined, { retry: true }), f2.deps);
    expect(f2.calls.retryJob).toEqual(['job-aaaa']);
  });
});

describe('toProvisionResult', () => {
  it('maps gates to remediation envelopes that name a REAL gate id', () => {
    const r = toProvisionResult({ phase: 'unconfigured', gateId: 'health-control-plane', missing: ['LOOM_HEALTH_CP_URL'], message: 'm', steps: [] });
    expect(r.status).toBe('remediation');
    expect(r.gate?.gateId).toBe('health-control-plane');
    expect(r.gate?.remediation).toContain('LOOM_HEALTH_CP_URL');
  });
  it('maps a control-plane error to failed, never to remediation (it is not a missing prerequisite)', () => {
    expect(toProvisionResult({ phase: 'cp-error', code: 'unreachable', message: 'x', steps: [] }).status).toBe('failed');
  });
});
