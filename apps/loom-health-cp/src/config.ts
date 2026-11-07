// Environment-driven configuration. Every value the service reads is listed in
// README.md. Nothing here is a secret: Cosmos and Entra are reached with a
// managed identity (DefaultAzureCredential), never a key or connection string.

export type Cloud = 'commercial' | 'gcc' | 'gcc-high' | 'il5' | 'dod';

const CLOUDS: readonly Cloud[] = ['commercial', 'gcc', 'gcc-high', 'il5', 'dod'];

// GCC is public-cloud Azure under a government-community identity, so it signs
// in at the Commercial authority. GCC-High, IL5 and DoD use the sovereign one.
const AUTHORITY_BY_CLOUD: Record<Cloud, string> = {
  commercial: 'login.microsoftonline.com',
  gcc: 'login.microsoftonline.com',
  'gcc-high': 'login.microsoftonline.us',
  il5: 'login.microsoftonline.us',
  dod: 'login.microsoftonline.us',
};

export interface Config {
  port: number;
  cloud: Cloud;
  authorityHost: string;
  entraTenantId: string;
  audiences: string[];
  allowedCallerAppIds: string[];
  cosmosEndpoint: string;
  cosmosDatabase: string;
  sloAvailabilityTarget: number;
  /** Directory holding <stamp>.tar.gz signed PDP bundles. Empty = bundle route answers 503. */
  pdpBundleDir: string;
}

export class ConfigError extends Error {}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function resolveAuthorityHost(cloud: Cloud, override?: string): string {
  const host = (override ?? '').trim() || AUTHORITY_BY_CLOUD[cloud];
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    throw new ConfigError('LOOM_HEALTH_CP_AUTHORITY_HOST must be a bare hostname');
  }
  return host;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = (env[name] ?? '').trim();
    if (!v) missing.push(name);
    return v;
  };

  const cloudRaw = need('LOOM_HEALTH_CP_CLOUD').toLowerCase();
  const entraTenantId = need('LOOM_HEALTH_CP_TENANT_ID');
  const audiences = list(env.LOOM_HEALTH_CP_AUDIENCE);
  if (audiences.length === 0) missing.push('LOOM_HEALTH_CP_AUDIENCE');
  const cosmosEndpoint = need('LOOM_HEALTH_CP_COSMOS_ENDPOINT');
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment: ${missing.join(', ')}`);
  }
  if (!CLOUDS.includes(cloudRaw as Cloud)) {
    throw new ConfigError(`LOOM_HEALTH_CP_CLOUD must be one of ${CLOUDS.join(', ')}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(entraTenantId)) {
    throw new ConfigError('LOOM_HEALTH_CP_TENANT_ID must be a tenant GUID');
  }
  if (!/^https:\/\//.test(cosmosEndpoint)) {
    throw new ConfigError('LOOM_HEALTH_CP_COSMOS_ENDPOINT must be an https URL');
  }
  const cloud = cloudRaw as Cloud;
  const target = Number(env.LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET ?? '0.999');
  if (!(target > 0 && target < 1)) {
    throw new ConfigError('LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET must be between 0 and 1 (exclusive)');
  }
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be a valid TCP port');
  }
  return {
    port,
    cloud,
    authorityHost: resolveAuthorityHost(cloud, env.LOOM_HEALTH_CP_AUTHORITY_HOST),
    entraTenantId,
    audiences,
    allowedCallerAppIds: list(env.LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS),
    cosmosEndpoint,
    cosmosDatabase: (env.LOOM_HEALTH_CP_COSMOS_DATABASE ?? '').trim() || 'loom-health-cp',
    sloAvailabilityTarget: target,
    pdpBundleDir: (env.LOOM_HEALTH_CP_PDP_BUNDLE_DIR ?? '').trim(),
  };
}
