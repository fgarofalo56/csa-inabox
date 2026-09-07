/**
 * #4354 review — the 404 Fix-it must not be offered to a caller the POST it
 * targets would refuse.
 *
 * The GET resolves the `[name]` segment with `allowReadRoles: true` on purpose:
 * a read-only Viewer must still be able to open the editor and be told the
 * backing streaming job does not exist. The `?provision=1` POST behind the
 * Fix-it button is write-scoped (`loadOwnedItem` WITHOUT `allowReadRoles`), so
 * rendering the button for that Viewer is a control that refuses itself — a
 * `ux-baseline.md` G2 "Fix it" that cannot fix anything.
 *
 * The gate uses the SAME predicate the POST uses, so the two cannot drift; that
 * is what the last case here pins.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) { super(`Missing env: ${m.join(', ')}`); this.missing = m; }
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

const getJob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/azure/stream-analytics-client', () => ({
  getJob,
  AsaNotConfiguredError: H.AsaNotConfiguredError,
  AsaJobNotFoundError: H.AsaJobNotFoundError,
}));

/** The item-authorization boundary — the whole subject of this file. */
const loadOwnedItem = vi.hoisted(() => vi.fn());
vi.mock('../../_lib/item-crud', () => ({ loadOwnedItem }));

const provisioner = vi.hoisted(() => vi.fn(async () => ({ status: 'created', resourceId: '/x', secondaryIds: { jobName: 'Rides-Telemetry' }, steps: [] })));
vi.mock('@/lib/install/provisioners/stream-analytics-job', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/install/provisioners/stream-analytics-job')>()),
  streamAnalyticsJobProvisioner: provisioner,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

import { GET, POST } from '../[name]/route';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { oid: 'oid-1' } } as any;
/** The editor opens on the Loom item id, not the ARM job name. */
const params = { params: Promise.resolve({ name: 'item-1' }) };
const ITEM = {
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'stream-analytics-job',
  displayName: 'Rides Telemetry',
  state: {},
} as any;

const notFound = () => new H.AsaJobNotFoundError('item-1', 'rgAsa', 'sub1');

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  getJob.mockRejectedValue(notFound());
});

describe('#4354 the 404 Fix-it is scoped to callers who could actually run it', () => {
  it('a WRITER gets the Fix-it, pointed at the provision POST', async () => {
    loadOwnedItem.mockResolvedValue(ITEM);       // both the read and write probe
    const r = (await GET({} as any, params)) as any;
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    expect(j.fixIt).toBeTruthy();
    expect(j.fixIt.method).toBe('POST');
    expect(j.fixIt.href).toContain('provision=1');
    expect(j.fixIt.href).toContain('workspaceId=ws-1');
    // The write probe really ran, and really was the write-scoped one.
    const scopes = loadOwnedItem.mock.calls.map((c: any[]) => c[3]?.allowReadRoles === true);
    expect(scopes).toContain(true);              // the read that opens the editor
    expect(scopes).toContain(false);             // the write probe (no options)
  });

  it('a READ-ONLY viewer gets the same honest 404 and NO Fix-it', async () => {
    // Read-scoped load succeeds; the write-scoped probe returns null.
    loadOwnedItem.mockImplementation(async (_id: string, _t: string, _tenant: string, opts?: any) =>
      opts?.allowReadRoles ? ITEM : null);

    const r = (await GET({} as any, params)) as any;
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    // The editor still opens and still says the truth…
    expect(j.expectedJobName).toBe('Rides-Telemetry');
    expect(String(j.error)).toContain('has not been created yet');
    // …with no button that would 404 on click, and it says who CAN fix it.
    expect(j.fixIt).toBeUndefined();
    expect(String(j.error)).toContain('write access');
  });

  it('the write probe uses the SAME predicate the POST enforces, so they cannot drift', async () => {
    // Same mock, driving the POST: it refuses for exactly the caller the GET
    // withheld the button from.
    loadOwnedItem.mockImplementation(async (_id: string, _t: string, _tenant: string, opts?: any) =>
      opts?.allowReadRoles ? ITEM : null);

    const req = { nextUrl: new URL('https://loom.test/x?provision=1') } as any;
    const r = (await POST(req, params)) as any;
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j.ok).toBe(false);
    expect(provisioner).not.toHaveBeenCalled();
    // The POST's own probe is write-scoped — no `allowReadRoles`.
    expect(loadOwnedItem.mock.calls.every((c: any[]) => c[3]?.allowReadRoles !== true)).toBe(true);
  });

  it('a segment that is no item of this type at all gets neither a Fix-it nor a remediation', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const r = (await GET({} as any, params)) as any;
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-found');
    expect(j.fixIt).toBeUndefined();
    // R7 — nothing is asserted about env vars the code did not look at.
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });
});
