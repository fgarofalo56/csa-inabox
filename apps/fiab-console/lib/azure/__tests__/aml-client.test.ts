/**
 * Contract tests for the AML control-plane client (resolve-aml-target +
 * aml-client). Per .claude/rules/no-vaporware.md these assert the EXACT ARM
 * REST the client shapes — the
 * Microsoft.MachineLearningServices/workspaces/<ws>/computes GET URL
 * (sovereign-cloud aware), the AAD bearer header, the api-version, and the
 * sibling list surfaces (schedules / environments). They also assert the
 * resolver's env fallback chain and that the Government ARM host is selected
 * when AZURE_CLOUD=AzureUSGovernment.
 *
 * Nothing is faked beyond stubbing fetch + the AAD credential.
 *
 * Grounding: https://learn.microsoft.com/rest/api/azureml/compute/list (2024-10-01)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ARM.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  listComputes,
  listSchedules,
  listEnvironments,
  amlConfigGate,
} from '../aml-client';
import {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  AmlNotConfiguredError,
} from '../resolve-aml-target';

const realFetch = global.fetch;
interface Call { url: string; init?: any }

function mockFetch(handler: (url: string) => any, calls?: Call[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const out = handler(String(url));
    if (out instanceof Response) return out;
    const status = out?._status ?? 200;
    return new Response(JSON.stringify(out?._body ?? out), { status });
  }) as any;
}

const AML_ENV = [
  'LOOM_AML_SUBSCRIPTION',
  'LOOM_SUBSCRIPTION_ID',
  'LOOM_AML_WORKSPACE',
  'LOOM_FOUNDRY_NAME',
  'LOOM_AML_RESOURCE_GROUP',
  'LOOM_AML_RG',
  'LOOM_FOUNDRY_RG',
  'LOOM_AML_REGION',
  'LOOM_FOUNDRY_REGION',
  'AZURE_CLOUD',
  'LOOM_ARM_ENDPOINT',
];

function clearAmlEnv() {
  for (const k of AML_ENV) delete process.env[k];
}

beforeEach(() => {
  clearAmlEnv();
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_AML_WORKSPACE = 'ws-test';
  process.env.LOOM_AML_RESOURCE_GROUP = 'rg-aml';
  process.env.LOOM_AML_REGION = 'eastus2';
});
afterEach(() => {
  global.fetch = realFetch;
  clearAmlEnv();
  vi.restoreAllMocks();
});

describe('amlConfigGate', () => {
  it('returns null when LOOM_AML_WORKSPACE + a subscription resolve', () => {
    expect(amlConfigGate()).toBeNull();
  });
  it('names the missing workspace var', () => {
    delete process.env.LOOM_AML_WORKSPACE;
    expect(amlConfigGate()).toEqual({ missing: 'LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)' });
  });
  it('names the missing subscription var', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    expect(amlConfigGate()).toEqual({ missing: 'LOOM_AML_SUBSCRIPTION (or LOOM_SUBSCRIPTION_ID)' });
  });
});

describe('resolveAmlTarget fallback chain', () => {
  it('LOOM_AML_WORKSPACE overrides LOOM_FOUNDRY_NAME', () => {
    process.env.LOOM_FOUNDRY_NAME = 'foundry-hub';
    expect(resolveAmlTarget().workspace).toBe('ws-test');
    delete process.env.LOOM_AML_WORKSPACE;
    expect(resolveAmlTarget().workspace).toBe('foundry-hub');
  });
  it('LOOM_AML_SUBSCRIPTION overrides LOOM_SUBSCRIPTION_ID', () => {
    process.env.LOOM_AML_SUBSCRIPTION = 'sub-aml';
    expect(resolveAmlTarget().subscriptionId).toBe('sub-aml');
  });
  it('LOOM_AML_RESOURCE_GROUP overrides LOOM_AML_RG and LOOM_FOUNDRY_RG', () => {
    process.env.LOOM_AML_RG = 'rg-legacy';
    process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
    expect(resolveAmlTarget().resourceGroup).toBe('rg-aml');
    delete process.env.LOOM_AML_RESOURCE_GROUP;
    expect(resolveAmlTarget().resourceGroup).toBe('rg-legacy');
  });
  it('falls back to rg-csa-loom-admin-<region> when no RG var is set', () => {
    delete process.env.LOOM_AML_RESOURCE_GROUP;
    expect(resolveAmlTarget().resourceGroup).toBe('rg-csa-loom-admin-eastus2');
  });
  it('throws AmlNotConfiguredError listing missing vars when unconfigured', () => {
    delete process.env.LOOM_AML_WORKSPACE;
    delete process.env.LOOM_SUBSCRIPTION_ID;
    let caught: unknown;
    try { resolveAmlTarget(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AmlNotConfiguredError);
    expect((caught as AmlNotConfiguredError).missing).toEqual([
      'LOOM_AML_SUBSCRIPTION (or LOOM_SUBSCRIPTION_ID)',
      'LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)',
    ]);
  });
  it('builds the canonical workspace ARM path', () => {
    expect(amlWorkspaceArmPath()).toBe(
      '/subscriptions/sub-1/resourceGroups/rg-aml/providers/Microsoft.MachineLearningServices/workspaces/ws-test',
    );
  });
});

describe('listComputes — Commercial endpoint', () => {
  it('GETs the computes child resource with an AAD bearer and api-version 2024-10-01', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({
      value: [
        { id: '/sub/.../computes/ci-1', name: 'ci-1', location: 'eastus2', properties: { computeType: 'ComputeInstance', provisioningState: 'Succeeded', properties: { state: 'Running', vmSize: 'STANDARD_DS3_V2' } } },
      ],
    }), calls);

    const rows = await listComputes();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(
      'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-aml/providers/Microsoft.MachineLearningServices/workspaces/ws-test/computes?api-version=2024-10-01',
    );
    expect(init.headers['authorization']).toBe('Bearer AAD.ARM.TOKEN');
    expect(rows[0]).toMatchObject({ name: 'ci-1', computeType: 'ComputeInstance', state: 'Running', vmSize: 'STANDARD_DS3_V2' });
  });
});

describe('listComputes — Government endpoint selection', () => {
  it('targets the Government ARM host when AZURE_CLOUD is AzureUSGovernment', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const calls: Call[] = [];
    mockFetch(() => ({ value: [] }), calls);

    await listComputes();

    expect(calls[0].url).toContain('https://management.usgovcloudapi.net/');
    expect(calls[0].url).not.toContain('management.azure.com');
  });
});

describe('sibling list surfaces', () => {
  it('listSchedules GETs the schedules child resource', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ value: [{ id: 's1', name: 'nightly', properties: { isEnabled: true, provisioningState: 'Succeeded', trigger: { triggerType: 'Recurrence' } } }] }), calls);
    const rows = await listSchedules();
    expect(calls[0].url).toContain('/workspaces/ws-test/schedules?api-version=2024-10-01');
    expect(rows[0]).toMatchObject({ name: 'nightly', isEnabled: true, triggerType: 'Recurrence' });
  });

  it('listEnvironments GETs the environments child resource', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ value: [{ id: 'e1', name: 'sklearn-env', properties: { latestVersion: '3' } }] }), calls);
    const rows = await listEnvironments();
    expect(calls[0].url).toContain('/workspaces/ws-test/environments?api-version=2024-10-01');
    expect(rows[0]).toMatchObject({ name: 'sklearn-env', latestVersion: '3' });
  });
});
