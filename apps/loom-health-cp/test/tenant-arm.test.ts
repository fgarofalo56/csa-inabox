import { describe, expect, it } from 'vitest';
import { ArmError, RestTenantArm, classifyArm, resourceTypeOf } from '../src/jobs/tenant-arm.js';
import { JobFailure } from '../src/jobs/types.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const RG = 'rg-csa-loom-health-dev01-eastus2';
const VAULT = 'https://kv-lhds-dev01-abc.vault.azure.net/';
const ARM = 'https://management.azure.com';
const HUB = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.EventHub/namespaces/evh/eventhubs/eh-t-a`;

interface Call { method: string; url: string; body?: string; auth?: string }

function rig(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      auth: (init.headers as Record<string, string>).authorization as string,
    });
    const r = responses[Math.min(i++, responses.length - 1)] as { status: number; body?: unknown };
    return { status: r.status, json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
  const arm = new RestTenantArm({
    armEndpoint: ARM,
    subscriptionId: SUB,
    token: async (scope) => `tok:${scope}`,
    vaultScope: 'https://vault.azure.net/.default',
    loadTemplate: async () => ({ $schema: 'x' }),
    fetchFn,
    sleep: async () => {},
    maxPolls: 3,
  });
  return { arm, calls };
}

describe('RestTenantArm', () => {
  it('resourceTypeOf keeps nested types: eventhubs under namespaces', () => {
    expect(resourceTypeOf(HUB)).toBe('microsoft.eventhub/namespaces/eventhubs');
  });

  it('rejects a malformed resource id before any HTTP call', async () => {
    const { arm, calls } = rig([{ status: 200 }]);
    await expect(arm.readResource('/subscriptions/x/../../etc')).rejects.toMatchObject({ code: 'bad_resource_id' });
    expect(calls).toHaveLength(0); // a call here means an unvalidated id reached the URL
  });

  it('reads a present resource and a 404 as exists:true/false', async () => {
    const hit = rig([{ status: 200, body: { id: HUB, name: 'eh-t-a' } }]);
    expect(await hit.arm.readResource(HUB)).toEqual({ id: HUB, exists: true, name: 'eh-t-a' });
    expect(hit.calls[0]?.url).toBe(`${ARM}${HUB}?api-version=2024-05-01-preview`);
    const miss = rig([{ status: 404 }]);
    expect((await miss.arm.readResource(HUB)).exists).toBe(false);
  });

  it('never puts the service error body into the thrown error, only its sanitized code', async () => {
    const { arm } = rig([{ status: 403, body: { error: { code: 'AuthorizationFailed', message: 'client 1234 SECRET-VALUE lacks access' } } }]);
    const e = await arm.readResource(HUB).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArmError);
    expect((e as ArmError).message).toBe('read resource failed: HTTP 403 AuthorizationFailed');
    expect((e as ArmError).message).not.toContain('SECRET-VALUE');
  });

  it('deployTenant PUTs an incremental deployment then returns the polled outputs', async () => {
    const outputs = {
      tenant: { value: { tenantSlug: 'a', stampName: 'dev01', maxStorageGiB: 5, eventHubId: HUB } },
      keyIds: { value: ['k1'] },
      keyNames: { value: ['t-a-st-pixel'] },
    };
    const { arm, calls } = rig([
      { status: 201 },
      { status: 200, body: { properties: { provisioningState: 'Running' } } },
      { status: 200, body: { properties: { provisioningState: 'Succeeded', outputs } } },
    ]);
    const m = await arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: { s: 1 } });
    expect(m.eventHubId).toBe(HUB);
    expect(m.keyNames).toEqual(['t-a-st-pixel']);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'GET']);
    const put = JSON.parse(calls[0]?.body ?? '{}');
    expect(put.properties.mode).toBe('Incremental'); // Complete would delete the stamp's own resources
    expect(put.properties.parameters.maxStorageGiB.value).toBe(5);
    expect(calls[0]?.auth).toBe(`Bearer tok:${ARM}/.default`);
  });

  it('a Failed deployment surfaces its code; a deployment that never finishes times out', async () => {
    const failed = rig([{ status: 201 }, { status: 200, body: { properties: { provisioningState: 'Failed', error: { code: 'QuotaExceeded', message: 'x' } } } }]);
    await expect(failed.arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} })).rejects.toMatchObject({ code: 'deployment_failed' });
    const stuck = rig([{ status: 201 }, { status: 200, body: { properties: { provisioningState: 'Running' } } }]);
    await expect(stuck.arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} })).rejects.toMatchObject({ code: 'deployment_timeout' });
  });

  it('a Succeeded deployment without a tenant output is a failure, not an empty manifest', async () => {
    const { arm } = rig([{ status: 201 }, { status: 200, body: { properties: { provisioningState: 'Succeeded', outputs: {} } } }]);
    await expect(arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} })).rejects.toMatchObject({ code: 'no_outputs' });
  });

  it('manifest lookups tell 404 apart from a record without outputs', async () => {
    expect((await rig([{ status: 404 }]).arm.getTenantManifest(RG, 'a')).state).toBe('absent');
    // 200 with no outputs: conflating this with 404 is the defect under test.
    expect((await rig([{ status: 200, body: { properties: { provisioningState: 'Failed' } } }]).arm.getTenantManifest(RG, 'a')).state).toBe('no_outputs');
    expect((await rig([{ status: 200, body: { properties: { outputs: {} } } }]).arm.getStampManifest(RG, 'dev01')).state).toBe('no_outputs');
    const ok = await rig([{ status: 200, body: { properties: { outputs: { stamp: { value: { stampName: 'dev01' } } } } } }]).arm.getStampManifest(RG, 'dev01');
    expect(ok).toEqual({ state: 'found', value: { stampName: 'dev01' } });
  });

  it('findTenantStorage keeps only storage accounts from the tag query', async () => {
    const sa = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/sthpxabc`;
    const { arm, calls } = rig([{ status: 200, body: { value: [{ id: sa }, { id: HUB }] } }]);
    expect(await arm.findTenantStorage(RG, 'a')).toEqual([sa]);
    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain("tagName eq 'lhds-tenant' and tagValue eq 'a'");
  });

  it('readKey falls through to deletedkeys and reports the deleted and purge dates', async () => {
    const { arm, calls } = rig([{ status: 404 }, { status: 200, body: { deletedDate: 1792972800, scheduledPurgeDate: 1800748800 } }]);
    const k = await arm.readKey(VAULT, 't-a-pg');
    expect(k).toEqual({ name: 't-a-pg', exists: false, deletedDate: '2026-10-26T00:00:00.000Z', scheduledPurgeDate: '2027-01-24T00:00:00.000Z' });
    expect(calls[1]?.url).toBe('https://kv-lhds-dev01-abc.vault.azure.net/deletedkeys/t-a-pg?api-version=7.5');
    expect(calls[1]?.auth).toBe('Bearer tok:https://vault.azure.net/.default'); // vault scope, not the ARM scope
  });

  it('a live key reports enabled from its attributes; absent everywhere reports no dates', async () => {
    expect((await rig([{ status: 200, body: { attributes: { enabled: false } } }]).arm.readKey(VAULT, 'k')).enabled).toBe(false);
    const gone = await rig([{ status: 404 }, { status: 404 }]).arm.readKey(VAULT, 'k');
    expect(gone).toEqual({ name: 'k', exists: false });
  });

  it('disableKey PATCHes enabled:false; deleteKey DELETEs; a non-https vault URI is refused', async () => {
    const { arm, calls } = rig([{ status: 200 }]);
    await arm.disableKey(VAULT, 'k');
    await arm.deleteKey(VAULT, 'k');
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'DELETE']);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ attributes: { enabled: false } });
    await expect(arm.deleteKey('http://169.254.169.254/', 'k')).rejects.toMatchObject({ code: 'bad_vault_uri' });
    expect(calls).toHaveLength(2);
  });
});

describe('classifyArm', () => {
  it('maps 403/401 to permission, 429/5xx to transient, other 4xx to arm_error, and passes other errors through', () => {
    const f = (s: number) => classifyArm(new ArmError(s, 'C', 'op')) as JobFailure;
    expect(f(403).code).toBe('permission');
    expect(f(401).code).toBe('permission');
    expect(f(429).code).toBe('transient');
    expect(f(503).code).toBe('transient');
    expect(f(400).code).toBe('arm_error');
    const other = new Error('x');
    expect(classifyArm(other)).toBe(other);
  });
});
