import { describe, it, expect } from 'vitest';
import {
  ARM_API_VERSIONS,
  apiVersionFor,
  familyPropertiesFromArm,
  foundryDeploymentProps,
  networkPostureFromArm,
  probeAdoption,
  probeRbac,
  resourceScope,
  subjectFromArm,
  targetIsWellFormed,
  type AdoptTarget,
  type ProbeContext,
} from '../fitness-probe';
import { adoptionArmTypes } from '../adoption-catalog';
import type { DiscoveryTransport, HttpResult } from '../discovery-scanner';

const TARGET: AdoptTarget = {
  name: 'stloomexisting',
  rg: 'rg-existing',
  sub: '11111111-2222-3333-4444-555555555555',
};

const CTX: ProbeContext = {
  hubRegion: 'eastus2',
  hubTenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  consolePrincipalId: '99999999-8888-7777-6666-555555555555',
};

/**
 * A transport that replays canned ARM responses by URL substring. Every probe
 * test drives the REAL `probeAdoption` through the REAL `evaluateFitness`; only
 * the HTTP boundary is stubbed.
 */
function stubTransport(routes: { match: string; result: HttpResult }[]): DiscoveryTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async argQuery(): Promise<HttpResult> {
      throw new Error('argQuery is not used by the fitness probe');
    },
    async armGet(_token: string, url: string): Promise<HttpResult> {
      calls.push(url);
      const hit = routes.find((r) => url.includes(r.match));
      return hit ? hit.result : { status: 404, body: { error: { message: 'no stub route' } } };
    },
  };
}

const okPermissions: HttpResult = {
  status: 200,
  body: { value: [{ actions: ['*'], notActions: [] }] },
};
const noAssignments: HttpResult = { status: 200, body: { value: [] } };

