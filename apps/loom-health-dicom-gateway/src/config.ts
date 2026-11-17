import { SLUG } from './slug.js';

export interface GatewayConfig {
  port: number;
  /** In-cluster OPA base URL, e.g. http://loom-health-pdp:8181 */
  pdpUrl: string;
  pdpTimeoutMs: number;
  /**
   * Public base of the stamp, e.g. https://stamp.health.example. The PDP `base`
   * is `${publicBase}/${tenant}/dicomweb` and must be one of the tenant's bases in
   * data.lhds.stamp. Never derived from the Host header (client controlled).
   */
  publicBase: string;
  /** Archive URL template containing `{tenant}`, e.g. http://loom-health-dicom.{tenant}.svc:8080 */
  archiveUrlTemplate: string;
  archiveAet: string;
  stowMaxBytes: number;
  qidoMaxLimit: number;
  qidoDefaultLimit: number;
  /** Largest QIDO/STOW response the gateway will buffer to rewrite archive URLs. */
  rewriteMaxBytes: number;
  archiveTimeoutMs: number;
}

const GIB = 1024 ** 3;

function int(env: NodeJS.ProcessEnv, key: string, dflt: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${key} must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be between ${min} and ${max}, got ${raw}`);
  }
  return n;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') throw new Error(`${key} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const archiveUrlTemplate = req(env, 'LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE');
  if (!archiveUrlTemplate.includes('{tenant}')) {
    throw new Error('LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE must contain {tenant}: one archive per tenant');
  }
  const publicBase = req(env, 'LOOM_DICOM_GW_PUBLIC_BASE').replace(/\/+$/, '');
  return {
    port: int(env, 'LOOM_DICOM_GW_PORT', 8080, 1, 65535),
    pdpUrl: req(env, 'LOOM_DICOM_GW_PDP_URL').replace(/\/+$/, ''),
    pdpTimeoutMs: int(env, 'LOOM_DICOM_GW_PDP_TIMEOUT_MS', 2000, 50, 30000),
    publicBase,
    archiveUrlTemplate,
    archiveAet: env.LOOM_DICOM_GW_ARCHIVE_AET || 'DCM4CHEE',
    stowMaxBytes: int(env, 'LOOM_DICOM_GW_STOW_MAX_BYTES', 4 * GIB, 1, 64 * GIB),
    qidoMaxLimit: 200,
    qidoDefaultLimit: 100,
    rewriteMaxBytes: 16 * 1024 * 1024,
    archiveTimeoutMs: int(env, 'LOOM_DICOM_GW_ARCHIVE_TIMEOUT_MS', 120000, 1000, 3600000),
  };
}

/** Archive base for a tenant. The slug check is the SSRF guard on the template substitution. */
export function archiveBase(cfg: GatewayConfig, tenant: string): string {
  if (!SLUG.test(tenant)) throw new Error('invalid tenant slug');
  return cfg.archiveUrlTemplate.replace('{tenant}', tenant).replace(/\/+$/, '');
}
