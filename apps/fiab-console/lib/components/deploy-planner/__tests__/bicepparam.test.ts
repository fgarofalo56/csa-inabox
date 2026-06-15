/**
 * Deploy-planner bicepparam generation — pure logic (no render), so it runs in
 * the default node vitest env. Confirms the visual plan maps to the real bicep
 * knobs (no drift = no vaporware).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  flagsForServices, serviceByKey, serviceVisual,
  SERVICE_CATALOG, SERVICE_COUNT, TOGGLEABLE_SERVICE_COUNT,
  configFor, coerceConfigValue, defaultConfig, resolveConfigValue,
  CONFIGURABLE_SERVICE_COUNT,
} from '../service-catalog';
import { iconUrl } from '../../ui/item-type-visual';
import { planToBicepparam } from '../bicepparam';
import type { PlanSubscription } from '../types';

describe('service-catalog flag mapping', () => {
  it('maps toggleable services to their bicep flags', () => {
    const flags = flagsForServices(['aiFoundry', 'apim', 'adx']);
    expect(flags).toEqual({ aiFoundryEnabled: true, apimEnabled: true, adxEnabled: true });
  });

  it('omits core (always-on) services from the flag set', () => {
    expect(serviceByKey('storage')?.bicepFlag).toBeNull();
    expect(flagsForServices(['storage', 'cosmos', 'keyvault'])).toEqual({});
  });

  it('ignores unknown service keys', () => {
    expect(flagsForServices(['nope', 'apim'])).toEqual({ apimEnabled: true });
  });
});

describe('planToBicepparam', () => {
  const sub: PlanSubscription = {
    id: 'sub-1', name: 'Gov Primary', boundary: 'GCC-High',
    domains: [
      { domainId: 'finance', name: 'Finance', services: ['aiFoundry', 'apim'] },
      { domainId: 'ops', name: 'Operations', services: ['adx', 'apim'] },
    ],
  };

  it('emits boundary, region default, and dlzDomainNames from the plan', () => {
    const out = planToBicepparam(sub);
    expect(out).toContain("param boundary = 'GCC-High'");
    expect(out).toContain("param location = 'usgovvirginia'");
    expect(out).toContain("param dlzDomainNames = ['finance', 'ops']");
  });

  it('unions selected services across domains into true flags, others false', () => {
    const out = planToBicepparam(sub);
    expect(out).toContain('param aiFoundryEnabled = true');
    expect(out).toContain('param apimEnabled = true');
    expect(out).toContain('param adxEnabled = true');
    expect(out).toContain('param aiSearchEnabled = false'); // not selected anywhere
    expect(out).toContain("using '../main.bicep'");
  });

  it('honours an explicit region override', () => {
    const out = planToBicepparam({ ...sub, region: 'usgovarizona' });
    expect(out).toContain("param location = 'usgovarizona'");
  });
});

describe('planToBicepparam — deploymentMode (topology)', () => {
  it('derives multi-sub from a >1-domain plan when mode is unset', () => {
    const out = planToBicepparam({
      id: 'sub-1', name: 'P', boundary: 'Commercial',
      domains: [
        { domainId: 'a', name: 'A', services: [] },
        { domainId: 'b', name: 'B', services: [] },
      ],
    });
    expect(out).toContain("param deploymentMode = 'multi-sub'");
    // honest TODO for the operator-supplied sub GUIDs (never a fake value)
    expect(out).toContain('param dlzSubscriptionIds');
  });

  it('derives single-sub from a one-domain plan when mode is unset', () => {
    const out = planToBicepparam({
      id: 'sub-1', name: 'P', boundary: 'Commercial',
      domains: [{ domainId: 'a', name: 'A', services: [] }],
    });
    expect(out).toContain("param deploymentMode = 'single-sub'");
    expect(out).not.toContain('dlzSubscriptionIds');
  });

  it('honours an explicit deploymentMode override', () => {
    const out = planToBicepparam({
      id: 'sub-1', name: 'P', boundary: 'Commercial',
      deploymentMode: 'multi-sub',
      domains: [{ domainId: 'a', name: 'A', services: [] }],
    });
    expect(out).toContain("param deploymentMode = 'multi-sub'");
  });
});

describe('catalog coverage + honesty', () => {
  it('covers a broad set of Azure service types across all six categories', () => {
    expect(SERVICE_COUNT).toBeGreaterThanOrEqual(40);
    const cats = new Set(SERVICE_CATALOG.map((s) => s.category));
    expect([...cats].sort()).toEqual(
      ['ai', 'compute', 'data', 'governance', 'integration', 'networking'],
    );
    expect(TOGGLEABLE_SERVICE_COUNT).toBeGreaterThan(0);
  });

  it('has unique keys and every entry resolves a glyph + color', () => {
    const keys = SERVICE_CATALOG.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SERVICE_CATALOG) {
      const v = serviceVisual(s.key);
      expect(v.glyph).toBeTruthy();
      expect(v.color).toMatch(/^#/);
    }
  });

  it('plan-only services never emit a bicep flag (no fake knobs)', () => {
    const planOnly = SERVICE_CATALOG.filter((s) => s.planOnly);
    expect(planOnly.length).toBeGreaterThan(0);
    for (const s of planOnly) expect(s.bicepFlag).toBeNull();
    // a subscription full of plan-only services produces zero true flags
    const flags = flagsForServices(planOnly.map((s) => s.key));
    expect(Object.keys(flags)).toHaveLength(0);
  });

  it('serviceVisual falls back gracefully for unknown keys', () => {
    const v = serviceVisual('does-not-exist');
    expect(v.glyph).toBeTruthy();
    expect(v.color).toMatch(/^#/);
  });
});

describe('per-resource config schema + coercion', () => {
  it('exposes config only on toggleable services (never core/plan-only)', () => {
    expect(CONFIGURABLE_SERVICE_COUNT).toBeGreaterThanOrEqual(5);
    for (const def of SERVICE_CATALOG) {
      if (def.config?.length) {
        expect(def.bicepFlag, `${def.key} has config so must be toggleable`).toBeTruthy();
        expect(def.planOnly).toBeFalsy();
        for (const f of def.config) {
          expect(f.bicepParam).toBeTruthy();
          if (f.type === 'select') expect(f.allowed && f.allowed.length).toBeTruthy();
        }
      }
    }
  });

  it('coerces / rejects values against the field constraints', () => {
    const redisSku = configFor('redis').find((f) => f.key === 'skuName')!;
    expect(coerceConfigValue(redisSku, 'Premium')).toBe('Premium');
    expect(coerceConfigValue(redisSku, 'Mega')).toBeUndefined(); // not in @allowed

    const myStore = configFor('mysql').find((f) => f.key === 'storageSizeGB')!;
    expect(coerceConfigValue(myStore, 64)).toBe(64);
    expect(coerceConfigValue(myStore, 5)).toBeUndefined();      // below min
    expect(coerceConfigValue(myStore, 999999)).toBeUndefined(); // above max
    expect(coerceConfigValue(myStore, 'NaN')).toBeUndefined();

    const fx = configFor('appService').find((f) => f.key === 'linuxFxVersion')!;
    expect(coerceConfigValue(fx, 'NODE|20-lts')).toBe('NODE|20-lts');
    expect(coerceConfigValue(fx, 'not a runtime')).toBeUndefined(); // fails pattern
  });

  it('defaultConfig + resolveConfigValue fall back to the module default', () => {
    const d = defaultConfig('redis');
    expect(d.skuName).toBe('Basic');
    const fld = configFor('redis').find((f) => f.key === 'skuName')!;
    expect(resolveConfigValue(fld, undefined)).toBe('Basic');
    expect(resolveConfigValue(fld, { skuName: 'Premium' })).toBe('Premium');
    expect(resolveConfigValue(fld, { skuName: 'bogus' })).toBe('Basic'); // invalid → default
  });
});

describe('planToBicepparam — per-resource config emission', () => {
  const sub: PlanSubscription = {
    id: 'sub-1', name: 'Primary', boundary: 'Commercial',
    domains: [
      { domainId: 'core', name: 'Core', services: ['redis', 'appService', 'postgres', 'storage'] },
    ],
    serviceConfigs: {
      redis: { skuName: 'Premium' },
      appService: { planSku: 'P1v3', linuxFxVersion: 'PYTHON|3.12' },
      postgres: { version: '15', storageSizeGB: 128 },
    },
  };

  it('emits config params for selected toggleable services with the right literal type', () => {
    const out = planToBicepparam(sub);
    expect(out).toContain("param redisSkuName = 'Premium'");
    expect(out).toContain("param appServicePlanSku = 'P1v3'");
    expect(out).toContain("param appServiceLinuxFxVersion = 'PYTHON|3.12'");
    expect(out).toContain("param postgresVersion = '15'"); // string param, quoted
    expect(out).toContain('param postgresStorageSizeGB = 128'); // int param, bare
  });

  it('falls back to defaults when a service is selected but unconfigured', () => {
    const out = planToBicepparam({
      ...sub,
      serviceConfigs: {},
    });
    expect(out).toContain("param redisSkuName = 'Basic'");
    expect(out).toContain("param appServicePlanSku = 'B1'");
    expect(out).toContain("param postgresStorageSizeGB = 32");
  });

  it('emits NO config for unselected or core/plan-only services', () => {
    const out = planToBicepparam(sub);
    expect(out).not.toContain('mysqlVersion');      // mysql not selected
    expect(out).not.toContain('functionsWorkerRuntime'); // functions not selected
    // storage is core (no bicepFlag, no config) → no config params for it
  });
});

describe('catalog breadth — all-Azure-service-types coverage', () => {
  it('offers a broad catalog (≥ 70 distinct Azure service types)', () => {
    // audit-T119: the planner should surface ALL Azure service types, not a
    // thin curated subset. Each entry is a real Azure service, honestly tagged.
    expect(SERVICE_COUNT).toBeGreaterThanOrEqual(70);
  });

  it('keeps every plan-only addition honest (no fake bicep knobs)', () => {
    // Newly-added breadth services have no one-button toggle yet, so they must
    // be plan-only with a null bicepFlag — never emitting a fake param.
    for (const s of SERVICE_CATALOG) {
      if (s.planOnly) expect(s.bicepFlag).toBeNull();
    }
  });
});

describe('Atlas Diag icon slugs (audit-T119 defect A)', () => {
  it('every service carries a canonical kebab-case iconSlug (or none)', () => {
    for (const s of SERVICE_CATALOG) {
      if (s.iconSlug !== undefined) {
        // kebab-case only — no camelCase, spaces, or uppercase that would make
        // the Atlas Diag / Azure-icon URL 404.
        expect(s.iconSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });

  it('iconUrl resolves a .svg URL from iconSlug when the base is configured', () => {
    const prev = process.env.NEXT_PUBLIC_LOOM_ICON_BASE;
    process.env.NEXT_PUBLIC_LOOM_ICON_BASE = 'https://icons.example/loom';
    try {
      for (const s of SERVICE_CATALOG) {
        const url = iconUrl(s.iconSlug ?? s.key);
        expect(url).toBeDefined();
        expect(url).toMatch(/\.svg$/);
        // the slug (kebab-case) must survive into the URL, not the camelCase key
        if (s.iconSlug) expect(url).toContain(s.iconSlug);
      }
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_LOOM_ICON_BASE;
      else process.env.NEXT_PUBLIC_LOOM_ICON_BASE = prev;
    }
  });

  it('iconUrl stays undefined (bundled fallback) when the base is unset', () => {
    const prev = process.env.NEXT_PUBLIC_LOOM_ICON_BASE;
    delete process.env.NEXT_PUBLIC_LOOM_ICON_BASE;
    try {
      expect(iconUrl('container-apps')).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_LOOM_ICON_BASE = prev;
    }
  });
});

describe('bicep drift guard (no-vaporware)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const mainBicep = readFileSync(
    resolve(here, '../../../../../../platform/fiab/bicep/main.bicep'),
    'utf8',
  );

  it('every catalog bicepFlag is a real param in platform/fiab/bicep/main.bicep', () => {
    const flags = [...new Set(
      SERVICE_CATALOG.map((s) => s.bicepFlag).filter((f): f is string => !!f),
    )];
    expect(flags.length).toBeGreaterThan(0);
    const missing = flags.filter((f) => !new RegExp(`param\\s+${f}\\s+bool`).test(mainBicep));
    expect(missing).toEqual([]);
  });

  it('every per-resource config bicepParam is a real param in main.bicep (no SKU drift)', () => {
    // Each configurable knob must map to a top-level main.bicep param so the
    // exported bicepparam actually applies the chosen SKU/tier (no-vaporware).
    const params = SERVICE_CATALOG
      .flatMap((s) => s.config || [])
      .map((f) => f.bicepParam);
    expect(params.length).toBeGreaterThanOrEqual(8);
    const missing = [...new Set(params)].filter(
      (p) => !new RegExp(`param\\s+${p}\\s+(string|int)`).test(mainBicep),
    );
    expect(missing).toEqual([]);
  });

  it('newly-configurable services (serviceBus/firewall/streamAnalytics) emit their config param', () => {
    const sub: PlanSubscription = {
      id: 'sub-1', name: 'Cfg', boundary: 'Commercial',
      domains: [{ domainId: 'd', name: 'D', services: ['serviceBus', 'firewall', 'streamAnalytics'] }],
      serviceConfigs: {
        serviceBus: { skuName: 'Premium' },
        firewall: { tier: 'Premium' },
        streamAnalytics: { streamingUnits: 12 },
      },
    };
    const out = planToBicepparam(sub);
    expect(out).toContain("param serviceBusSkuName = 'Premium'");
    expect(out).toContain("param firewallTier = 'Premium'");
    expect(out).toContain('param streamAnalyticsStreamingUnits = 12'); // int, bare
  });
});