describe('apiVersionFor — pinned, never guessed', () => {
  it('returns the pinned version for a known type and null for an unknown one', () => {
    expect(apiVersionFor('microsoft.storage/storageaccounts')).toBe('2023-05-01');
    expect(apiVersionFor('MICROSOFT.STORAGE/STORAGEACCOUNTS')).toBe('2023-05-01');
    expect(apiVersionFor('microsoft.notreal/things')).toBeNull();
    expect(apiVersionFor(undefined)).toBeNull();
  });

  /**
   * EMBEDDED CONTROL. This suite would pass vacuously if the catalog grew a
   * service the probe cannot read — every adoption of it would silently return
   * `unknown` and no test would notice. Every adoptable ARM type must carry a
   * pinned api-version.
   */
  it('every ARM type in the adoption catalog has a pinned api-version', () => {
    const types = adoptionArmTypes();
    expect(types.length).toBeGreaterThan(5); // the catalog is genuinely populated
    const missing = types.filter((t) => !ARM_API_VERSIONS[t.toLowerCase()]);
    expect(missing, `adoption-catalog ARM types with no pinned api-version: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('targetIsWellFormed / resourceScope', () => {
  it('rejects a target whose subscription is not a GUID', () => {
    expect(targetIsWellFormed(TARGET)).toBe(true);
    expect(targetIsWellFormed({ ...TARGET, sub: 'not-a-guid' })).toBe(false);
    expect(targetIsWellFormed({ ...TARGET, name: '' })).toBe(false);
    expect(targetIsWellFormed(null)).toBe(false);
  });

  it('builds the ARM scope without a host', () => {
    expect(resourceScope('microsoft.storage/storageaccounts', TARGET)).toBe(
      `/subscriptions/${TARGET.sub}/resourceGroups/rg-existing/providers/microsoft.storage/storageaccounts/stloomexisting`,
    );
  });
});

describe('networkPostureFromArm — unknown is a real answer', () => {
  it('maps each observable posture, and never assumes public', () => {
    expect(networkPostureFromArm({ publicNetworkAccess: 'Disabled' })).toBe('private-endpoint');
    expect(networkPostureFromArm({ publicNetworkAccess: 'Enabled' })).toBe('public');
    // fitness spells the day-2 'service-endpoint' state 'public-restricted'.
    expect(networkPostureFromArm({ networkAcls: { defaultAction: 'Deny' } })).toBe('public-restricted');
    expect(networkPostureFromArm({ networkRuleSet: { defaultAction: 'Deny' } })).toBe('public-restricted');
    expect(networkPostureFromArm({ privateEndpointConnections: [{ id: 'x' }] })).toBe('private-endpoint');
    // Neither field, no PE → NOT assumed public.
    expect(networkPostureFromArm({})).toBe('unknown');
    expect(networkPostureFromArm(null)).toBe('unknown');
  });

  it('publicNetworkAccess=Disabled outranks a Deny ACL', () => {
    expect(
      networkPostureFromArm({ publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Deny' } }),
    ).toBe('private-endpoint');
  });
});

describe('familyPropertiesFromArm — absent is not false', () => {
  it('carries a REAL false through for ADLS hierarchical namespace', () => {
    const p = familyPropertiesFromArm('storage-adls', { properties: { isHnsEnabled: false } });
    expect(p.isHnsEnabled).toBe(false);
    expect('isHnsEnabled' in p).toBe(true);
  });

  it('omits the key entirely when ARM did not return it', () => {
    const p = familyPropertiesFromArm('storage-adls', { properties: {} });
    expect('isHnsEnabled' in p).toBe(false);
  });

  it('reads each family property from its real ARM location', () => {
    expect(familyPropertiesFromArm('adx', { properties: { enableStreamingIngest: true } }).enableStreamingIngest).toBe(true);
    expect(familyPropertiesFromArm('eventhubs', { sku: { capacity: 4 } }).throughputUnits).toBe(4);
    expect(familyPropertiesFromArm('streamanalytics', { properties: { jobState: 'Running' } }).jobState).toBe('Running');
    expect(familyPropertiesFromArm('apim', { properties: { virtualNetworkType: 'Internal' } }).virtualNetworkType).toBe('Internal');
    expect(
      familyPropertiesFromArm('cosmos', { properties: { capabilities: [{ name: 'EnableServerless' }] } }).capabilities,
    ).toEqual(['EnableServerless']);
    // Synapse reports the managed VNet as a string, not a boolean.
    expect(familyPropertiesFromArm('synapse', { properties: { managedVirtualNetwork: 'default' } }).managedVnet).toBe(true);
  });
});

describe('subjectFromArm', () => {
  it('sets sku/location/kind ONLY when ARM returned them', () => {
    const full = subjectFromArm('storage-adls', TARGET, {
      location: 'eastus2',
      kind: 'StorageV2',
      sku: { name: 'Standard_LRS', tier: 'Standard' },
      properties: { isHnsEnabled: true, publicNetworkAccess: 'Enabled' },
    });
    expect(full.location).toBe('eastus2');
    expect(full.sku).toEqual({ name: 'Standard_LRS', tier: 'Standard' });
    expect(full.kind).toBe('StorageV2');
    expect(full.networkPosture).toBe('public');

    const bare = subjectFromArm('storage-adls', TARGET, {});
    expect(bare.location).toBeUndefined();
    expect(bare.sku).toBeUndefined();
    expect(bare.kind).toBeUndefined();
    expect(bare.networkPosture).toBe('unknown');
  });

  it('takes the tenant id from the resource identity block when present', () => {
    const s = subjectFromArm('purview', TARGET, { identity: { tenantId: CTX.hubTenantId } });
    expect(s.tenantId).toBe(CTX.hubTenantId);
    expect(subjectFromArm('purview', TARGET, {}).tenantId).toBeUndefined();
  });
});

describe('foundryDeploymentProps', () => {
  it('classifies a chat and an embedding deployment from the model names', () => {
    const p = foundryDeploymentProps([
      { properties: { model: { name: 'gpt-4o' } } },
      { properties: { model: { name: 'text-embedding-3-large' } } },
    ]);
    expect(p.chatDeployment).toBe('gpt-4o');
    expect(p.embedDeployment).toBe('text-embedding-3-large');
  });

  it('an EMPTY deployment list is a real answer, not an absent one', () => {
    const p = foundryDeploymentProps([]);
    expect(p.chatDeployment).toBe('');
    expect(p.embedDeployment).toBe('');
  });
});

describe('probeRbac — an unreadable authorization surface is unknown, never a deny', () => {
  it('reports holdsRole true when an assignment carries the role guid', async () => {
    const t = stubTransport([
      {
        match: '/roleAssignments',
        result: {
          status: 200,
          body: {
            value: [
              {
                properties: {
                  roleDefinitionId:
                    '/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe',
                },
              },
            ],
          },
        },
      },
    ]);
    const { rbac } = await probeRbac(t, 'tok', '/scope', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe', CTX.consolePrincipalId);
    expect(rbac?.holdsRole).toBe(true);
  });

  it('a 403 on the roleAssignments read yields unknown, NOT false', async () => {
    const t = stubTransport([
      { match: '/roleAssignments', result: { status: 403, body: { error: { message: 'denied' } } } },
      { match: '/permissions', result: { status: 403, body: { error: { message: 'denied' } } } },
    ]);
    const { rbac, detail } = await probeRbac(t, 'tok', '/scope', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe', CTX.consolePrincipalId);
    expect(rbac?.holdsRole).toBe('unknown');
    expect(rbac?.canGrant).toBe('unknown');
    expect(detail).toContain('did not return a readable result');
  });

  it('says so honestly when the Console principal id is not known to this Console', async () => {
    const t = stubTransport([{ match: '/permissions', result: okPermissions }]);
    const { rbac, detail } = await probeRbac(t, 'tok', '/scope', 'some-role-guid', undefined);
    expect(rbac?.holdsRole).toBe('unknown');
    expect(detail).toContain('LOOM_CONSOLE_PRINCIPAL_ID');
  });
});

describe('probeAdoption — the verdict MOVES with what ARM returned', () => {
  const adlsBody = (over: Record<string, any>) => ({
    status: 200,
    body: {
      location: 'eastus2',
      kind: 'StorageV2',
      sku: { name: 'Standard_LRS', tier: 'Standard' },
      properties: { publicNetworkAccess: 'Enabled', ...over },
    },
  });

  it('ADLS WITH hierarchical namespace is usable', async () => {
    const t = stubTransport([
      { match: '/roleAssignments', result: noAssignments },
      { match: '/permissions', result: okPermissions },
      { match: 'storageaccounts/stloomexisting?', result: adlsBody({ isHnsEnabled: true }) },
    ]);
    const r = await probeAdoption('storage-adls', TARGET, CTX, 'tok', t);
    expect(r.fitness.verdict).not.toBe('unusable');
    expect(r.fitness.checks.find((c) => c.id === 'adls.hns')?.verdict).toBe('pass');
  });

  /**
   * THE CONTROL that makes this suite non-vacuous: the SAME probe, the SAME
   * stub, one field flipped — and the verdict must change. If `isHnsEnabled`
   * stopped being read, this goes red while the test above stays green.
   */
  it('ADLS WITHOUT hierarchical namespace is unusable — the one field flips the verdict', async () => {
    const t = stubTransport([
      { match: '/roleAssignments', result: noAssignments },
      { match: '/permissions', result: okPermissions },
      { match: 'storageaccounts/stloomexisting?', result: adlsBody({ isHnsEnabled: false }) },
    ]);
    const r = await probeAdoption('storage-adls', TARGET, CTX, 'tok', t);
    expect(r.fitness.verdict).toBe('unusable');
    expect(r.fitness.checks.find((c) => c.id === 'adls.hns')?.verdict).toBe('fail');
  });

  it('a 403 on the resource read is UNKNOWN, never unusable, and records what was observed', async () => {
    const t = stubTransport([
      {
        match: 'storageaccounts/stloomexisting?',
        result: { status: 403, body: { error: { message: 'AuthorizationFailed' } } },
      },
    ]);
    const r = await probeAdoption('storage-adls', TARGET, CTX, 'tok', t);
    expect(r.fitness.verdict).toBe('unknown');
    expect(r.established).toContain('403');
    expect(r.established).toContain('AuthorizationFailed');
    // It must NOT have gone on to claim anything about RBAC it never read.
    expect(t.calls.some((u) => u.includes('/roleAssignments'))).toBe(false);
  });

  it('a cross-region adopted resource is reported against the REAL hub region', async () => {
    const t = stubTransport([
      { match: '/roleAssignments', result: noAssignments },
      { match: '/permissions', result: okPermissions },
      {
        match: 'storageaccounts/stloomexisting?',
        result: {
          status: 200,
          body: {
            location: 'westeurope',
            sku: { name: 'Standard_LRS', tier: 'Standard' },
            properties: { isHnsEnabled: true, publicNetworkAccess: 'Enabled' },
          },
        },
      },
    ]);
    const r = await probeAdoption('storage-adls', TARGET, CTX, 'tok', t);
    const region = r.fitness.checks.find((c) => c.id === 'storage-adls.region');
    expect(region?.established).toContain('westeurope');
    expect(region?.established).toContain('eastus2');
  });

  it('an unknown service key is reported as such without any ARM read', async () => {
    const t = stubTransport([]);
    const r = await probeAdoption('not-a-service', TARGET, CTX, 'tok', t);
    expect(r.fitness.verdict).toBe('unknown');
    expect(t.calls).toEqual([]);
    expect(r.established).toContain('not in the adoption catalog');
  });

  it('a malformed target is refused before any ARM call', async () => {
    const t = stubTransport([]);
    const r = await probeAdoption('storage-adls', { name: 'n', rg: 'r', sub: 'nope' }, CTX, 'tok', t);
    expect(t.calls).toEqual([]);
    expect(r.established).toContain('well-formed');
  });

  it('foundry reads the deployments sub-resource — the az command the docs asked the user to run', async () => {
    const t = stubTransport([
      { match: '/roleAssignments', result: noAssignments },
      { match: '/permissions', result: okPermissions },
      {
        match: '/deployments?',
        result: { status: 200, body: { value: [{ properties: { model: { name: 'gpt-4o' } } }] } },
      },
      {
        match: 'accounts/stloomexisting?',
        result: {
          status: 200,
          body: { location: 'eastus2', kind: 'AIServices', sku: { name: 'S0' }, properties: { publicNetworkAccess: 'Enabled' } },
        },
      },
    ]);
    const r = await probeAdoption('foundry', TARGET, CTX, 'tok', t);
    expect(t.calls.some((u) => u.includes('/deployments?'))).toBe(true);
    expect(r.fitness.checks.find((c) => c.id === 'foundry.kind')?.verdict).toBe('pass');
    expect(r.established).toContain('deployments: 1 returned');
  });
});
