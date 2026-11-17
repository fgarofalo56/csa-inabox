// Stamp ingress TLS certificate, issued in Key Vault by the control plane (#5345).
//
// Why here and not in bicep: on tenants whose policy forces storage shared-key access off, a
// deploymentScript can never run (ACI mounts its share by key), and ARM cannot create Key Vault
// certificates. The control plane already runs inside the stamp with private access to the stamp
// vault, so it ensures the certificate itself: issuer Self, subject and SAN = the stamp public
// FQDN. Key Vault generates the key; the private key never leaves the vault and this module only
// ever reads certificate METADATA (never a secret or key value).
//
// Idempotent: a valid certificate is a no-op; a missing, expired, expiring (inside
// renewBeforeDays), disabled or wrong-subject certificate is re-issued. The policy also carries an
// AutoRenew lifetime action and the gateway reads the VERSIONLESS secret URI, so renewals roll
// without a redeploy.

import { keyVaultScope, KEYVAULT_SUFFIX_BY_CLOUD } from '../auth/clouds.js';
import type { Cloud } from '../config.js';
import { ConfigError } from '../config.js';
import { logSafe } from '../safe-error.js';

const API = '7.5';
export const CERTIFICATES_OFFICER_ROLE = 'Key Vault Certificates Officer';
const DAY_MS = 86_400_000;

export interface IngressCertConfig {
  cloud: Cloud;
  /** Vault base URL, https://<vault>.<cloud suffix>/ . */
  vaultUrl: string;
  certName: string;
  /** Ingress public FQDN: certificate subject CN and only DNS SAN. */
  fqdn: string;
  renewBeforeDays: number;
}

/** undefined = the feature is off (neither variable set). */
export function loadIngressCertConfig(cloud: Cloud, env: NodeJS.ProcessEnv = process.env): IngressCertConfig | undefined {
  const vaultUrl = (env.LOOM_HEALTH_CP_TLS_VAULT_URL ?? '').trim();
  const fqdn = (env.LOOM_HEALTH_CP_TLS_FQDN ?? '').trim().toLowerCase();
  if (!vaultUrl && !fqdn) return undefined;
  if (!vaultUrl || !fqdn) {
    throw new ConfigError('LOOM_HEALTH_CP_TLS_VAULT_URL and LOOM_HEALTH_CP_TLS_FQDN must be set together');
  }
  const suffix = KEYVAULT_SUFFIX_BY_CLOUD[cloud];
  let u: URL;
  try {
    u = new URL(vaultUrl);
  } catch {
    throw new ConfigError('LOOM_HEALTH_CP_TLS_VAULT_URL must be an https URL');
  }
  if (u.protocol !== 'https:' || !u.hostname.endsWith(`.${suffix}`)) {
    throw new ConfigError(`LOOM_HEALTH_CP_TLS_VAULT_URL must be https://<vault>.${suffix}/`);
  }
  if (!/^[a-z0-9.-]+$/.test(fqdn)) throw new ConfigError('LOOM_HEALTH_CP_TLS_FQDN must be a bare hostname');
  const certName = (env.LOOM_HEALTH_CP_TLS_CERT_NAME ?? '').trim() || 'lhds-ingress-selfsigned';
  if (!/^[A-Za-z0-9-]{1,127}$/.test(certName)) throw new ConfigError('LOOM_HEALTH_CP_TLS_CERT_NAME must be 1-127 letters, digits or dashes');
  const days = Number(env.LOOM_HEALTH_CP_TLS_RENEW_BEFORE_DAYS ?? '30');
  if (!Number.isInteger(days) || days < 1 || days > 300) {
    throw new ConfigError('LOOM_HEALTH_CP_TLS_RENEW_BEFORE_DAYS must be an integer from 1 to 300');
  }
  return { cloud, vaultUrl: `${u.origin}/`, certName, fqdn, renewBeforeDays: days };
}

export type EnsureOutcome = 'valid' | 'issued';

export class IngressCertError extends Error {}

interface CertState {
  enabled: boolean;
  /** Expiry as epoch milliseconds, undefined when the vault returned none. */
  expiresMs: number | undefined;
  subject: string;
  dnsNames: string[];
}

export interface IngressCertDeps {
  cfg: IngressCertConfig;
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Polls waiting for a new certificate to become enabled. */
  pollAttempts?: number;
  pollIntervalMs?: number;
}

/** Why the existing certificate cannot be kept, or undefined when it can. */
export function staleReason(c: CertState, cfg: IngressCertConfig, now: Date): string | undefined {
  if (!c.enabled) return 'it is disabled';
  if (c.expiresMs === undefined) return 'it has no expiry';
  if (c.subject !== `CN=${cfg.fqdn}` || c.dnsNames.length !== 1 || c.dnsNames[0] !== cfg.fqdn) {
    return `its subject/SAN (${c.subject} / ${c.dnsNames.join(',')}) is not ${cfg.fqdn}`;
  }
  if (c.expiresMs - now.getTime() <= cfg.renewBeforeDays * DAY_MS) {
    return c.expiresMs <= now.getTime() ? 'it has expired' : `it expires within ${cfg.renewBeforeDays} days`;
  }
  return undefined;
}

