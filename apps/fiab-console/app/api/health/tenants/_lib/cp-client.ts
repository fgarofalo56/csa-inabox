/**
 * Client for the LHDS health control plane (apps/loom-health-cp).
 *
 * The control plane holds identities, pointers, policy and telemetry only; it
 * never sees clinical data. Every route is `Authorization: Bearer <Entra token>`
 * and answers `{ok:true,data}` or `{ok:false,error:{code,message}}`
 * (apps/loom-health-cp/README.md). The Console authenticates as its own managed
 * identity, which the control plane admits through
 * LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS + the HealthCP.Admin app role.
 *
 * Azure-native, no Fabric / Power BI host is reachable from here.
 *
 * Errors are TRUE (deploy-integrity R7): a refused or unreachable control plane
 * is reported as exactly that, never as "the tenant does not exist".
 */
import { uamiArmCredential } from '@/lib/azure/arm-credential';

export interface CpConfig {
  baseUrl: string;
  /** First accepted audience of the control plane; the token scope is `<audience>/.default`. */
  audience: string;
}

/** Env vars that make the control plane reachable; the first two are the `health-control-plane` gate. */
export const CP_ENV = { url: 'LOOM_HEALTH_CP_URL', audience: 'LOOM_HEALTH_CP_AUDIENCE' } as const;

