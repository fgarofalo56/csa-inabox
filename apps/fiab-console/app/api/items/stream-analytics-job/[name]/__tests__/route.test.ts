/**
 * #3573 — GET /api/items/stream-analytics-job/[name] used to attach ONE hint to
 * both its failure branches:
 *
 *   'Provision an ASA job (bicep: …stream-analytics.bicep) and set LOOM_ASA_RG…'
 *
 * so a plain "that streaming job does not exist" ARM 404 came back as a 502
 * carrying a claim the code had never established — that Stream Analytics was
 * not configured. The editor keyed its MessageBar title on `hint` being
 * truthy, so it rendered "Stream Analytics not configured" over deployments
 * where LOOM_ASA_RG was set correctly and ARM had answered.
 *
 * These tests pin the three branches apart, and pin the Fix-it that
 * `auto-bind-by-default.md` requires in place of a dead end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level binding, so the error
// classes the route does `instanceof` against are declared inside `vi.hoisted`.
const H = vi.hoisted(() => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) { super(`Stream Analytics is not configured. Missing env: ${m.join(', ')}`); this.missing = m; }
  }
  class AsaJobNotFoundError extends Error {
    jobName: string; resourceGroup: string; subscriptionId: string;
    constructor(jobName: string, resourceGroup: string, subscriptionId: string) {
      super(`Stream Analytics job '${jobName}' does not exist in resource group '${resourceGroup}' (subscription ${subscriptionId}).`);
      this.jobName = jobName; this.resourceGroup = resourceGroup; this.subscriptionId = subscriptionId;
    }
  }
  return { AsaNotConfiguredError, AsaJobNotFoundError };
});
const { AsaNotConfiguredError, AsaJobNotFoundError } = H;

const getJob = vi.hoisted(() => vi.fn(async (_n: string) => ({ name: 'j', id: '/x', location: 'eastus' })));
vi.mock('@/lib/azure/stream-analytics-client', () => ({
  AsaNotConfiguredError: H.AsaNotConfiguredError,
  AsaJobNotFoundError: H.AsaJobNotFoundError,
  getJob: (n: string) => getJob(n),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const loadOwnedItem = vi.hoisted(() => vi.fn(async (_id: string, _t: string, _tenant: string, _o?: any) => null as any));
vi.mock('../../../_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => (loadOwnedItem as any)(...a) }));

const streamAnalyticsJobProvisioner = vi.hoisted(() => vi.fn(async (_i: any) => ({
  status: 'created' as const,
  resourceId: '/subscriptions/s/…/streamingjobs/Rides-Telemetry',
  secondaryIds: { jobName: 'Rides-Telemetry' },
  steps: [],
})));
vi.mock('@/lib/install/provisioners/stream-analytics-job', () => ({
  streamAnalyticsJobProvisioner: (i: any) => streamAnalyticsJobProvisioner(i),
  asaJobNameFor: (d: string) => ({ name: d.replace(/[^A-Za-z0-9_-]+/g, '-'), sanitized: true }),
}));
vi.mock('@/lib/install/provisioning-engine', () => ({ resolveTarget: () => ({ mode: 'shared' }) }));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { oid: 'oid-1' } } as any;
const ITEM = { id: 'item-1', workspaceId: 'ws-1', itemType: 'stream-analytics-job', displayName: 'Rides Telemetry', state: {} } as any;

const req = (url = 'https://loom.test/api/items/stream-analytics-job/item-1') =>
  ({ nextUrl: new URL(url) } as any);

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  loadOwnedItem.mockResolvedValue(null);
});

describe('GET — the three failure branches are told apart (#3573)', () => {
  it('501 NOT-CONFIGURED still carries the env-var hint', async () => {
    getJob.mockRejectedValue(new AsaNotConfiguredError(['LOOM_ASA_RG (or LOOM_DLZ_RG)']));
    const r = await GET(req(), { params: Promise.resolve({ name: 'anything' }) });
    const j = await r.json();
    expect(r.status).toBe(501);
    expect(j.hint).toContain('LOOM_ASA_RG');
  });

  it('404 MISSING-JOB does NOT carry the "not configured" hint', async () => {
    // At head this reached the generic catch: 502, plus a hint asserting ASA
    // was not configured. Both were wrong.
    getJob.mockRejectedValue(new AsaJobNotFoundError('item-1', 'rgAsa', 'sub1'));
    const r = await GET(req(), { params: Promise.resolve({ name: 'item-1' }) });
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });

  it('502 UNCLASSIFIED asserts no cause at all (R7)', async () => {
    getJob.mockRejectedValue(new Error('ASA get failed 429: TooManyRequests'));
    const r = await GET(req(), { params: Promise.resolve({ name: 'j' }) });
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.hint).toBeUndefined();
    expect(j.error).toContain('429');
  });
});

describe('GET — an item id resolves to the job the provisioner recorded (#3573)', () => {
  it('retries against state.jobName and returns the real job', async () => {
    loadOwnedItem.mockResolvedValue({ ...ITEM, state: { jobName: 'Rides-Telemetry' } });
    getJob.mockImplementation(async (n: string) => {
      if (n === 'Rides-Telemetry') return { name: n, id: '/x', location: 'eastus' } as any;
      throw new AsaJobNotFoundError(n, 'rgAsa', 'sub1');
    });
    const r = await GET(req(), { params: Promise.resolve({ name: 'item-1' }) });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.job.name).toBe('Rides-Telemetry');
    expect(j.resolvedFrom).toBe('item-1');
  });

  it('offers an inline Fix it when the item exists but its job does not', async () => {
    loadOwnedItem.mockResolvedValue(ITEM);
    getJob.mockRejectedValue(new AsaJobNotFoundError('item-1', 'rgAsa', 'sub1'));
    const r = await GET(req(), { params: Promise.resolve({ name: 'item-1' }) });
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    expect(j.error).toContain('has not been created yet');
    // ux-baseline.md G2 — a remediation the platform can perform must be an
    // inline action, not a paragraph telling the user to go do something.
    expect(j.fixIt.method).toBe('POST');
    expect(j.fixIt.href).toContain('provision=1');
  });

  it('says only what it established when the segment is neither a job nor a visible item', async () => {
    loadOwnedItem.mockResolvedValue(null);
    getJob.mockRejectedValue(new AsaJobNotFoundError('ghost', 'rgAsa', 'sub1'));
    const r = await GET(req(), { params: Promise.resolve({ name: 'ghost' }) });
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-found');
    expect(j.fixIt).toBeUndefined();
    expect(j.hint).toBeUndefined();
  });
});

describe('POST — the Fix-it runs the REAL provisioner (#3573)', () => {
  it('provisions the backing job for the item and reports its name', async () => {
    loadOwnedItem.mockResolvedValue(ITEM);
    const r = await POST(req('https://loom.test/api/items/stream-analytics-job/item-1?provision=1'), { params: Promise.resolve({ name: 'item-1' }) });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(streamAnalyticsJobProvisioner).toHaveBeenCalledTimes(1);
    expect(streamAnalyticsJobProvisioner.mock.calls[0][0]).toMatchObject({
      cosmosItemId: 'item-1', workspaceId: 'ws-1', displayName: 'Rides Telemetry',
    });
    expect(j.jobName).toBe('Rides-Telemetry');
  });

  it('is write-scoped — a caller the write ladder denies gets 404 and NO ARM call', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const r = await POST(req('https://loom.test/api/items/stream-analytics-job/item-1?provision=1'), { params: Promise.resolve({ name: 'item-1' }) });
    expect(r.status).toBe(404);
    expect(streamAnalyticsJobProvisioner).not.toHaveBeenCalled();
    // `allowReadRoles` is NOT passed, so a read-only Viewer cannot create Azure
    // resources through this route.
    expect(loadOwnedItem.mock.calls[0][3]).toBeUndefined();
  });

  it('requires provision=1 rather than mutating on any POST', async () => {
    const r = await POST(req(), { params: Promise.resolve({ name: 'item-1' }) });
    expect(r.status).toBe(400);
    expect(streamAnalyticsJobProvisioner).not.toHaveBeenCalled();
  });

  it('reports a gated provisioner as 501 with its remediation, never as success', async () => {
    loadOwnedItem.mockResolvedValue(ITEM);
    streamAnalyticsJobProvisioner.mockResolvedValue({
      status: 'remediation', gate: { reason: 'ASA not configured', remediation: 'Set LOOM_ASA_RG' }, steps: [],
    } as any);
    const r = await POST(req('https://loom.test/api/items/stream-analytics-job/item-1?provision=1'), { params: Promise.resolve({ name: 'item-1' }) });
    const j = await r.json();
    expect(r.status).toBe(501);
    expect(j.ok).toBe(false);
    expect(j.hint).toContain('LOOM_ASA_RG');
  });
});
