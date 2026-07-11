/**
 * Unit tests for the Weave → Power BI (real Power BI Service, W5) gate helpers
 * (lib/thread/pbi-service-gate.ts).
 *
 * PURE: env / workspace / gateway state are supplied directly — no live Power
 * BI, no Azure. These cover the branch decision (destination routing) + every
 * honest-gate condition the analyze-in-powerbi route delegates here.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDestination,
  readPbiServiceConfig,
  pbiServiceConfigGate,
  sourceNeedsGateway,
  gatewayGate,
  pickActiveGatewayId,
  powerBiItemLink,
  type GatewayState,
  type PbiServiceConfig,
} from '../pbi-service-gate';

const gw = (over: Partial<GatewayState> = {}): GatewayState => ({
  vmFound: true,
  vmRunning: true,
  recommendedMode: 'vm',
  capacityBound: false,
  registrationNote: 'REGISTER-NOTE',
  registeredGatewayIds: [],
  ...over,
});

describe('resolveDestination', () => {
  it('defaults to loom-native for missing / unknown / empty values', () => {
    expect(resolveDestination(undefined)).toBe('loom-native');
    expect(resolveDestination('')).toBe('loom-native');
    expect(resolveDestination('nonsense')).toBe('loom-native');
    expect(resolveDestination('loom-native')).toBe('loom-native');
  });
  it('resolves the opt-in real Power BI destination only on the exact value', () => {
    expect(resolveDestination('power-bi-service')).toBe('power-bi-service');
    expect(resolveDestination(' power-bi-service ')).toBe('power-bi-service');
    expect(resolveDestination('power-bi')).toBe('loom-native');
  });
});

describe('readPbiServiceConfig', () => {
  it('reads + trims workspace and capacity from the supplied env', () => {
    const cfg = readPbiServiceConfig({ LOOM_PBI_WORKSPACE_ID: ' ws-1 ', LOOM_PBI_CAPACITY_ID: 'cap-1' });
    expect(cfg).toEqual({ workspaceId: 'ws-1', capacityId: 'cap-1' });
  });
  it('defaults to empty strings when unset', () => {
    expect(readPbiServiceConfig({})).toEqual({ workspaceId: '', capacityId: '' });
  });
});

describe('pbiServiceConfigGate', () => {
  it('passes (null) when both workspace and capacity are bound', () => {
    const cfg: PbiServiceConfig = { workspaceId: 'ws-1', capacityId: 'cap-1' };
    expect(pbiServiceConfigGate(cfg)).toBeNull();
  });
  it('gates naming LOOM_PBI_WORKSPACE_ID when the workspace is missing', () => {
    const g = pbiServiceConfigGate({ workspaceId: '', capacityId: 'cap-1' });
    expect(g).toMatch(/LOOM_PBI_WORKSPACE_ID/);
    expect(g).not.toMatch(/LOOM_PBI_CAPACITY_ID/);
    expect(g).toMatch(/Loom-native/); // points at the zero-dependency fallback
  });
  it('gates naming LOOM_PBI_CAPACITY_ID when the capacity is missing', () => {
    const g = pbiServiceConfigGate({ workspaceId: 'ws-1', capacityId: '' });
    expect(g).toMatch(/LOOM_PBI_CAPACITY_ID/);
    expect(g).not.toMatch(/LOOM_PBI_WORKSPACE_ID/);
  });
  it('names BOTH env vars when neither is set', () => {
    const g = pbiServiceConfigGate({ workspaceId: '', capacityId: '' });
    expect(g).toMatch(/LOOM_PBI_WORKSPACE_ID/);
    expect(g).toMatch(/LOOM_PBI_CAPACITY_ID/);
  });
});

describe('sourceNeedsGateway', () => {
  it('requires a gateway only for private-endpoint-only sources', () => {
    expect(sourceNeedsGateway({ behindPrivateEndpoint: true })).toBe(true);
    expect(sourceNeedsGateway({ behindPrivateEndpoint: false })).toBe(false);
  });
});

describe('gatewayGate', () => {
  it('passes (null) when no gateway is needed (public source e.g. ADX)', () => {
    expect(gatewayGate(false, gw({ registeredGatewayIds: [] }))).toBeNull();
  });
  it('passes (null) when a gateway is registered', () => {
    expect(gatewayGate(true, gw({ registeredGatewayIds: ['g-1'] }))).toBeNull();
  });
  it('gates with the registration note when a PE source has no registered gateway', () => {
    const g = gatewayGate(true, gw({ registeredGatewayIds: [], registrationNote: 'DO-THE-REGISTER-STEP' }));
    expect(g).toMatch(/private endpoint/i);
    expect(g).toMatch(/DO-THE-REGISTER-STEP/);
  });
  it('tells the operator to deploy the VM when none is found', () => {
    const g = gatewayGate(true, gw({ vmFound: false, vmRunning: false, registeredGatewayIds: [] }));
    expect(g).toMatch(/pbi-vm-data-gateway\.bicep/);
  });
  it('tells the operator to start the VM when it is deployed but stopped', () => {
    const g = gatewayGate(true, gw({ vmFound: true, vmRunning: false, registeredGatewayIds: [] }));
    expect(g).toMatch(/not running/i);
  });
  it('surfaces the managed VNet auto-upgrade note when a capacity is bound', () => {
    const g = gatewayGate(true, gw({ recommendedMode: 'vnet', capacityBound: true, registeredGatewayIds: [] }));
    expect(g).toMatch(/managed VNet data gateway/i);
    expect(g).toMatch(/LOOM_PBI_GATEWAY_MODE=auto/);
  });
});

describe('pickActiveGatewayId', () => {
  it('picks the first registered gateway id', () => {
    expect(pickActiveGatewayId(gw({ registeredGatewayIds: ['g-1', 'g-2'] }))).toBe('g-1');
  });
  it('returns undefined when none are registered', () => {
    expect(pickActiveGatewayId(gw({ registeredGatewayIds: [] }))).toBeUndefined();
  });
});

describe('powerBiItemLink', () => {
  const host = 'https://app.powerbi.com';
  it('builds the dataset details deep link', () => {
    expect(powerBiItemLink(host, 'ws-1', 'dataset', 'd-1')).toBe(
      'https://app.powerbi.com/groups/ws-1/datasets/d-1/details',
    );
  });
  it('builds the report deep link', () => {
    expect(powerBiItemLink(host, 'ws-1', 'report', 'r-1')).toBe(
      'https://app.powerbi.com/groups/ws-1/reports/r-1',
    );
  });
  it('builds the dashboard deep link', () => {
    expect(powerBiItemLink(host, 'ws-1', 'dashboard', 'db-1')).toBe(
      'https://app.powerbi.com/groups/ws-1/dashboards/db-1',
    );
  });
  it('is sovereign-host aware and strips a trailing slash', () => {
    expect(powerBiItemLink('https://app.powerbigov.us/', 'ws-1', 'report', 'r-1')).toBe(
      'https://app.powerbigov.us/groups/ws-1/reports/r-1',
    );
  });
  it('url-encodes ids with special characters', () => {
    expect(powerBiItemLink(host, 'ws 1', 'dataset', 'd/1')).toBe(
      'https://app.powerbi.com/groups/ws%201/datasets/d%2F1/details',
    );
  });
});
