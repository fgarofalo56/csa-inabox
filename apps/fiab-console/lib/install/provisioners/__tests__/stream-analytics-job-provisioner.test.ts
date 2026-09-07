/**
 * #3573 — the `stream-analytics-job` item type had NO Phase-2 provisioner, so
 * nothing in the platform ever created its backing
 * Microsoft.StreamAnalytics/streamingjobs resource.
 *
 * These tests pin the two halves of `auto-bind-by-default.md` for this item
 * type: the backing job is CREATED (a real `createOrUpdateJob` ARM PUT), and
 * the mapping from the Loom display name onto the ARM name is RECORDED on the
 * item so it is inspectable rather than guessed.
 *
 * Only the ARM/Cosmos boundary is mocked — the provisioner's own naming and
 * gating logic runs for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const createOrUpdateJob = vi.fn(async (s: any) => ({
  id: `/subscriptions/sub1/resourceGroups/rgAsa/providers/Microsoft.StreamAnalytics/streamingjobs/${s.name}`,
  name: s.name,
}));
const readAsaConfig = vi.fn(() => ({ subscriptionId: 'sub1', resourceGroup: 'rgAsa' }));

vi.mock('@/lib/azure/stream-analytics-client', () => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) { super(`Stream Analytics is not configured. Missing env: ${m.join(', ')}`); this.missing = m; }
  }
  return {
    AsaNotConfiguredError,
    readAsaConfig: () => readAsaConfig(),
    createOrUpdateJob: (s: any) => createOrUpdateJob(s),
  };
});

const replace = vi.fn(async (_doc?: any) => ({}));
const read = vi.fn(async () => ({ resource: { id: 'item-1', workspaceId: 'ws-1', state: {} } }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: vi.fn(() => ({ read, replace })) })),
}));

import { streamAnalyticsJobProvisioner, asaJobNameFor } from '../stream-analytics-job';
import { PROVISIONERS } from '@/lib/install/provisioning-engine';

const input = (displayName: string) => ({
  session: { claims: { oid: 'oid-1', email: 'op@contoso.com' } } as any,
  target: { mode: 'shared' as const },
  cosmosItemId: 'item-1',
  workspaceId: 'ws-1',
  displayName,
  content: {},
  appId: 'app-iot-realtime',
});

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ resource: { id: 'item-1', workspaceId: 'ws-1', state: {} } } as any);
  replace.mockResolvedValue({} as any);
  readAsaConfig.mockReturnValue({ subscriptionId: 'sub1', resourceGroup: 'rgAsa' });
  createOrUpdateJob.mockImplementation(async (s: any) => ({
    id: `/subscriptions/sub1/resourceGroups/rgAsa/providers/Microsoft.StreamAnalytics/streamingjobs/${s.name}`,
    name: s.name,
  }));
});

describe('#3573 — the item type has a provisioner at all', () => {
  it('is REGISTERED in the provisioning engine', () => {
    // The whole defect: PROVISIONERS had 25 entries and none of them was this
    // one, so an installed stream-analytics-job got a Cosmos row and no Azure
    // resource. Reverting the map entry turns this red.
    expect(Object.keys(PROVISIONERS)).toContain('stream-analytics-job');
    expect(PROVISIONERS['stream-analytics-job']).toBe(streamAnalyticsJobProvisioner);
  });
});

describe('#3573 — the backing ASA job is created and named after the item', () => {
  it('calls createOrUpdateJob EXACTLY ONCE with the item name', async () => {
    const res = await streamAnalyticsJobProvisioner(input('rides-telemetry'));
    expect(createOrUpdateJob).toHaveBeenCalledTimes(1);
    expect(createOrUpdateJob.mock.calls[0][0]).toMatchObject({ name: 'rides-telemetry' });
    expect(res.status).toBe('created');
    expect(res.secondaryIds?.jobName).toBe('rides-telemetry');
  });

  it('sanitizes only what ARM forces, deterministically', () => {
    // ARM allows letters, digits, '-' and '_' only, 3-63 chars.
    expect(asaJobNameFor('Rides Telemetry (prod)').name).toBe('Rides-Telemetry-prod');
    expect(asaJobNameFor('rides-telemetry').sanitized).toBe(false);
    // Same input, same output — the determinism contract.
    expect(asaJobNameFor('Rides Telemetry (prod)').name).toBe(asaJobNameFor('Rides Telemetry (prod)').name);
    // ARM rejects a name shorter than 3 characters outright.
    expect(asaJobNameFor('Io').name.length).toBeGreaterThanOrEqual(3);
    expect(asaJobNameFor('###').name).toBe('loom-asa-job');
    expect(asaJobNameFor('x'.repeat(200)).name.length).toBe(63);
  });

  it('RECORDS the backing job name on the item so the mapping is inspectable', async () => {
    await streamAnalyticsJobProvisioner(input('Rides Telemetry (prod)'));
    expect(replace).toHaveBeenCalledTimes(1);
    const written = replace.mock.calls[0][0] as any;
    expect(written.state.jobName).toBe('Rides-Telemetry-prod');
    expect(written.state.jobNameSanitized).toBe(true);
    expect(written.state.asaJobId).toContain('/streamingjobs/Rides-Telemetry-prod');
  });
});

describe('#3573 — honest outcomes, never an unverified success', () => {
  it('gates on ASA config WITHOUT calling ARM, naming the exact env vars', async () => {
    const { AsaNotConfiguredError } = await import('@/lib/azure/stream-analytics-client');
    readAsaConfig.mockImplementation(() => {
      throw new (AsaNotConfiguredError as any)(['LOOM_ASA_SUB (or LOOM_SUBSCRIPTION_ID)', 'LOOM_ASA_RG (or LOOM_DLZ_RG)']);
    });
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(res.status).toBe('remediation');
    expect(createOrUpdateJob).not.toHaveBeenCalled();
    expect(res.gate?.remediation).toContain('LOOM_ASA_RG');
    // no-fabric-dependency.md — the gate is an AZURE gate, never a Fabric one.
    expect(res.gate?.remediation).toContain('No Microsoft Fabric required');
  });

  it('does NOT report `created` when the job exists but its ref could not be recorded', async () => {
    replace.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 403 }));
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(createOrUpdateJob).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe('created');
    expect(res.secondaryIds?.refsPersisted).toBe('false');
    // R7 — states only what was established: the job exists, the write did not
    // confirm. No cause is asserted for the write failure.
    expect(res.gate?.reason || res.error).toContain('could not record it on the item');
  });

  it('surfaces an ARM authorization failure as a remediation naming the role, not a success', async () => {
    createOrUpdateJob.mockRejectedValue(new Error('ASA createOrUpdateJob failed 403: AuthorizationFailed'));
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(res.status).toBe('remediation');
    expect(res.gate?.remediation).toContain('Stream Analytics Contributor');
    expect(replace).not.toHaveBeenCalled();
  });
});
