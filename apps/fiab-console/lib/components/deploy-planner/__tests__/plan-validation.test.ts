/**
 * Deploy-plan graph validation + bicep-sync guard — pure logic, default node
 * vitest env. Confirms edges prune to live nodes and that every per-resource
 * config field maps to a real main.bicep param (no drift = no vaporware).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  serviceNodeIds, parseServiceNodeId, pruneEdges, validatePlan,
} from '../plan-validation';
import { SERVICE_CATALOG, configStatus } from '../service-catalog';
import type { PlanSubscription } from '../types';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → deploy-planner → components → lib → fiab-console → apps → repo root
const repoRoot = resolve(here, '../../../../../..');
const mainBicep = readFileSync(resolve(repoRoot, 'platform/fiab/bicep/main.bicep'), 'utf8');

const plan = (): PlanSubscription[] => ([
  {
    id: 'sub-1', name: 'A', boundary: 'Commercial',
    domains: [
      { domainId: 'd0', name: 'D0', services: ['redis', 'appService'] },
      { domainId: 'd1', name: 'D1', services: ['postgres'] },
    ],
  },
]);

describe('node-id helpers', () => {
  it('builds + parses service node ids', () => {
    const ids = serviceNodeIds(plan());
    expect(ids.has('svc:0:0:redis')).toBe(true);
    expect(ids.has('svc:0:1:postgres')).toBe(true);
    const p = parseServiceNodeId('svc:0:1:postgres');
    expect(p).toEqual({ si: 0, di: 1, key: 'postgres' });
    expect(parseServiceNodeId('dom:0:1')).toBeNull();
  });
});

describe('pruneEdges', () => {
  it('keeps live, distinct, de-duplicated edges and drops the rest', () => {
    const subs = plan();
    const edges = [
      { from: 'svc:0:0:redis', to: 'svc:0:1:postgres' }, // valid
      { from: 'svc:0:0:redis', to: 'svc:0:1:postgres' }, // dup
      { from: 'svc:0:0:redis', to: 'svc:0:0:redis' },    // self
      { from: 'svc:0:0:redis', to: 'svc:9:9:ghost' },    // dangling target
      { from: 'svc:0:0:appService', to: 'svc:0:0:redis' }, // valid
    ];
    const pruned = pruneEdges(subs, edges);
    expect(pruned).toHaveLength(2);
    expect(pruned).toContainEqual({ from: 'svc:0:0:redis', to: 'svc:0:1:postgres' });
    expect(pruned).toContainEqual({ from: 'svc:0:0:appService', to: 'svc:0:0:redis' });
  });

  it('handles missing / malformed input', () => {
    expect(pruneEdges(plan(), undefined)).toEqual([]);
    expect(pruneEdges(plan(), [{ from: 1 as any, to: 2 as any }])).toEqual([]);
  });
});

describe('validatePlan', () => {
  it('flags a dangling edge as an error', () => {
    const subs = plan();
    subs[0].edges = [{ from: 'svc:0:0:redis', to: 'svc:0:0:ghost' }];
    const issues = validatePlan(subs);
    expect(issues.some((i) => i.level === 'error')).toBe(true);
  });

  it('warns on plan-only services and empty subscriptions', () => {
    const subs: PlanSubscription[] = [
      { id: 's', name: 'Gov', boundary: 'GCC-High', domains: [{ domainId: 'd', name: 'D', services: ['fabricCapacity'] }] },
      { id: 's2', name: 'Empty', boundary: 'Commercial', domains: [] },
    ];
    const issues = validatePlan(subs);
    expect(issues.some((i) => i.level === 'warning' && /plan-only/i.test(i.message))).toBe(true);
    expect(issues.some((i) => i.level === 'warning' && /no domains/i.test(i.message))).toBe(true);
  });

  it('is clean for a well-formed plan with valid edges', () => {
    const subs = plan();
    subs[0].edges = [{ from: 'svc:0:0:appService', to: 'svc:0:0:redis' }];
    const issues = validatePlan(subs);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });
});

describe('configStatus + validate config-review gate', () => {
  it('reports none/default/configured/invalid honestly', () => {
    // core service with no schema
    expect(configStatus('storage', undefined)).toBe('none');
    // toggleable with a schema, nothing set → using defaults
    expect(configStatus('redis', undefined)).toBe('default');
    expect(configStatus('redis', {})).toBe('default');
    // a valid stored value → configured
    expect(configStatus('redis', { skuName: 'Premium' })).toBe('configured');
    // an out-of-@allowed value → invalid
    expect(configStatus('redis', { skuName: 'bogus' })).toBe('invalid');
  });

  it('warns when a configurable service still uses defaults, errors when invalid', () => {
    const subs: PlanSubscription[] = [{
      id: 's', name: 'A', boundary: 'Commercial',
      domains: [{ domainId: 'd', name: 'D', services: ['redis', 'vm'] }],
      serviceConfigs: { vm: { vmSize: 'Standard_NOPE' } },
    }];
    const issues = validatePlan(subs);
    // redis: unset → "using default" warning
    expect(issues.some((i) => i.level === 'warning' && /default SKU\/tier/i.test(i.message))).toBe(true);
    // vm: invalid stored size → error
    expect(issues.some((i) => i.level === 'error' && /invalid configuration/i.test(i.message))).toBe(true);
  });

  it('does not warn once a configurable service carries a valid value', () => {
    const subs: PlanSubscription[] = [{
      id: 's', name: 'A', boundary: 'Commercial',
      domains: [{ domainId: 'd', name: 'D', services: ['redis'] }],
      serviceConfigs: { redis: { skuName: 'Standard' } },
    }];
    const issues = validatePlan(subs);
    expect(issues.some((i) => /default SKU\/tier/i.test(i.message))).toBe(false);
  });
});

describe('bicep-sync — every config field maps to a real main.bicep param', () => {
  it('declares each configured bicepParam in main.bicep', () => {
    const configured = SERVICE_CATALOG.flatMap((s) => s.config || []);
    expect(configured.length).toBeGreaterThanOrEqual(9);
    for (const field of configured) {
      const re = new RegExp(`param\\s+${field.bicepParam}\\b`);
      expect(re.test(mainBicep), `main.bicep is missing 'param ${field.bicepParam}'`).toBe(true);
    }
  });

  it('forwards the config params into the deploy-planner modules', () => {
    // The module receiving each param must reference it (sku/version/runtime).
    expect(mainBicep).toMatch(/skuName:\s*redisSkuName/);
    expect(mainBicep).toMatch(/planSku:\s*appServicePlanSku/);
    expect(mainBicep).toMatch(/linuxFxVersion:\s*appServiceLinuxFxVersion/);
    expect(mainBicep).toMatch(/functionsWorkerRuntime:\s*functionsWorkerRuntime/);
    expect(mainBicep).toMatch(/postgresVersion:\s*postgresVersion/);
    expect(mainBicep).toMatch(/storageSizeGB:\s*postgresStorageSizeGB/);
    expect(mainBicep).toMatch(/mysqlVersion:\s*mysqlVersion/);
    expect(mainBicep).toMatch(/storageSizeGB:\s*mysqlStorageSizeGB/);
  });
});
