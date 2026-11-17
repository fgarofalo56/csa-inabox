// Per-tenant FHIR engine configuration (W2-2): the tenant-VARYING half of the engine's settings.
//
// The tenant-independent policy (partition mode, referential integrity, validation, versioning,
// destructive paths off) is apps/loom-health-fhir/config/application.yaml, loaded by every engine. What
// differs per tenant is rendered here as environment variables, which Spring binds over the file:
// the datasource (the tenant's own database on the stamp server, its own role), the pool, the caps, the
// interceptor list and the plugin's env. The rendering is a PURE function: the same inputs always give the
// same output and the same revision hash, which is what makes fhir-tenant.create idempotent.
//
// NO SECRET is rendered. The database password is a reference to a Key Vault secret by name; the host
// adapter injects the value (secretKeyRef-style) and the control plane never holds it.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JobFailure } from './types.js';

/** Interceptor registration ORDER is the security order: authorize first, then audit what was decided. */
export const PDP_INTERCEPTOR = 'ai.loom.health.fhir.pdp.LoomPdpInterceptor';
export const AUDIT_INTERCEPTOR = 'ai.loom.health.fhir.audit.LoomAuditInterceptor';

/** The page-size ceiling of config/application.yaml. A tenant cap may only LOWER it. */
export const BASE_MAX_PAGE_SIZE = 200;
/** Initial per-tenant pool bounds. A starting heuristic (W7 measures); never above the stamp server's connection budget. */
export const POOL_MIN = 8;
export const POOL_MAX = 50;
export const MAX_BINARY_BYTES_CEILING = 104_857_600;

export const OverridesSchema = z.strictObject({
  maxPageSize: z.number().int().min(1).max(BASE_MAX_PAGE_SIZE).optional(),
  defaultPageSize: z.number().int().min(1).max(BASE_MAX_PAGE_SIZE).optional(),
  maxBinaryBytes: z.number().int().min(1024).max(MAX_BINARY_BYTES_CEILING).optional(),
  poolSize: z.number().int().min(POOL_MIN).max(POOL_MAX).optional(),
});
export type EngineOverrides = z.infer<typeof OverridesSchema>;

export interface FhirNames {
  databaseName: string;
  /** The PostgreSQL role the engine connects as. One per tenant; granted CONNECT on that tenant's database only. */
  roleName: string;
  /** Key Vault secret NAME holding the role's password (never the value). */
  passwordSecretName: string;
}

/** `lhds_acme_health` (database, same derivation as tenant.bicep) / `lhds_acme_health_app` / `t-acme-health-fhir-db`. */
export function fhirNames(slug: string): FhirNames {
  const db = `lhds_${slug.replaceAll('-', '_')}`;
  return { databaseName: db, roleName: `${db}_app`, passwordSecretName: `t-${slug}-fhir-db` };
}

export interface RenderInput {
  tenantId: string;
  stampId: string;
  /** Stamp PostgreSQL server FQDN from the stamp manifest (`postgresFqdn`). */
  postgresFqdn: string;
  maxRequestsPerMinute: number;
  /** In-cluster PDP decision endpoint base (W1-5). Required: the plugin answers 503 to every request without it. */
  pdpUrl: string;
  overrides?: EngineOverrides;
}

export interface RenderedEngineConfig {
  tenantId: string;
  stampId: string;
  names: FhirNames;
  /** Plain (non-secret) environment for the engine container. */
  env: Record<string, string>;
  /** Env var -> Key Vault secret name. The adapter resolves the value. */
  secretRefs: Record<string, string>;
  overrides: EngineOverrides;
  /** Partition mode is a creation-time property of the database (ADR-003). Always true here. */
  partitioning: true;
  /** sha256 of the canonical JSON of everything above: the revision the readback compares. */
  revision: string;
}

/** Pool size from the tenant's request quota: ~1 connection per 300 req/min plus headroom, clamped. */
export function poolSizeFor(maxRequestsPerMinute: number): number {
  return Math.min(POOL_MAX, Math.max(POOL_MIN, 4 + Math.ceil(maxRequestsPerMinute / 300)));
}

const FQDN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function renderEngineConfig(i: RenderInput): RenderedEngineConfig {
  if (!FQDN.test(i.postgresFqdn)) {
    throw new JobFailure('stamp_manifest_incomplete', `the stamp manifest postgresFqdn is not a host name (got ${i.postgresFqdn ? 'an invalid value' : 'nothing'}); the engine datasource cannot be built`);
  }
  let pdp: URL;
  try {
    pdp = new URL(i.pdpUrl);
  } catch {
    throw new JobFailure('pdp_url_invalid', 'the PDP url is not a URL; without it every engine request is answered 503, so no engine is configured');
  }
  if (!/^https?:$/.test(pdp.protocol) || pdp.username || pdp.password || pdp.search || pdp.hash) {
    throw new JobFailure('pdp_url_invalid', 'the PDP url must be http(s) without credentials, query or fragment');
  }
  const overrides = OverridesSchema.parse(i.overrides ?? {});
  const maxPage = overrides.maxPageSize ?? BASE_MAX_PAGE_SIZE;
  const defPage = overrides.defaultPageSize ?? Math.min(20, maxPage);
  if (defPage > maxPage) {
    throw new JobFailure('caps_invalid', `defaultPageSize ${defPage} exceeds maxPageSize ${maxPage}; nothing was changed`);
  }
  const names = fhirNames(i.tenantId);
  const pool = overrides.poolSize ?? poolSizeFor(i.maxRequestsPerMinute);
  const env: Record<string, string> = {
    // The tenant's OWN database on the stamp server; sslmode=require as W0 measured.
    SPRING_DATASOURCE_URL: `jdbc:postgresql://${i.postgresFqdn}:5432/${names.databaseName}?sslmode=require`,
    SPRING_DATASOURCE_USERNAME: names.roleName,
    SPRING_DATASOURCE_DRIVERCLASSNAME: 'org.postgresql.Driver',
    SPRING_JPA_PROPERTIES_HIBERNATE_DIALECT: 'ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect',
    SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE: String(pool),
    SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE: String(Math.min(pool, POOL_MIN)),
    SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT: '10000',
    SPRING_CONFIG_ADDITIONAL_LOCATION: 'optional:file:/opt/loom/fhir/config/application.yaml',
    HAPI_FHIR_MAX_PAGE_SIZE: String(maxPage),
    HAPI_FHIR_DEFAULT_PAGE_SIZE: String(defPage),
    HAPI_FHIR_MAX_BINARY_SIZE: String(overrides.maxBinaryBytes ?? MAX_BINARY_BYTES_CEILING),
    HAPI_FHIR_CUSTOM_INTERCEPTOR_CLASSES: `${PDP_INTERCEPTOR},${AUDIT_INTERCEPTOR}`,
    LOOM_HEALTH_TENANT: i.tenantId,
    LOOM_HEALTH_PDP_URL: pdp.toString().replace(/\/$/, ''),
    LOOM_HEALTH_PDP_TIMEOUT_MS: '1500',
  };
  const secretRefs = { SPRING_DATASOURCE_PASSWORD: names.passwordSecretName };
  const body = { tenantId: i.tenantId, stampId: i.stampId, names, env, secretRefs, overrides, partitioning: true as const };
  const revision = createHash('sha256').update(canonical(body)).digest('hex');
  return { ...body, revision };
}
