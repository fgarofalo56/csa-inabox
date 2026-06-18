/**
 * Standalone .bicep template emitter — pure logic (no render), so it runs in the
 * default node vitest env. Confirms the planned graph maps to REAL deploy-planner
 * modules (no fake modules), threads per-resource config, and turns the canvas
 * edges into module dependsOn. The structural assertions guard against drift in
 * the module map (every module file referenced must exist on disk).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { planToBicep, DP_MODULES, MODULE_BACKED_KEYS } from '../planToBicep';
import { serviceByKey } from '../service-catalog';
import type { PlanSubscription } from '../types';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = resolve(here, '../../../../../../platform/fiab/bicep/modules/deploy-planner');

describe('planToBicep — module map integrity (no drift)', () => {
  it('every mapped module file exists on disk', () => {
    for (const [key, spec] of Object.entries(DP_MODULES)) {
      const p = resolve(moduleDir, spec.file);
      expect(existsSync(p), `${key} → ${spec.file} must exist`).toBe(true);
    }
  });

  it('every module-backed key is a real, toggleable (non-plan-only) catalog service', () => {
    for (const key of MODULE_BACKED_KEYS) {
      const def = serviceByKey(key);
      expect(def, `${key} must be a catalog service`).toBeTruthy();
      // module-backed services deploy via a one-button toggle, never plan-only
      expect(def!.planOnly, `${key} is module-backed so must not be plan-only`).toBeFalsy();
      expect(def!.bicepFlag, `${key} must have a bicep flag`).toBeTruthy();
    }
  });
});

describe('planToBicep — emission', () => {
  const sub: PlanSubscription = {
    id: 'sub-1', name: 'Primary', boundary: 'Commercial',
    domains: [
      { domainId: 'core', name: 'Core', services: ['redis', 'serviceBus', 'firewall', 'streamAnalytics', 'aiSearch'] },
    ],
    serviceConfigs: {
      redis: { skuName: 'Premium' },
      serviceBus: { skuName: 'Premium' },
      firewall: { tier: 'Premium' },
      streamAnalytics: { streamingUnits: 6 },
    },
  };

  it('emits a subscription-scoped template with a resource group', () => {
    const out = planToBicep(sub);
    expect(out).toContain("targetScope = 'subscription'");
    expect(out).toContain("resource rg 'Microsoft.Resources/resourceGroups");
    expect(out).toContain("param location string = 'eastus2'"); // Commercial default
  });

  it('emits a real module + threaded config for each module-backed selected service', () => {
    const out = planToBicep(sub);
    expect(out).toContain("module svc_redis 'modules/deploy-planner/redis.bicep'");
    expect(out).toContain("skuName: 'Premium'");
    expect(out).toContain("module svc_firewall 'modules/deploy-planner/firewall.bicep'");
    expect(out).toContain("firewallTier: 'Premium'");
    expect(out).toContain("module svc_streamAnalytics 'modules/deploy-planner/stream-analytics.bicep'");
    expect(out).toContain('startingStreamingUnits: 6'); // int — bare, not quoted
  });

  it('does NOT emit a fake module for services without a self-contained module', () => {
    const out = planToBicep(sub);
    // aiSearch has a bicep flag but deploys via the DLZ orchestrator — never a module
    expect(out).not.toContain('aiSearch.bicep');
    // …it is honestly documented as orchestrated instead
    expect(out).toContain("DLZ orchestrator");
    expect(out).toContain('AI Search (param aiSearchEnabled)');
  });

  it('turns canvas edges into module dependsOn (both endpoints module-backed)', () => {
    const withEdge: PlanSubscription = {
      ...sub,
      domains: [{ domainId: 'core', name: 'Core', services: ['redis', 'serviceBus'] }],
      // arrow: redis depends on serviceBus
      edges: [{ from: 'svc:0:0:redis', to: 'svc:0:0:serviceBus' }],
    };
    const out = planToBicep(withEdge);
    expect(out).toContain('dependsOn: [');
    expect(out).toContain('svc_serviceBus');
  });

  it('drops edges that reference a non-module-backed service (no dangling dependsOn)', () => {
    const withEdge: PlanSubscription = {
      ...sub,
      domains: [{ domainId: 'core', name: 'Core', services: ['redis', 'aiSearch'] }],
      edges: [{ from: 'svc:0:0:redis', to: 'svc:0:0:aiSearch' }],
    };
    const out = planToBicep(withEdge);
    expect(out).not.toContain('dependsOn:');
  });

  it('honours an explicit region + gov boundary', () => {
    const out = planToBicep({ ...sub, boundary: 'GCC-High', region: undefined });
    expect(out).toContain("param location string = 'usgovvirginia'");
  });

  it('handles an empty plan honestly (no modules, no crash)', () => {
    const out = planToBicep({ id: 's', name: 'Empty', boundary: 'Commercial', domains: [] });
    expect(out).toContain('No module-backed services are selected');
  });

  it('threads the wave-3 additions config into their module params', () => {
    const wave3: PlanSubscription = {
      id: 's', name: 'W3', boundary: 'Commercial',
      domains: [{ domainId: 'd', name: 'D', services: ['vm', 'signalr', 'staticWebApps', 'cdn', 'containerInstances', 'mlWorkspace'] }],
      serviceConfigs: {
        vm: { vmSize: 'Standard_D4s_v5' },
        signalr: { skuName: 'Premium_P1', skuCapacity: 3 },
        staticWebApps: { skuName: 'Free' },
        cdn: { skuName: 'Premium_Verizon' },
        containerInstances: { cpuCores: 4, memoryInGB: 8 },
        mlWorkspace: { computeVmSize: 'Standard_E4s_v3' },
      },
    };
    const out = planToBicep(wave3);
    // module param names (NOT the top-level main.bicep param names)
    expect(out).toContain("vmSize: 'Standard_D4s_v5'");
    expect(out).toContain("skuName: 'Premium_P1'");
    expect(out).toContain('skuCapacity: 3');
    expect(out).toContain("skuName: 'Free'");          // static web app
    expect(out).toContain("skuName: 'Premium_Verizon'"); // cdn
    expect(out).toContain('cpuCores: 4');
    expect(out).toContain('memoryInGB: 8');
    expect(out).toContain("richDisplayComputeVmSize: 'Standard_E4s_v3'");
  });
});
