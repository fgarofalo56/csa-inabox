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
/**
 * The 404 the client really throws. Built by importing the class OUT of the
 * mocked module rather than declaring one here: the provisioner's read-before-
 * write branch narrows on `instanceof AsaJobNotFoundError`, so a look-alike
 * declared in this file would take the wrong branch and the test would prove
 * nothing. It is resolved lazily because the `vi.mock` factory below is hoisted
 * above every top-level binding in this file.
 */
async function asaNotFound(name: string): Promise<Error> {
  const { AsaJobNotFoundError } = await import('@/lib/azure/stream-analytics-client');
  return new (AsaJobNotFoundError as any)(name, 'rgAsa', 'sub1');
}

/**
 * Default: the job is NOT there yet, which is what authorises the PUT.
 *
 * The return type is annotated because a factory that only ever throws infers
 * `Promise<never>`, and `never` makes every `mockResolvedValue` in the
 * finding-7 block a compile error rather than a stub.
 */
const getJob = vi.fn(async (name: string): Promise<Record<string, any>> => {
  throw await asaNotFound(name);
});

vi.mock('@/lib/azure/stream-analytics-client', () => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) { super(`Stream Analytics is not configured. Missing env: ${m.join(', ')}`); this.missing = m; }
  }
  class AsaJobNotFoundError extends Error {
    constructor(public jobName: string, public resourceGroup: string, public subscriptionId: string) {
      super(`Stream Analytics job '${jobName}' does not exist in resource group '${resourceGroup}' (subscription ${subscriptionId}).`);
      this.name = 'AsaJobNotFoundError';
    }
  }
  return {
    AsaNotConfiguredError,
    AsaJobNotFoundError,
    readAsaConfig: () => readAsaConfig(),
    createOrUpdateJob: (s: any) => createOrUpdateJob(s),
    getJob: (n: string) => getJob(n),
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
  getJob.mockImplementation(async (name: string) => {
    throw await asaNotFound(name);
  });
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

describe('#4354 review finding 7 — the provisioner READS before it writes', () => {
  it('does NOT re-PUT a job that already exists, and reports `exists`', async () => {
    // `PUT …/streamingjobs/{name}` is create-OR-REPLACE on `properties`, and
    // the body this provisioner sends carries no inputs, outputs or
    // transformation — the same "idempotent upsert that silently replaces
    // state it did not compose" shape as the action-group defect #4113 fixes
    // in this very PR. This provisioner runs on app install, on the
    // deployment-pipeline promote path AND on the editor's Fix-it, so a second
    // run over a configured job would have reset it.
    getJob.mockResolvedValue({
      id: '/subscriptions/sub1/resourceGroups/rgAsa/providers/Microsoft.StreamAnalytics/streamingjobs/rides',
      name: 'rides',
      // A job the operator has configured: the state the PUT would have lost.
      inputs: [{ name: 'in1', type: 'Stream' }],
      outputs: [{ name: 'out1', type: 'Microsoft.Kusto/clusters/databases' }],
    } as any);
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(getJob).toHaveBeenCalledWith('rides');
    expect(createOrUpdateJob).not.toHaveBeenCalled();
    expect(res.status).toBe('exists');
    expect(res.resourceId).toContain('/streamingjobs/rides');
    expect((res.steps || []).join(' ')).toContain('already exists');
    // Still RECORDED on the item — the mapping stays inspectable whether the
    // job was created now or found (`auto-bind-by-default.md` §2).
    expect(replace).toHaveBeenCalledTimes(1);
    expect(res.secondaryIds?.jobName).toBe('rides');
  });

  it('creates the job when the read is a clean 404 — absence is the ONLY thing that authorises the PUT', async () => {
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(createOrUpdateJob).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('created');
  });

  it('does NOT treat a 403 on the read as absence (R7)', async () => {
    // The failure mode this guards: swallowing every read error would turn
    // "I could not look" into "it is not there" and then PUT over a job that
    // exists — a false claim AND a destructive write, from one catch block.
    getJob.mockRejectedValue(new Error('ASA get failed 403: AuthorizationFailed'));
    const res = await streamAnalyticsJobProvisioner(input('rides'));
    expect(createOrUpdateJob).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(res.status).not.toBe('created');
    expect(res.status).not.toBe('exists');
  });
});
