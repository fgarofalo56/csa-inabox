import { describe, expect, it } from 'vitest';
import { ArmError, RestTenantArm, TITLE_MAX, classifyArm, htmlTitle, resourceTypeOf } from '../src/jobs/tenant-arm.js';
import { JobFailure } from '../src/jobs/types.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const RG = 'rg-csa-loom-health-dev01-eastus2';
const VAULT = 'https://kv-lhds-dev01-abc.vault.azure.net/';
const ARM = 'https://management.azure.com';
const HUB = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.EventHub/namespaces/evh/eventhubs/eh-t-a`;

// Four distinct values so a swapped field cannot pass. The ids are GUIDs because the parser checks that shape.
const FHIR_ID = {
  id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-lhds-dev01-a-fhir`,
  name: 'id-lhds-dev01-a-fhir',
  clientId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
};

interface Call { method: string; url: string; body?: string; auth?: string }

interface Canned { status: number; body?: unknown; headers?: Record<string, string>; nonJson?: boolean; text?: string }

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
      text: async () => r.text ?? (r.nonJson ? '' : JSON.stringify(r.body ?? {})),
      json: async () => {
        if (r.nonJson) throw new SyntaxError('Unexpected token < in JSON');
        return r.body ?? {};
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const logs: { event: string; fields: Record<string, string | number> }[] = [];
  const sleeps: number[] = [];
  const arm = new RestTenantArm({
    armEndpoint: ARM,
    subscriptionId: SUB,
    token: async (scope) => `tok:${scope}`,
    vaultScope: 'https://vault.azure.net/.default',
    loadTemplate: async () => ({ $schema: 'x' }),
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxPolls: 3,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { arm, calls, logs, sleeps };
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
      tenant: { value: { tenantSlug: 'a', stampName: 'dev01', maxStorageGiB: 5, eventHubId: HUB, fhirIdentity: FHIR_ID } },
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
    // Breaks if manifestFromOutputs drops fhirIdentity or reads another field into it (each value is distinct).
    expect(m.fhirIdentity).toEqual(FHIR_ID);
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

  describe('fhirIdentity in the tenant manifest (#5422 decision 9)', () => {
    const deploy = (fhirIdentity: unknown) =>
      rig([
        { status: 201 },
        { status: 200, body: { properties: { provisioningState: 'Succeeded', outputs: { tenant: { value: { tenantSlug: 'a', fhirIdentity } }, keyIds: { value: [] }, keyNames: { value: [] } } } } },
      ]).arm
        .deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} })
        .catch((x: unknown) => x);

    it('an absent fhirIdentity fails closed with a message that says to redeploy the tenant', async () => {
      // Breaks if manifestFromOutputs defaults a missing fhirIdentity to empty strings instead of throwing.
      const e = await deploy(undefined);
      expect(e).toBeInstanceOf(JobFailure);
      expect((e as JobFailure).code).toBe('tenant_manifest_fhir_identity_missing');
      expect((e as JobFailure).message).toContain('redeploy the tenant');
    });

    it.each(['id', 'name', 'clientId', 'principalId'] as const)('an empty %s fails closed and names that field', async (field) => {
      // Breaks if one field is dropped from the completeness check; each case blanks exactly one.
      const e = (await deploy({ ...FHIR_ID, [field]: '' })) as JobFailure;
      expect(e.code).toBe('tenant_manifest_fhir_identity_missing');
      expect(e.message).toContain(`empty: ${field})`);
    });

    it('a non-GUID clientId or principalId is refused', async () => {
      // Breaks if the GUID shape check is removed: 'not-a-guid' would be handed to the federated service account annotation.
      expect(((await deploy({ ...FHIR_ID, clientId: 'not-a-guid' })) as JobFailure).code).toBe('tenant_manifest_fhir_identity_malformed');
      expect(((await deploy({ ...FHIR_ID, principalId: 'not-a-guid' })) as JobFailure).code).toBe('tenant_manifest_fhir_identity_malformed');
    });

    it('a read-only lookup of a pre-B2a record reports no_outputs (destroy derives names) while a current record is found', async () => {
      // Breaks if tenant.destroy's lookup throws for a legacy tenant (the tenant would become undeletable),
      // or if the absorb swallows a record that DOES carry fhirIdentity.
      const body = (tenant: unknown) => ({ status: 200, body: { properties: { outputs: { tenant: { value: tenant }, keyIds: { value: [] }, keyNames: { value: [] } } } } });
      expect((await rig([body({ tenantSlug: 'a' })]).arm.getTenantManifest(RG, 'a')).state).toBe('no_outputs');
      const hit = await rig([body({ tenantSlug: 'a', fhirIdentity: FHIR_ID })]).arm.getTenantManifest(RG, 'a');
      expect(hit.state).toBe('found');
      expect(hit.state === 'found' && hit.value.fhirIdentity).toEqual(FHIR_ID);
    });
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

  it('action and scope come from the SAME text: an unparsable scope is left unset, not borrowed from a detail', async () => {
    // Found in re-review of #5384: the outer Linked scope (non-ASCII RG, outside the scope class) failed to
    // match, and the scope of an unrelated detail was spliced onto the outer action.
    const outer = `does not have permission to perform action(s) 'Microsoft.A/b/x' on the linked scope(s) '/subscriptions/${SUB}/resourceGroups/rg-é'.`;
    const other = `/subscriptions/${SUB}/resourceGroups/OTHER`;
    const e = (await put({
      status: 403,
      body: { error: { code: 'LinkedAuthorizationFailed', message: outer, details: [{ code: 'AuthorizationFailed', message: `perform action 'Microsoft.Z/z/read' over scope '${other}'` }] } },
    })) as ArmError;
    expect(e.diag?.action).toBe('Microsoft.A/b/x');
    expect(e.diag?.scope).toBeUndefined(); // breaks if action and scope are collected independently (would be OTHER)
    expect(e.message).toContain('[denied Microsoft.A/b/x; details AuthorizationFailed]');
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
    expect(keys.message).toBe(`start tenant deployment failed: HTTP 403 Unknown [body keys:foo,bar; len 18; first {; cause gateway; correlation ${corr}]`);
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

describe('wide diagnostics for a bare ARM refusal (#5380)', () => {
  const get = (canned: Canned) => rig([canned]).arm.getStampManifest(RG, 'dev01').catch((x: unknown) => x) as Promise<ArmError>;

  it('a bare 403 with an empty body reports type, length, server, request id and first byte', async () => {
    const e = await get({ status: 403, text: '', nonJson: true, headers: { 'content-type': 'Text/Plain; charset=utf-8', server: 'Microsoft-HTTPAPI/2.0', 'x-ms-request-id': 'req-123' } });
    // Each breaks if its field is dropped, mis-cased or left unstripped (charset would survive without the split).
    expect(e.diag).toMatchObject({ contentType: 'text/plain', contentLength: 0, server: 'Microsoft-HTTPAPI/2.0', requestId: 'req-123', firstByte: 'empty' });
    expect(e.message).toBe('read stamp deployment failed: HTTP 403 Unknown [body empty-or-non-json; type text/plain; len 0; server Microsoft-HTTPAPI/2.0; request req-123; first empty]');
  });

  it('an HTML 403 is classed first "<" with the measured byte length when no content-length header exists', async () => {
    const html = '  \n<html><body>Forbidden</body></html>';
    const e = await get({ status: 403, text: html, nonJson: true, headers: { 'content-type': 'text/html' } });
    expect(e.diag?.firstByte).toBe('<'); // breaks if leading whitespace is not skipped (would be "other")
    expect(e.diag?.contentType).toBe('text/html');
    expect(e.diag?.contentLength).toBe(Buffer.byteLength(html));
    expect(e.message).not.toContain('Forbidden'); // body text is never echoed
  });

  it('a numeric content-length header wins over the measured length; a non-numeric one is ignored', async () => {
    expect((await get({ status: 403, text: 'abc', nonJson: true, headers: { 'content-length': '999' } })).diag?.contentLength).toBe(999);
    expect((await get({ status: 403, text: 'abc', nonJson: true, headers: { 'content-length': '9 9' } })).diag?.contentLength).toBe(3);
  });

  it('a JSON AuthorizationFailed 403 carries NO wide fields, and still renders action, scope and correlation', async () => {
    const SC = `/subscriptions/${SUB}/resourceGroups/${RG}`;
    const e = await get({
      status: 403,
      body: { error: { code: 'AuthorizationFailed', message: `perform action 'Microsoft.Resources/deployments/read' over scope '${SC}'` } },
      headers: { 'content-type': 'application/json', server: 'Microsoft-HTTPAPI/2.0', 'x-ms-request-id': 'r1', 'x-ms-correlation-request-id': 'corr-1' },
    });
    // Breaks if the wide fields are filled outside the no-code branch.
    expect([e.diag?.contentType, e.diag?.contentLength, e.diag?.server, e.diag?.requestId, e.diag?.firstByte]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // Positive pair: the existing rendering is intact.
    expect(e.message).toBe(`read stamp deployment failed: HTTP 403 AuthorizationFailed [denied Microsoft.Resources/deployments/read over ${SC}; correlation corr-1]`);
  });

  it('a hostile server / content-type / request id is dropped, never echoed raw', async () => {
    const e = await get({
      status: 403,
      text: '',
      nonJson: true,
      headers: { server: 'evil; x=1 INJECTED', 'content-type': 'text/html\nINJECTED', 'x-ms-request-id': 'a b' },
    });
    expect(e.diag?.server).toBeUndefined(); // breaks if SERVER_TOKEN admits ";" or "=" (a product list is space-separated, never ";")
    expect(e.diag?.contentType).toBeUndefined(); // breaks if MEDIA_TYPE is not applied
    expect(e.diag?.requestId).toBeUndefined();
    expect(e.message).not.toContain('INJECTED');
    const long = await get({ status: 403, text: '', nonJson: true, headers: { server: 'a'.repeat(61) } });
    expect(long.diag?.server).toBeUndefined(); // breaks if the length cap is removed
    const ok = await get({ status: 403, text: '', nonJson: true, headers: { server: 'a'.repeat(60) } });
    expect(ok.diag?.server).toBe('a'.repeat(60)); // positive: the cap is a boundary, not a blanket drop
  });
});

// #5380 live shape (G1 run 44676840702): the poll GET got "HTTP 403 Unknown [body empty-or-non-json;
// len 875; first <]": an HTML page with no x-ms-request-id, intermittent per request. These pin the
// fingerprint it now carries and the bounded retry that applies ONLY to that non-ARM shape.
describe('non-ARM HTML 403: fingerprint and bounded retry (#5380)', () => {
  const REF = '20251120T101500Z-17d8c9b4f5b6xyzq';
  const PAGE = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><p>Request blocked.</p></body></html>';
  const HTML_403: Canned = { status: 403, text: PAGE, nonJson: true, headers: { 'content-type': 'text/html; charset=utf-8', 'x-azure-ref': REF } };
  const deploy = (arm: RestTenantArm) => arm.deployTenant({ resourceGroup: RG, slug: 'a', displayName: 'A', maxStorageGiB: 5, stamp: {} });

  it('HTML 403 then 200: succeeds on the second attempt and logs the fingerprint of the refused one', async () => {
    const { arm, calls, logs, sleeps } = rig([HTML_403, { status: 200, body: { properties: { outputs: { stamp: { value: { stampName: 'dev01' } } } } } }]);
    // Breaks if the retry is removed: the first 403 would reject instead of resolving.
    expect(await arm.getStampManifest(RG, 'dev01')).toEqual({ state: 'found', value: { stampName: 'dev01' } });
    expect(calls).toHaveLength(2); // breaks if a success is retried or the retry is skipped
    expect(sleeps).toEqual([2000]); // breaks if the first backoff is not 2 s
    // Breaks if the log omits the fingerprint fields or logs only on exhaustion.
    expect(logs).toEqual([
      {
        event: 'arm.non_arm_403',
        fields: { op: 'read stamp deployment', method: 'GET', attempt: 1, of: 3, outcome: 'retrying', status: 403, code: 'Unknown', bodyShape: 'empty-or-non-json', contentType: 'text/html', contentLength: Buffer.byteLength(PAGE), firstByte: '<', title: '403 Forbidden', azureRef: REF },
      },
    ]);
    // REGRESSION GUARD, not coverage (assertion-design rule 5): fingerprint() never reads the token
    // today, so no current input fails this; it exists to catch a future change that logs it.
    expect(JSON.stringify(logs)).not.toContain('tok:');
  });

  it('HTML 403 x3 on the PUT: fails closed as permission after exactly 3 attempts, naming type, title and edge ref', async () => {
    const { arm, calls, logs, sleeps } = rig([HTML_403]); // the rig repeats its last response forever
    const e = await deploy(arm).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArmError);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PUT']); // breaks if the bound is 2, 4 or absent (the rig never stops refusing)
    expect(sleeps).toEqual([2000, 4000]); // breaks if backoff is unbounded or not applied
    expect(logs.map((l) => l.fields.outcome)).toEqual(['retrying', 'retrying', 'exhausted']); // breaks if any refused attempt goes unlogged
    const f = classifyArm(e) as JobFailure;
    expect(f.code).toBe('permission'); // breaks if exhaustion is classified transient (would invite an unbounded outer retry)
    expect(f.message).toContain("refused by an HTML 403 without ARM's markers (origin unidentified"); // breaks if the message asserts the 403 was not from ARM
    // Breaks if the clue clause stops being conditional on captured clues (this response HAS a title and x-azure-ref).
    expect(f.message).toContain('the title, server, cause and edge headers above are the only clues to who answered.');
    expect(f.message).toContain('on all 3 attempt(s)');
    expect(f.message).toContain(`type text/html; len ${Buffer.byteLength(PAGE)}; first <; title 403 Forbidden; x-azure-ref ${REF}`);
    // R7: breaks if the message claims the CP identity was denied, which nothing established.
    expect(f.message).not.toContain('not authorised');
  });

  it('an empty codeless 403 with no edge headers: the message says nothing identifies the answerer (R7)', async () => {
    const { arm, calls } = rig([{ status: 403, text: '', nonJson: true }]);
    const f = classifyArm(await deploy(arm).catch((x: unknown) => x)) as JobFailure;
    expect(calls).toHaveLength(3); // positive: still the non-ARM retry path
    expect(f.message).toContain("refused by a 403 without ARM's markers"); // breaks if a non-HTML body is labelled HTML
    // Breaks if the clue clause is unconditional: no title or edge header was captured, so claiming them is false.
    expect(f.message).toContain('nothing in the response identifies who answered.');
    expect(f.message).not.toContain('only clues');
  });

  it('a codeless 403 whose ONLY clue is x-ms-failure-cause still counts it as a clue (R7)', async () => {
    const { arm } = rig([{ status: 403, text: '', nonJson: true, headers: { 'x-ms-failure-cause': 'gateway' } }]);
    const f = classifyArm(await deploy(arm).catch((x: unknown) => x)) as JobFailure;
    expect(f.message).toContain('cause gateway'); // positive: the cause is printed
    // Breaks if failureCause is left out of the clue list: the message would print a cause, then deny any clue exists.
    expect(f.message).toContain('only clues to who answered.');
    expect(f.message).not.toContain('nothing in the response identifies');
  });

  it('a genuine ARM JSON 403 (error.code, even without x-ms-request-id) is NOT retried: exactly one fetch', async () => {
    const { arm, calls, logs, sleeps } = rig([{ status: 403, body: { error: { code: 'AuthorizationFailed', message: 'x' } } }, { status: 200 }]);
    const e = await deploy(arm).catch((x: unknown) => x);
    // Breaks if the retry predicate ignores error.code: the second response (200) would be reached.
    expect(calls).toHaveLength(1);
    expect([logs, sleeps]).toEqual([[], []]);
    const f = classifyArm(e) as JobFailure;
    expect(f.code).toBe('permission');
    expect(f.message).toContain('the control-plane identity is not authorised (HTTP 403 AuthorizationFailed)'); // positive: the ARM path is unchanged
  });

  it('a codeless 403 that carries x-ms-request-id came from ARM and is NOT retried', async () => {
    const { arm, calls } = rig([{ status: 403, text: '', nonJson: true, headers: { 'x-ms-request-id': 'r-1' } }, { status: 200 }]);
    await expect(deploy(arm)).rejects.toBeInstanceOf(ArmError);
    expect(calls).toHaveLength(1); // breaks if the predicate ignores x-ms-request-id
  });

  it('text/html; charset=utf-8 is recorded as text/html', async () => {
    const e = (await rig([HTML_403]).arm.getStampManifest(RG, 'dev01').catch((x: unknown) => x)) as ArmError;
    // Breaks if the parameter strip is reverted: "text/html; charset=utf-8" fails MEDIA_TYPE and nothing is recorded.
    expect(e.diag?.contentType).toBe('text/html');
  });

  it('the title is sanitised: tags, entities, token- and id-shaped words removed, bounded to TITLE_MAX', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    const page = `<html><head><title>Access &amp; <b>Denied</b> &lt;script&gt; ${jwt} MRN-123456 ${'Blocked by proxy '.repeat(30)}</title></head></html>`;
    const e = (await rig([{ status: 403, text: page, nonJson: true }]).arm.getStampManifest(RG, 'dev01').catch((x: unknown) => x)) as ArmError;
    // By construction: "Access Denied script " (21) + 3 x "Blocked by proxy " (51) + "Blocked " (8) = 80, trimmed to 79.
    const expected = `Access Denied script ${'Blocked by proxy '.repeat(30)}`.slice(0, TITLE_MAX).trim();
    expect(expected).toHaveLength(79);
    // Breaks if the length bound is dropped (the 500+ char title would survive) or tags/entities leak.
    expect(e.diag?.title).toBe(expected);
    expect(e.message).not.toContain(jwt.slice(0, 12)); // breaks if token-shaped words are kept
    expect(e.message).not.toContain('123456'); // breaks if id-shaped words are kept
    expect(htmlTitle('<title> &lt;&gt; <i></i> </title>')).toBeUndefined(); // nothing left: no empty "title" field
  });

  it('edge headers are recorded when allowlist-clean and dropped when not; a server product list is admitted', async () => {
    const msedge = 'Ref A: 0A1B2C3D Ref B: BL2EDGE0108 Ref C: 2025-11-20T10:15:00Z';
    const ok = (await rig([{ status: 403, text: '', nonJson: true, headers: { 'x-msedge-ref': msedge, 'x-cache': 'TCP_DENIED from proxy:3128', via: '1.1 squid (squid/4.10)', server: 'Microsoft-HTTPAPI/2.0 Microsoft-IIS/10.0' } }])
      .arm.getStampManifest(RG, 'dev01')
      .catch((x: unknown) => x)) as ArmError;
    // Each breaks if its header is not read or its allowlist is narrower than the real value.
    expect(ok.diag).toMatchObject({ msedgeRef: msedge, cache: 'TCP_DENIED from proxy:3128', via: '1.1 squid (squid/4.10)', server: 'Microsoft-HTTPAPI/2.0 Microsoft-IIS/10.0' });
    expect(ok.message).toContain(`x-msedge-ref ${msedge}; x-cache TCP_DENIED from proxy:3128; via 1.1 squid (squid/4.10)`);
    const bad = (await rig([{ status: 403, text: '', nonJson: true, headers: { 'x-azure-ref': 'a b', 'x-msedge-ref': 'Ref A; INJECTED', 'x-cache': 'HIT\nINJECTED', via: '1.1 "q"' } }])
      .arm.getStampManifest(RG, 'dev01')
      .catch((x: unknown) => x)) as ArmError;
    // Breaks if any allowlist admits a space (azure-ref), ";", a newline or a quote.
    expect([bad.diag?.azureRef, bad.diag?.msedgeRef, bad.diag?.cache, bad.diag?.via]).toEqual([undefined, undefined, undefined, undefined]);
    expect(bad.message).not.toContain('INJECTED');
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
