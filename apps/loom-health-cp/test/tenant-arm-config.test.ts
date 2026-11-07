// #5162: main.ts builds the tenant ARM adapter from env; a missing value fails startup by name;
// the bicep that deploys the control plane supplies exactly those names. Each assertion names the
// input that breaks it. The synthetic create-then-destroy receipt is NOT covered here (UNMEASURED).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { ARM_ENDPOINT_BY_CLOUD, loadTenantArmConfig, tenantArmFromConfig } from '../src/jobs/tenant-arm-config.js';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(dir, p), 'utf8');
const SUB = '11111111-2222-3333-4444-555555555555';
const TEMPLATE = JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', resources: [] });
const okEnv = { LOOM_HEALTH_CP_SUBSCRIPTION_ID: SUB, LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH: '/app/templates/tenant.json' };
const fileOk = (): string => TEMPLATE;

describe('loadTenantArmConfig', () => {
  it('returns the subscription, the per-cloud ARM endpoint and vault scope, and the parsed template', () => {
    // Input that breaks it: gcc-high resolving to management.azure.com (the job would deploy into the wrong cloud).
    const c = loadTenantArmConfig('gcc-high', okEnv, fileOk);
    expect(c.subscriptionId).toBe(SUB);
    expect(c.armEndpoint).toBe('https://management.usgovcloudapi.net');
    expect(c.vaultScope).toBe('https://vault.usgovcloudapi.net/.default');
    expect(c.template.resources).toEqual([]);
    expect(loadTenantArmConfig('commercial', okEnv, fileOk).armEndpoint).toBe('https://management.azure.com');
    expect(loadTenantArmConfig('gcc', okEnv, fileOk).armEndpoint).toBe('https://management.azure.com');
  });

  it('covers every cloud in the endpoint table with a distinct commercial/sovereign split', () => {
    // Input that breaks it: a new Cloud added to config.ts without an ARM endpoint (Record type + this count).
    expect(Object.keys(ARM_ENDPOINT_BY_CLOUD).sort()).toEqual(['commercial', 'dod', 'gcc', 'gcc-high', 'il5']);
    expect(new Set(Object.values(ARM_ENDPOINT_BY_CLOUD)).size).toBe(2);
  });

  it.each([
    ['LOOM_HEALTH_CP_SUBSCRIPTION_ID', { LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH: '/t.json' }],
    ['LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH', { LOOM_HEALTH_CP_SUBSCRIPTION_ID: SUB }],
  ])('names %s when only it is missing, and not the one that is set', (missingName, env) => {
    // Input that breaks it: the variable unset (or blank) -> ConfigError naming it; a message naming the other one fails the second check.
    let err: unknown;
    try {
      loadTenantArmConfig('commercial', env, fileOk);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain(missingName);
    const other = missingName === 'LOOM_HEALTH_CP_SUBSCRIPTION_ID' ? 'LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH' : 'LOOM_HEALTH_CP_SUBSCRIPTION_ID';
    expect(msg).not.toContain(other);
  });

  it('names both when both are missing, and treats whitespace-only as missing', () => {
    // Input that breaks it: '   ' accepted as a value.
    expect(() => loadTenantArmConfig('commercial', { LOOM_HEALTH_CP_SUBSCRIPTION_ID: '   ' }, fileOk)).toThrow(
      /LOOM_HEALTH_CP_SUBSCRIPTION_ID, LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH/,
    );
  });

  it('rejects a non-GUID subscription id', () => {
    // Input that breaks it: 'my-sub' (would build ARM URLs that 404 at the first job, not at startup).
    expect(() => loadTenantArmConfig('commercial', { ...okEnv, LOOM_HEALTH_CP_SUBSCRIPTION_ID: 'my-sub' }, fileOk)).toThrow(/SUBSCRIPTION_ID must be a subscription GUID/);
  });

  it('rejects an unreadable file, non-JSON, and JSON that is not an ARM template', () => {
    // Inputs that break it: a thrown ENOENT, the text 'az bicep build failed', and a bare {} (no $schema/resources).
    const boom = (): string => {
      throw new Error('ENOENT');
    };
    expect(() => loadTenantArmConfig('commercial', okEnv, boom)).toThrow(/TENANT_TEMPLATE_PATH must name a readable compiled ARM template/);
    expect(() => loadTenantArmConfig('commercial', okEnv, () => 'not json')).toThrow(/readable compiled ARM template/);
    expect(() => loadTenantArmConfig('commercial', okEnv, () => '{}')).toThrow(/not a compiled ARM template/);
    expect(() => loadTenantArmConfig('commercial', okEnv, () => 'null')).toThrow(/not a compiled ARM template/);
  });

  it('does not echo the template path or file contents in the unreadable-file error', () => {
    // Input that breaks it: interpolating the path/raw parse error into the message.
    let msg = '';
    try {
      loadTenantArmConfig('commercial', okEnv, () => 'SECRETISH-not-json');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('TENANT_TEMPLATE_PATH'); // positive pair: it still names the variable
    expect(msg).not.toContain('SECRETISH');
    expect(msg).not.toContain('/app/templates');
  });
});

describe('tenantArmFromConfig', () => {
  it('serves the parsed template to the adapter and implements the TenantArm seam used by the jobs', async () => {
    // Input that breaks it: loadTemplate re-reading disk / returning a different object, or a missing seam method.
    const cfg = loadTenantArmConfig('commercial', okEnv, fileOk);
    const arm = tenantArmFromConfig(cfg, 'login.microsoftonline.com');
    for (const m of ['deployTenant', 'getStampManifest', 'getTenantManifest', 'readResource', 'deleteResource', 'readKey', 'disableKey', 'deleteKey', 'findTenantStorage', 'scopeFor']) {
      expect(typeof (arm as unknown as Record<string, unknown>)[m], m).toBe('function');
    }
    expect(arm.scopeFor('rg-x')).toBe(`/subscriptions/${SUB}/resourceGroups/rg-x`);
  });
});

describe('main.ts wiring', () => {
  const main = read('../src/main.ts');
  it('loads the tenant ARM config inside the startup try block, before compose, so a miss exits 1', () => {
    // Input that breaks it: moving loadTenantArmConfig after the catch (a throw becomes an unhandled crash with no variable name)
    // or deleting the call.
    const tryAt = main.indexOf('try {');
    const catchAt = main.indexOf('} catch');
    const loadAt = main.indexOf('loadTenantArmConfig(cfg.cloud)');
    expect(loadAt).toBeGreaterThan(tryAt);
    expect(loadAt).toBeLessThan(catchAt);
    expect(catchAt).toBeLessThan(main.indexOf('compose({'));
    expect(main).toMatch(/process\.exit\(1\)/);
  });
  it('passes tenantArm to compose()', () => {
    // Input that breaks it: removing the `tenantArm:` line -> tenant.create answers "unknown job kind" again (#5162).
    const composeCall = main.slice(main.indexOf('compose({'), main.indexOf('const server'));
    expect(composeCall).toContain('tenantArm: tenantArmFromConfig(tenantCfg, cfg.authorityHost)');
  });
});

describe('bicep + image supply the values the service reads', () => {
  const cp = read('../../../platform/fiab/bicep/modules/health/control-plane.bicep');
  const dockerfile = read('../Dockerfile');
  const cfgSrc = read('../src/jobs/tenant-arm-config.ts');
  it('every LOOM_HEALTH_CP_* name the config reads is set in cpEnv, with an unfiltered, non-empty source', () => {
    // Input that breaks it: a typo on either side (LOOM_HEALTH_CP_SUBSCRIPTION vs _ID), or the entry moved into authEnvSource.
    const names = [...cfgSrc.matchAll(/need\('(LOOM_HEALTH_CP_[A-Z_]+)'\)/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['LOOM_HEALTH_CP_SUBSCRIPTION_ID', 'LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH']);
    const cpEnv = cp.slice(cp.indexOf('var cpEnv'), cp.indexOf('resource app '));
    for (const n of names) expect(cpEnv, n).toContain(`name: '${n}'`);
    expect(cpEnv).toContain("value: subscription().subscriptionId");
  });
  it('the template path env equals the path the Dockerfile writes tenant.json to', () => {
    // Input that breaks it: bicep says /app/templates/tenant.json while the image copies elsewhere (service would fail at startup in prod only).
    const envPath = /LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH', value: '([^']+)'/.exec(cp)?.[1];
    expect(envPath).toBe('/app/templates/tenant.json');
    expect(dockerfile).toMatch(/WORKDIR \/app[\s\S]*COPY --from=template \/tenant\.json \.\/templates\/tenant\.json/);
    expect(dockerfile).toContain('az bicep build --file health/tenant.bicep --outfile /tenant.json');
  });
  it('adds no new module to main.bicep (ARM headroom): the env change is confined to control-plane.bicep', () => {
    // Input that breaks it: wiring tenant.bicep into health.bicep/main.bicep (check-bicep-sync exempts it as a runtime deployment).
    expect(read('../../../platform/fiab/bicep/health.bicep')).not.toContain("'modules/health/tenant.bicep'");
  });
});
