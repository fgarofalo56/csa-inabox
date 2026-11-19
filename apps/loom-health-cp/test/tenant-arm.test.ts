import { describe, expect, it } from 'vitest';
import { ArmError, RestTenantArm, classifyArm, resourceTypeOf } from '../src/jobs/tenant-arm.js';
import { JobFailure } from '../src/jobs/types.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const RG = 'rg-csa-loom-health-dev01-eastus2';
const VAULT = 'https://kv-lhds-dev01-abc.vault.azure.net/';
const ARM = 'https://management.azure.com';
const HUB = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.EventHub/namespaces/evh/eventhubs/eh-t-a`;

interface Call { method: string; url: string; body?: string; auth?: string }

interface Canned { status: number; body?: unknown; headers?: Record<string, string>; nonJson?: boolean }

function rig(responses: Canned[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      auth: (init.headers as Record<string, string>).authorization as string,
    });
    const r = responses[Math.min(i++, responses.length - 1)] as Canned;
    // A minimal Headers stand-in: the real Headers class refuses CR/LF, so it could not carry the injection case below.
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
      json: async () => {
        if (r.nonJson) throw new SyntaxError('Unexpected token < in JSON');
        return r.body ?? {};
      },
    } as unknown as Response;
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

// #5380: a 403 on the tenant deployment PUT reported only "HTTP 403 Unknown", so nobody could say
// WHAT ARM refused. These pin that the denied action and scope reach the job failure, and that
// nothing but identifiers does. Messages are shaped like ARM's real AuthorizationFailed text.
describe('ARM refusal diagnostics (#5380)', () => {
  const OID = '11111111-2222-3333-4444-555555555555';
  const SCOPE = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/7a1b`;
  const AUTHZ_MSG = `The client '${OID}' with object id '${OID}' does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope '${SCOPE}' or the scope is invalid. If access was recently granted, please refresh your credentials.`;
  const put = (canned: Canned) =>
    rig([canned]).arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} }).catch((x: unknown) => x);

  it('AuthorizationFailed: the job failure names the denied action and scope, and never the client id or the prose', async () => {
    const e = (await put({ status: 403, body: { error: { code: 'AuthorizationFailed', message: AUTHZ_MSG } } })) as ArmError;
    expect(e.diag).toMatchObject({ action: 'Microsoft.Authorization/roleAssignments/write', scope: SCOPE });
    const msg = (classifyArm(e) as JobFailure).message;
    // Breaks if the DENIED_ACTION/DENIED_SCOPE match is dropped or classifyArm stops appending it.
    expect(msg).toContain(`HTTP 403 AuthorizationFailed) [denied Microsoft.Authorization/roleAssignments/write over ${SCOPE}]`);
    // Breaks if the raw message is appended instead of the matched identifiers.
    expect(msg).not.toContain(OID);
    expect(msg).not.toContain('does not have authorization');
  });

  it('LinkedAuthorizationFailed: reports the DENIED linked action and scope, not the allowed one quoted first', async () => {
    const linkedScope = `/subscriptions/${SUB}/resourceGroups/other/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-x`;
    const linked = `The client '${OID}' with object id '${OID}' has permission to perform action 'Microsoft.Resources/deployments/write' on scope '/subscriptions/${SUB}/resourceGroups/${RG}'; however, it does not have permission to perform action(s) 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action' on the linked scope(s) '${linkedScope}' (respectively) or the linked scope(s) are invalid.`;
    const e = (await put({ status: 403, body: { error: { code: 'LinkedAuthorizationFailed', message: linked } } })) as ArmError;
    // Breaks if the plain "action '...'" form is tried first: it would report the ALLOWED deployments/write.
    expect(e.diag?.action).toBe('Microsoft.ManagedIdentity/userAssignedIdentities/assign/action');
    expect(e.diag?.scope).toBe(linkedScope);
  });

  it('LinkedAuthorizationFailed with SEVERAL linked actions reports every denied one, never the allowed one', async () => {
    // ARM comma-joins a linked list inside ONE quoted string ("(respectively)"). Found in review of #5384:
    // a class without the comma failed the (s) form and fell back to the plain form, naming the ALLOWED action.
    const s1 = `/subscriptions/${SUB}/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/v/subnets/a`;
    const s2 = `/subscriptions/${SUB}/resourceGroups/ids/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-x`;
    const msg = `The client '${OID}' with object id '${OID}' has permission to perform action 'Microsoft.Compute/virtualMachines/write' on scope '/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/vm'; however, it does not have permission to perform action(s) 'Microsoft.Network/virtualNetworks/subnets/join/action,Microsoft.ManagedIdentity/userAssignedIdentities/assign/action' on the linked scope(s) '${s1},${s2}' (respectively) or the linked scope(s) are invalid.`;
    const e = (await put({ status: 403, body: { error: { code: 'LinkedAuthorizationFailed', message: msg } } })) as ArmError;
    // Breaks if the (s) class loses the comma list: the result would be Microsoft.Compute/virtualMachines/write.
    expect(e.diag?.action).toBe('Microsoft.Network/virtualNetworks/subnets/join/action,Microsoft.ManagedIdentity/userAssignedIdentities/assign/action');
    expect(e.diag?.scope).toBe(`${s1},${s2}`);
    expect(e.message).not.toContain('virtualMachines/write');
  });

  it('a Linked message whose list does not parse reports no action, rather than falling back to the allowed one', async () => {
    const msg = `has permission to perform action 'Microsoft.Compute/virtualMachines/write' on scope '/subscriptions/${SUB}'; however, it does not have permission to perform action(s) 'not a list' on the linked scope(s) 'nor this'.`;
    const e = (await put({ status: 403, body: { error: { code: 'LinkedAuthorizationFailed', message: msg } } })) as ArmError;
    // Breaks if a Linked message is allowed to fall back to the plain "action '...'" form.
    expect(e.diag?.action).toBeUndefined();
    expect(e.diag?.scope).toBeUndefined();
    expect(e.code).toBe('LinkedAuthorizationFailed'); // positive: the code still lands
  });

  it('a refusal nested in details[] surfaces the detail codes and the nested denied action', async () => {
    const e = (await put({
      status: 400,
      body: { error: { code: 'InvalidTemplateDeployment', message: 'The template deployment failed with multiple errors.', details: [{ code: 'AuthorizationFailed', message: AUTHZ_MSG }, { code: 'Conflict' }] } },
    })) as ArmError;
    expect(e.code).toBe('InvalidTemplateDeployment');
    expect(e.diag?.details).toEqual(['AuthorizationFailed', 'Conflict']); // breaks if details[] is not read
    expect(e.diag?.action).toBe('Microsoft.Authorization/roleAssignments/write'); // breaks if only the outer message is scanned
  });

  it('a capitalised { Code } or a bare top-level { code } is read, not reported as Unknown', async () => {
    expect(((await put({ status: 403, body: { Code: 'RequestDisallowedByPolicy', Message: 'x' } })) as ArmError).code).toBe('RequestDisallowedByPolicy');
    expect(((await put({ status: 403, body: { error: { Code: 'Forbidden' } } })) as ArmError).code).toBe('Forbidden');
    expect(((await put({ status: 403, body: { code: 'InvalidAuthenticationToken' } })) as ArmError).code).toBe('InvalidAuthenticationToken');
  });

  it('with no code at all, reports the body shape and the gateway headers instead of a bare Unknown', async () => {
    const corr = 'abcdef01-2345-6789-abcd-ef0123456789';
    const keys = (await put({ status: 403, body: { foo: 1, bar: {} }, headers: { 'x-ms-failure-cause': 'gateway', 'x-ms-correlation-request-id': corr } })) as ArmError;
    expect(keys.code).toBe('Unknown');
    expect(keys.message).toBe(`start tenant deployment failed: HTTP 403 Unknown [body keys:foo,bar; cause gateway; correlation ${corr}]`);
    const html = (await put({ status: 403, nonJson: true })) as ArmError;
    expect(html.diag?.bodyShape).toBe('empty-or-non-json');
    expect(((await put({ status: 403, body: {} })) as ArmError).diag?.bodyShape).toBe('empty');
  });

  it('header values outside the token class are dropped, so a header cannot forge a log line', async () => {
    const e = (await put({ status: 403, body: { error: { code: 'X' } }, headers: { 'x-ms-failure-cause': 'gateway\nINJECTED', 'x-ms-correlation-request-id': 'a b' } })) as ArmError;
    expect(e.diag?.failureCause).toBeUndefined(); // breaks if HEADER_TOKEN is not applied
    expect(e.diag?.correlationId).toBeUndefined();
    expect(e.message).toBe('start tenant deployment failed: HTTP 403 X'); // positive: the code still lands
  });

  it('a quoted value outside the action/scope character class is not lifted', async () => {
    // Each value is otherwise action/scope-shaped (a "/" and a leading "/"), so only the space keeps it
    // out: widening either class to admit a space turns this red.
    const e = (await put({ status: 403, body: { error: { code: 'AuthorizationFailed', message: "perform action 'Microsoft.X/a SECRET b' over scope '/subscriptions/a SECRET b'" } } })) as ArmError;
    expect(e.diag?.action).toBeUndefined();
    expect(e.diag?.scope).toBeUndefined();
    expect(e.message).not.toContain('SECRET');
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