function policy(cfg: IngressCertConfig): Record<string, unknown> {
  return {
    issuer: { name: 'Self' },
    key_props: { exportable: true, kty: 'RSA', key_size: 2048, reuse_key: false },
    lifetime_actions: [{ trigger: { days_before_expiry: cfg.renewBeforeDays }, action: { action_type: 'AutoRenew' } }],
    secret_props: { contentType: 'application/x-pkcs12' },
    x509_props: {
      subject: `CN=${cfg.fqdn}`,
      sans: { dns_names: [cfg.fqdn] },
      key_usage: ['digitalSignature', 'keyEncipherment'],
      ekus: ['1.3.6.1.5.5.7.3.1'],
      validity_months: 12,
    },
  };
}

export async function ensureIngressCertificate(d: IngressCertDeps): Promise<EnsureOutcome> {
  const { cfg } = d;
  const f = d.fetchImpl ?? fetch;
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = (p: string): string => `${cfg.vaultUrl}certificates/${cfg.certName}${p}?api-version=${API}`;

  const call = async (p: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
    let res: Response;
    try {
      res = await f(url(p), {
        ...init,
        redirect: 'error',
        headers: { authorization: `Bearer ${await d.getToken(keyVaultScope(cfg.cloud))}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // Not a verdict on the certificate: say what was not reached, and why only as far as known.
      throw new IngressCertError(`could not reach vault ${cfg.vaultUrl} (private endpoint, DNS or token): ${logSafe(e instanceof Error ? e.message : e, 200)}`);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* empty or non-JSON body: status carries the verdict */
    }
    if (res.status === 403) {
      const inner = ((body.error as Record<string, unknown> | undefined)?.innererror as Record<string, unknown> | undefined)?.code;
      if (inner === 'ForbiddenByFirewall' || inner === 'ForbiddenByConnection') {
        throw new IngressCertError(`vault ${cfg.vaultUrl} refused the request at the network layer (${String(inner)}): the control plane is not on the vault private endpoint path`);
      }
      throw new IngressCertError(
        `vault ${cfg.vaultUrl} returned 403: the control-plane identity needs the "${CERTIFICATES_OFFICER_ROLE}" role on that vault (scope: the stamp Key Vault; Azure RBAC must be enabled on it). Grant it with a role assignment on the vault, then retry`,
      );
    }
    return { status: res.status, body };
  };

  const read = async (): Promise<CertState | undefined> => {
    const r = await call('', { method: 'GET' });
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new IngressCertError(`vault returned ${r.status} reading certificate ${cfg.certName}`);
    const attrs = (r.body.attributes ?? {}) as Record<string, unknown>;
    const x509 = ((r.body.policy as Record<string, unknown> | undefined)?.x509_props ?? {}) as Record<string, unknown>;
    const sans = (x509.sans ?? {}) as Record<string, unknown>;
    return {
      enabled: attrs.enabled === true,
      expiresMs: typeof attrs.exp === 'number' ? attrs.exp * 1000 : undefined,
      subject: typeof x509.subject === 'string' ? x509.subject : '',
      dnsNames: Array.isArray(sans.dns_names) ? sans.dns_names.map(String) : [],
    };
  };

  const current = await read();
  if (current && staleReason(current, cfg, now()) === undefined) return 'valid';

  const r = await call('/create', { method: 'POST', body: JSON.stringify({ policy: policy(cfg) }) });
  // 409 = a creation is already pending (another replica): fall through to polling for it.
  if (r.status !== 202 && r.status !== 200 && r.status !== 409) {
    throw new IngressCertError(`vault returned ${r.status} creating certificate ${cfg.certName}`);
  }
  const attempts = d.pollAttempts ?? 30;
  const interval = d.pollIntervalMs ?? 2000;
  for (let i = 0; i < attempts; i++) {
    const c = await read();
    if (c && staleReason(c, cfg, now()) === undefined) return 'issued';
    await sleep(interval);
  }
  throw new IngressCertError(`certificate ${cfg.certName} was requested but is not enabled and valid after ${attempts} checks`);
}

/** Ensure at startup and on a timer; a failure is logged with its truthful message and retried. */
export function scheduleIngressCert(
  d: IngressCertDeps,
  log: (event: string, fields: Record<string, string | number>) => void,
  intervalMs = 15 * 60_000,
): () => void {
  const run = async (): Promise<void> => {
    try {
      const outcome = await ensureIngressCertificate(d);
      log('tls.ingress_cert', { outcome, cert: d.cfg.certName });
    } catch (e) {
      log('tls.ingress_cert_error', { cert: d.cfg.certName, error: logSafe(e instanceof IngressCertError ? e.message : 'unexpected error') });
    }
  };
  void run();
  const t = setInterval(() => void run(), intervalMs);
  t.unref();
  return () => clearInterval(t);
}