export class CpNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`The health control plane is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'CpNotConfiguredError';
  }
}

/** The control plane answered with an error envelope, or was unreachable (status 0). */
export class CpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CpError';
  }
}

export function readCpConfig(env: NodeJS.ProcessEnv = process.env): CpConfig {
  const baseUrl = (env[CP_ENV.url] || '').trim().replace(/\/+$/, '');
  const audience = (env[CP_ENV.audience] || '').split(',')[0]?.trim() || '';
  const missing: string[] = [];
  if (!baseUrl) missing.push(CP_ENV.url);
  if (!audience) missing.push(CP_ENV.audience);
  if (missing.length) throw new CpNotConfiguredError(missing);
  return { baseUrl, audience };
}

let cachedCredential: ReturnType<typeof uamiArmCredential> | undefined;
function credential(): ReturnType<typeof uamiArmCredential> {
  // The shared credential factory, not a direct construction (ws-credential-adoption).
  cachedCredential ??= uamiArmCredential();
  return cachedCredential;
}

const TIMEOUT_MS = 12_000;

export async function cpRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const cfg = readCpConfig();
  let token: string;
  try {
    const t = await credential().getToken(`${cfg.audience}/.default`);
    if (!t?.token) throw new Error('no token returned');
    token = t.token;
  } catch (e) {
    throw new CpError(0, 'token_unavailable', `Could not obtain a token for the health control plane audience: ${(e as Error)?.message ?? String(e)}`);
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    throw new CpError(0, 'unreachable', `The health control plane at ${cfg.baseUrl} could not be reached: ${(e as Error)?.message ?? String(e)}`);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new CpError(res.status, 'bad_response', `The health control plane answered HTTP ${res.status} with a body that is not JSON.`);
  }
  if (!res.ok || json?.ok === false) {
    throw new CpError(res.status, String(json?.error?.code ?? 'error'), String(json?.error?.message ?? `HTTP ${res.status}`));
  }
  return json.data as T;
}

// ── typed views of the control plane's documents (apps/loom-health-cp/src/registry/types.ts) ──

export interface CpStamp {
  id: string;
  displayName: string;
  cloud: 'commercial' | 'gcc' | 'gcc-high' | 'il5' | 'dod';
  region: string;
  class: 'S' | 'M' | 'L';
  status: 'creating' | 'healthy' | 'draining' | 'paused' | 'evacuated';
  pauseReason?: string;
}

export interface CpTenant {
  id: string;
  displayName: string;
  stampId: string;
  status: 'creating' | 'active' | 'draining' | 'suspended' | 'destroying';
  createdAt?: string;
  quotas: { maxRequestsPerMinute: number; maxStorageGiB: number };
}

export interface CpJobReceipt { at: string; step: string; detail: string }
export interface CpJob {
  id: string;
  kind: string;
  subjectId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  receipts: CpJobReceipt[];
  error?: { code: string; message: string };
  updatedAt: string;
  finishedAt?: string;
}

/** A SMART client as the control plane's admin API returns it (publicClient(): no key material). */
export interface CpSmartClient {
  clientId: string;
  tenant: string;
  clientType: 'backend' | 'app';
  displayName: string;
  status: 'active' | 'disabled';
  allowedScopes: string[];
  roleIds: string[];
  redirectUris: string[];
  jwksUrl?: string;
  /** Present when the client registered an inline JWKS (public keys). toAppRow reduces it to a count + kids. */
  jwks?: unknown;
  launchUri?: string;
  /** Backend only: may call the tenant's introspection endpoint (CP PR #5515). */
  introspect?: boolean;
  pou?: string;
  updatedAt?: string;
}

export interface CpPatientSummary { id: string; name: string; birthDate?: string; gender?: string }

/**
 * The AS admin patient search (#5454 A6), HTTP 200 for every shape: `{patients}`, `{unavailable:true, reason}`, or
 * `{notPermitted:true, patients:[]}`.
 */
export interface CpPatientSearchResult {
  patients?: CpPatientSummary[];
  unavailable?: true;
  reason?: string;
  notPermitted?: true;
}

export const cp = {
  // ── SMART clients + EHR launch (Authorization Server admin API, #5454 A6) ──
  listClients: () => cpRequest<{ clients: CpSmartClient[] }>('GET', '/api/health/auth/clients').then((r) => r.clients),
  createClient: (b: {
    clientId: string; tenant: string; clientType: 'app' | 'backend'; displayName: string; allowedScopes: string[];
    redirectUris: string[]; launchUri?: string; roleIds?: string[]; introspect?: true;
    /** Exactly one of these for a confidential client (CP `!!c.jwksUrl === !!c.jwks` rule); jwks is PUBLIC keys only. */
    jwksUrl?: string; jwks?: { keys: Array<Record<string, unknown>> };
  }) => cpRequest<CpSmartClient>('POST', '/api/health/auth/clients', b),
  updateClient: (clientId: string, b: { status?: 'active' | 'disabled'; launchUri?: string | null }) =>
    cpRequest<CpSmartClient>('PATCH', `/api/health/auth/clients/${encodeURIComponent(clientId)}`, b),
  /** `iss` is the tenant FHIR base the CP mints tokens for; absent only on a CP that predates #5454 A6. */
  mintLaunch: (b: { tenant: string; oid: string; clientId: string; patient?: string }) =>
    cpRequest<{ launch: string; expiresAt: string; iss?: string }>('POST', '/api/health/auth/launch', b),
  patientSearch: (tenant: string, b: { oid: string; q: string; birthdate?: string }) =>
    cpRequest<CpPatientSearchResult>('POST', `/api/health/auth/tenants/${encodeURIComponent(tenant)}/patient-search`, b),

  listStamps: () => cpRequest<{ stamps: CpStamp[] }>('GET', '/api/health/stamps').then((r) => r.stamps),
  listTenants: () => cpRequest<{ tenants: CpTenant[] }>('GET', '/api/health/tenants').then((r) => r.tenants),
  /** null ONLY on a 404 from a reachable control plane; every other failure throws. */
  async getTenant(id: string): Promise<CpTenant | null> {
    try {
      return await cpRequest<CpTenant>('GET', `/api/health/tenants/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof CpError && e.status === 404) return null;
      throw e;
    }
  },
  createTenant: (b: { id: string; displayName: string; stampId: string; quotas: CpTenant['quotas'] }) =>
    cpRequest<CpTenant>('POST', '/api/health/tenants', b),
  /** Quota edit (control plane PATCH /tenants/{id}, strict schema: only the fields sent change). */
  updateTenantQuotas: (id: string, quotas: CpTenant['quotas']) =>
    cpRequest<CpTenant>('PATCH', `/api/health/tenants/${encodeURIComponent(id)}`, { quotas }),
  submitJob: (b: { kind: string; subjectType: 'tenant'; subjectId: string; idempotencyKey: string; input?: Record<string, unknown> }) =>
    cpRequest<CpJob>('POST', '/api/health/jobs', b),
  retryJob: (id: string) => cpRequest<CpJob>('POST', `/api/health/jobs/${encodeURIComponent(id)}/retry`),
  getJob: (id: string) => cpRequest<CpJob>('GET', `/api/health/jobs/${encodeURIComponent(id)}`),
};
