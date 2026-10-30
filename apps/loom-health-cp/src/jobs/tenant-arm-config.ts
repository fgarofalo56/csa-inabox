// Production wiring for the tenant.* jobs (#5162): builds the RestTenantArm from
// the subscription id and the compiled tenant.bicep. Every value is validated at
// startup and a missing one is named, so a deploy that forgot it fails loudly
// instead of leaving tenant.create answering "unknown job kind".

import { readFileSync } from 'node:fs';
import { DefaultAzureCredential } from '@azure/identity';
import { keyVaultScope } from '../auth/clouds.js';
import { ConfigError, type Cloud } from '../config.js';
import { RestTenantArm } from './tenant-arm.js';

export const ARM_ENDPOINT_BY_CLOUD: Record<Cloud, string> = {
  commercial: 'https://management.azure.com',
  gcc: 'https://management.azure.com',
  'gcc-high': 'https://management.usgovcloudapi.net',
  il5: 'https://management.usgovcloudapi.net',
  dod: 'https://management.usgovcloudapi.net',
};

export interface TenantArmConfig {
  armEndpoint: string;
  subscriptionId: string;
  vaultScope: string;
  /** Compiled tenant.bicep, parsed once at startup. */
  template: Record<string, unknown>;
}

export function loadTenantArmConfig(
  cloud: Cloud,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): TenantArmConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = (env[name] ?? '').trim();
    if (!v) missing.push(name);
    return v;
  };
  const subscriptionId = need('LOOM_HEALTH_CP_SUBSCRIPTION_ID');
  const templatePath = need('LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH');
  if (missing.length > 0) throw new ConfigError(`missing required environment: ${missing.join(', ')}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    throw new ConfigError('LOOM_HEALTH_CP_SUBSCRIPTION_ID must be a subscription GUID');
  }
  let template: unknown;
  try {
    template = JSON.parse(readFile(templatePath));
  } catch {
    throw new ConfigError('LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH must name a readable compiled ARM template (JSON); build it with az bicep build');
  }
  const t = template as { $schema?: unknown; resources?: unknown } | null;
  if (!t || typeof t !== 'object' || typeof t.$schema !== 'string' || t.resources === undefined) {
    throw new ConfigError('LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH is not a compiled ARM template (no $schema/resources)');
  }
  return { armEndpoint: ARM_ENDPOINT_BY_CLOUD[cloud], subscriptionId, vaultScope: keyVaultScope(cloud), template: t as Record<string, unknown> };
}

export function tenantArmFromConfig(c: TenantArmConfig, authorityHost: string): RestTenantArm {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${authorityHost}` });
  return new RestTenantArm({
    armEndpoint: c.armEndpoint,
    subscriptionId: c.subscriptionId,
    vaultScope: c.vaultScope,
    token: async (scope) => (await credential.getToken(scope)).token,
    loadTemplate: async () => c.template,
  });
}
