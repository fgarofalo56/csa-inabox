/**
 * Pure-helper unit tests for the VNet data gateway honest-gate evaluator.
 *
 * `evaluateVnetGatewayReadiness` is a pure function (no ARM / identity) — it
 * turns the detected Azure signals (Microsoft.PowerPlatform RP registration +
 * subnet delegations) into the honest prerequisite checklist. Per
 * no-vaporware.md these tests don't pretend to cover the ARM read path
 * (validated live); they pin the deterministic mapping + the no-faked-
 * capability guarantees (tenant rows stay tenant, never auto-"met").
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateVnetGatewayReadiness, VNET_GATEWAY_DELEGATION,
  type VNetInfo,
} from '@/lib/azure/network-discovery';

const vnet = (subnets: { name: string; delegations: string[] }[]): VNetInfo => ({
  id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/hub',
  name: 'hub', subscriptionId: 's', resourceGroup: 'rg', addressPrefixes: ['10.0.0.0/16'],
  subnets: subnets.map((sn) => ({ name: sn.name, addressPrefix: '10.0.1.0/24', privateEndpointCount: 0, delegations: sn.delegations })),
});

describe('evaluateVnetGatewayReadiness — RP registration', () => {
  it('marks the RP prereq met when registered', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', []);
    expect(r.rpRegistered).toBe(true);
    expect(r.prereqs.find((p) => p.id === 'rp')!.status).toBe('met');
  });
  it('marks the RP prereq unmet when not registered', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'NotRegistered', []);
    expect(r.rpRegistered).toBe(false);
    expect(r.prereqs.find((p) => p.id === 'rp')!.status).toBe('unmet');
  });
  it('treats an unreadable RP (null) as unmet with a register hint, not faked', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', null, []);
    const rp = r.prereqs.find((p) => p.id === 'rp')!;
    expect(rp.status).toBe('unmet');
    expect(rp.detail).toMatch(/az provider register/i);
  });
});

describe('evaluateVnetGatewayReadiness — subnet delegation', () => {
  it('detects a delegated subnet (case-insensitive) and lists it', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', [
      vnet([{ name: 'snet-pp', delegations: [VNET_GATEWAY_DELEGATION.toLowerCase()] }]),
    ]);
    expect(r.delegatedSubnets).toHaveLength(1);
    expect(r.delegatedSubnets[0].subnet).toBe('snet-pp');
    expect(r.prereqs.find((p) => p.id === 'subnet')!.status).toBe('met');
  });
  it('never counts the reserved GatewaySubnet as a valid delegation', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', [
      vnet([{ name: 'GatewaySubnet', delegations: [VNET_GATEWAY_DELEGATION] }]),
    ]);
    expect(r.delegatedSubnets).toHaveLength(0);
    expect(r.prereqs.find((p) => p.id === 'subnet')!.status).toBe('unmet');
  });
  it('reports unmet when no subnet is delegated', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', [
      vnet([{ name: 'snet-private-endpoints', delegations: [] }]),
    ]);
    expect(r.prereqs.find((p) => p.id === 'subnet')!.status).toBe('unmet');
  });
});

describe('evaluateVnetGatewayReadiness — no faked capability (tenant rows)', () => {
  it('keeps capacity/installers/create as tenant actions Loom cannot verify', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', [
      vnet([{ name: 'snet-pp', delegations: [VNET_GATEWAY_DELEGATION] }]),
    ]);
    for (const id of ['capacity', 'installers', 'create']) {
      const p = r.prereqs.find((x) => x.id === id)!;
      expect(p.status).toBe('tenant');
      expect(p.azureDetectable).toBe(false);
    }
    // Even with every Azure prereq met, no row claims the gateway is "met".
    expect(r.prereqs.every((p) => p.status !== 'met' || p.azureDetectable)).toBe(true);
  });
  it('always points at the Azure-native private-endpoint default', () => {
    const r = evaluateVnetGatewayReadiness('Commercial', 'Registered', []);
    expect(r.azureNativeDefault).toMatch(/private-endpoint/i);
    expect(r.azureNativeDefault).toMatch(/does not create/i);
  });
});

describe('evaluateVnetGatewayReadiness — sovereign clouds', () => {
  it('marks the capability unavailable in GCC-High (no Power Platform VNet endpoint)', () => {
    const r = evaluateVnetGatewayReadiness('GCC-High', null, []);
    expect(r.capabilityAvailable).toBe(false);
    expect(r.prereqs).toHaveLength(1);
    expect(r.prereqs[0].status).toBe('unavailable');
    expect(r.azureNativeDefault).toMatch(/private-endpoint/i);
  });
  it('marks the capability unavailable in DoD', () => {
    expect(evaluateVnetGatewayReadiness('DoD', null, []).capabilityAvailable).toBe(false);
  });
  it('keeps the capability available in Commercial and GCC', () => {
    expect(evaluateVnetGatewayReadiness('Commercial', null, []).capabilityAvailable).toBe(true);
    expect(evaluateVnetGatewayReadiness('GCC', null, []).capabilityAvailable).toBe(true);
  });
});
