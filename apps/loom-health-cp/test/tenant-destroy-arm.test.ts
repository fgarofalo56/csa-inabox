// RestTenantArm pieces tenant.destroy needs for #5392: the bounded in-flight wait on the tenant
// deployment, the storage-account immutability readback, and the private-endpoint API version.
import { describe, expect, it } from 'vitest';
import { RestTenantArm, TENANT_DEPLOY_SETTLE_MS } from '../src/jobs/tenant-arm.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const RG = 'rg-csa-loom-health-dev01-eastus2';
const ARM = 'https://management.azure.com';
const AUDIT = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/sthtaacme1`;
const PE = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/privateEndpoints/pe-sthtaacme1-blob`;
const POLL_MS = 1000;

interface Canned { status: number; body?: unknown }

function rig(responses: Canned[]) {
  const urls: string[] = [];
  let i = 0;
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)] as Canned;
    return { status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body ?? {}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const arm = new RestTenantArm({
    armEndpoint: ARM,
    subscriptionId: SUB,
    token: async () => 'tok',
    vaultScope: 'https://vault.azure.net/.default',
    loadTemplate: async () => ({}),
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pollMs: POLL_MS,
    log: () => {},
  });
  return { arm, urls, sleeps };
}

const dep = (provisioningState?: string): Canned => ({ status: 200, body: { properties: provisioningState === undefined ? {} : { provisioningState } } });

describe('awaitTenantDeployment (#5392 defect 1)', () => {
  it('the default cap is 15 minutes', () => {
    expect(TENANT_DEPLOY_SETTLE_MS).toBe(900_000); // a larger cap would let destroy hang past the job budget
  });

  it('Running, Running, Succeeded: polls until terminal and reports the reads', async () => {
    const { arm, urls, sleeps } = rig([dep('Running'), dep('Running'), dep('Succeeded')]);
    expect(await arm.awaitTenantDeployment(RG, 'acme', 10 * POLL_MS)).toEqual({ state: 'terminal', provisioningState: 'Succeeded', polls: 3 });
    expect(urls[0]).toContain('/providers/Microsoft.Resources/deployments/lhds-tenant-acme?');
    expect(sleeps).toEqual([POLL_MS, POLL_MS]); // a third sleep would mean it slept after the terminal read
  });

  it('still Running at the cap: in_flight, and the total sleep never exceeds the cap', async () => {
    const { arm, urls, sleeps } = rig([dep('Running')]);
    const out = await arm.awaitTenantDeployment(RG, 'acme', 2.5 * POLL_MS);
    expect(out).toEqual({ state: 'in_flight', provisioningState: 'Running', polls: 3 });
    expect(urls).toHaveLength(3);
    // Input that breaks it: an off-by-one that sleeps after the last read makes this 3000 > 2500.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(2 * POLL_MS);
  });

  it('a missing or non-identifier state is NOT terminal (fails closed as in_flight)', async () => {
    const empty = rig([dep(undefined)]);
    expect(await empty.arm.awaitTenantDeployment(RG, 'acme', 0)).toEqual({ state: 'in_flight', provisioningState: '', polls: 1 });
    const odd = rig([dep('Succeeded<script>')]);
    // Sanitised to letters only: "Succeededscript", which is not a terminal state.
    expect(await odd.arm.awaitTenantDeployment(RG, 'acme', 0)).toEqual({ state: 'in_flight', provisioningState: 'Succeededscript', polls: 1 });
  });

  it('a 404 deployment is absent; Failed and Canceled are terminal on the first read', async () => {
    expect(await rig([{ status: 404 }]).arm.awaitTenantDeployment(RG, 'acme')).toEqual({ state: 'absent' });
    for (const s of ['Failed', 'Canceled']) {
      const r = rig([dep(s)]);
      expect(await r.arm.awaitTenantDeployment(RG, 'acme')).toEqual({ state: 'terminal', provisioningState: s, polls: 1 });
      expect(r.sleeps).toEqual([]);
    }
  });
});

describe('readResource for destroy (#5392)', () => {
  it('reports a storage account immutability period and policy state', async () => {
    const { arm } = rig([
      {
        status: 200,
        body: {
          id: AUDIT,
          name: 'sthtaacme1',
          properties: { immutableStorageWithVersioning: { enabled: true, immutabilityPolicy: { immutabilityPeriodSinceCreationInDays: 2190, state: 'Unlocked' } } },
        },
      },
    ]);
    expect(await arm.readResource(AUDIT)).toEqual({
      id: AUDIT,
      exists: true,
      name: 'sthtaacme1',
      immutability: { enabled: true, periodDays: 2190, policyState: 'Unlocked' },
    });
  });

  it('an account without immutableStorageWithVersioning carries no immutability field', async () => {
    const { arm } = rig([{ status: 200, body: { id: AUDIT, name: 'sthtaacme1', properties: {} } }]);
    expect(await arm.readResource(AUDIT)).toEqual({ id: AUDIT, exists: true, name: 'sthtaacme1' });
  });

  it('a private endpoint id is readable and deletable (an API version is known for it)', async () => {
    const { arm, urls } = rig([{ status: 200, body: {} }, { status: 404 }]);
    await arm.deleteResource(PE);
    expect(urls[0]).toBe(`${ARM}${PE}?api-version=2024-05-01`);
    expect(urls).toHaveLength(2); // DELETE, then the read that proves it gone
  });
});
