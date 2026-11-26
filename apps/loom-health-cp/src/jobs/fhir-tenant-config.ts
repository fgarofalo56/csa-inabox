// Per-tenant FHIR engine configuration (W2-2): the tenant-VARYING half of the engine's settings.
//
// The tenant-independent policy (partition mode, referential integrity, validation, versioning,
// destructive paths off) is apps/loom-health-fhir/config/application.yaml, loaded by every engine. What
// differs per tenant is rendered here as environment variables, which Spring binds over the file:
// the datasource (the tenant's own database on the stamp server, its own role), the pool, the caps, the
// interceptor list and the plugin's env. The rendering is a PURE function: the same inputs always give the
// same output and the same revision hash, which is what makes fhir-tenant.create idempotent.
//
// NO SECRET exists to render. The engine reaches PostgreSQL PASSWORDLESS (#5422 decision 9): its pod carries a
// workload-identity token for the tenant's own UAMI, and the baked azure-identity-extensions JDBC plugin turns that
// token into the connection credential. The datasource therefore has a username (the UAMI name = the PG Entra
// principal) and no credential property at all.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tenantFhirBase } from '../pdp/pdp-stamp-data.js';
import type { FhirIdentity as TenantFhirIdentity } from './tenant-arm.js';
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

/** One admitted ingress peer: a `from` entry of the engine NetworkPolicy. Selectors are required so no peer can widen to "every pod". */
export interface IngressPeer {
  namespaceSelector: { matchLabels: Record<string, string> };
  podSelector?: { matchLabels: Record<string, string> };
}

/**
 * Peers admitted to an engine today (#5441). Measured 2026-11-23:
 *  - `aks-command`: the pod `az aks command invoke` / ARM runCommand starts, where the B3 CRUD probe curls the engine Service
 *    (.github/workflows/lhds-fhir-crud-probe.yml:21,268).
 *  - `kube-system` konnectivity-agent: the CP's probeEngine reads /metadata through the API server service proxy, and AKS tunnels
 *    API-server-to-pod traffic through konnectivity-agent. NOT verified live against a policy yet: the live-verify plan is the probe
 *    (engine_probe ready=true) after the CP roll; a wrong label shows up as ready=false, never as an opened door.
 * The FHIR edge (#5410, G1) is NOT one of these: it is the stamp edge router (platform/fiab/bicep/modules/health/edge-router.bicep),
 * admitted through `edgePeers` (ENGINE_EDGE_PEERS below), never by widening these.
 */
export const COMMAND_NAMESPACE = 'aks-command';
export const ENGINE_INGRESS_PEERS: readonly IngressPeer[] = [
  { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': COMMAND_NAMESPACE } } },
  { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { app: 'konnectivity-agent' } } },
];

/**
 * The stamp FHIR edge router (G1): the nginx pods behind the App Gateway's internal-LB address, which forward
 * `/{tenant}/fhir/*` to `fhir-{tenant}.loom-health.svc`. The namespace and pod label MUST equal what edge-router.bicep renders
 * (edgeNamespace / edgeAppLabel); scripts/ci/__tests__/lhds-edge-router.test.mjs lifts both and compares. The router does no
 * authorization: the engine's PDP interceptor is the tenant boundary, so admitting it opens no path the token check does not guard.
 */
export const EDGE_NAMESPACE = 'loom-health-edge';
export const EDGE_APP_LABEL = 'loom-health-edge';
export const EDGE_ROUTER_PEER: IngressPeer = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': EDGE_NAMESPACE } },
  podSelector: { matchLabels: { app: EDGE_APP_LABEL } },
};
/** The edge peers the production host passes to every engine NetworkPolicy (fhir-engine-host.ts applyEngineConfig). */
export const ENGINE_EDGE_PEERS: readonly IngressPeer[] = [EDGE_ROUTER_PEER];

/**
 * The revision term for the engine NetworkPolicy's peer list: sha256 of the canonical JSON of EXACTLY the list the policy renders
 * (base peers, then edge peers). Without it the revision did not move when a peer was added (#5481), applyAndVerify skipped the apply,
 * and an engine created earlier kept a policy that drops the new peer. Derived, not a hand-kept version number.
 */
export function ingressPeersTerm(peers: readonly IngressPeer[] = [...ENGINE_INGRESS_PEERS, ...ENGINE_EDGE_PEERS]): string {
  return createHash('sha256').update(canonical(peers)).digest('hex');
}

export interface FhirNames {
  databaseName: string;
  /** Kubernetes name of the engine's ServiceAccount, Deployment and Service, in the `loom-health` namespace. */
  workloadName: string;
}

/** `lhds_acme_health` (database, same derivation as tenant.bicep) / `fhir-acme-health` (the ServiceAccount the federated credential names). */
export function fhirNames(slug: string): FhirNames {
  return { databaseName: `lhds_${slug.replaceAll('-', '_')}`, workloadName: `fhir-${slug}` };
}

/**
 * The tenant's dedicated FHIR identity: the `fhirIdentity` of the tenant manifest (tenant-arm.ts, B2a), which parses it fail-closed
 * and validates the GUIDs. `name` is both the UAMI name and the PostgreSQL Entra principal name; `clientId` goes on the
 * ServiceAccount annotation; `principalId` is the Entra object id the PG principal is bound to.
 */
export type FhirIdentity = Pick<TenantFhirIdentity, 'name' | 'clientId' | 'principalId'>;

/** Names are interpolated into SQL and shell by the host, so the name shape is re-checked where it is rendered. */
export const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** The datasource plugin baked into the engine image by lane B2b. */
export const JDBC_AUTH_PLUGIN = 'com.azure.identity.extensions.jdbc.postgresql.AzurePostgresqlAuthenticationPlugin';

/**
 * A facility partition the engine must hold (ADR-003, #5422 decision 11). The control plane ASSIGNS the id; the engine creates the row in-process
 * at startup (plugin `ai.loom.health.fhir.partition`), so id and name are both part of the engine's config revision.
 */
export interface PartitionSpec {
  id: number;
  name: string;
}

/** Shared by the job input schema, the renderer and (identically) the plugin's DesiredPartitions.NAME. */
export const PARTITION_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
/** HAPI's built-in default partition is id 0 named DEFAULT; a tenant partition may be neither. */
export const RESERVED_PARTITION_NAME = 'default';

/** Strict validation of the list that is rendered into the engine's environment. Throws before anything is rendered. */
export function assertPartitions(list: PartitionSpec[]): void {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const p of list) {
    if (!Number.isInteger(p.id) || p.id < 1 || p.id > 2_147_483_647) {
      throw new JobFailure('bad_partition', `refusing partition id ${String(p.id)}: ids are integers from 1 (0 is the engine's default partition); nothing was rendered`);
    }
    if (typeof p.name !== 'string' || !PARTITION_NAME.test(p.name) || p.name.toLowerCase() === RESERVED_PARTITION_NAME) {
      throw new JobFailure('bad_partition', 'refusing a partition name that does not match the facility name pattern or is the reserved default; nothing was rendered');
    }
    if (ids.has(p.id) || names.has(p.name)) throw new JobFailure('bad_partition', 'refusing a partition list that repeats an id or a name; nothing was rendered');
    ids.add(p.id);
    names.add(p.name);
  }
}

/**
 * The partitions a tenant is known to hold, DATABASE authoritative over the Deployment annotation (auto-bind-by-default section 3: a lost or
 * pre-existing Deployment must not make ids be reissued over rows that exist). Every database row is kept as it is. An annotation entry whose
 * name is already a row is the row's (the row's id wins); one whose id is taken by a different row cannot keep that id and comes back in
 * `reassign`, to be given a fresh id; any other annotation entry is kept (not created yet).
 */
export function reconcileExisting(annotation: PartitionSpec[], db: PartitionSpec[]): { existing: PartitionSpec[]; reassign: string[] } {
  const existing = db.map((p) => ({ id: p.id, name: p.name }));
  const reassign: string[] = [];
  for (const a of annotation) {
    if (existing.some((p) => p.name === a.name)) continue;
    if (existing.some((p) => p.id === a.id)) reassign.push(a.name);
    else existing.push({ id: a.id, name: a.name });
  }
  return { existing, reassign };
}

/**
 * The desired list for a tenant: what the running engine already carries (ids never change, nothing is ever dropped, the engine cannot
 * delete or rename) plus any requested name not yet present, which takes the next free id.
 */
export function mergePartitions(existing: PartitionSpec[], requested: string[]): PartitionSpec[] {
  const out = existing.map((p) => ({ id: p.id, name: p.name }));
  let next = out.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  for (const name of requested) {
    if (!out.some((p) => p.name === name)) out.push({ id: next++, name });
  }
  return out;
}

export interface RenderInput {
  tenantId: string;
  stampId: string;
  /** Stamp PostgreSQL server FQDN from the stamp manifest (`postgresFqdn`). */
  postgresFqdn: string;
  /** The tenant's FHIR identity: the datasource user and the ServiceAccount's workload-identity client id. */
  identity: FhirIdentity;
  maxRequestsPerMinute: number;
  /**
   * The stamp's public base URL (the registry's `stamp.baseUrl`, the value the routing map and the PDP bundle's `bases` are built from).
   * The engine pins `<stampBaseUrl>/<tenant>/fhir` as its server address so the base it sends the PDP equals the token `aud` (decision 13).
   */
  stampBaseUrl: string;
  /**
   * In-cluster PDP BASE url (W1-5), no path: the plugin appends `/v1/data/lhds/authz/decision` (HttpPdpClient.DECISION_PATH).
   * Required: the plugin answers 503 to every request without it.
   */
  pdpUrl: string;
  overrides?: EngineOverrides;
  /** The partitions the engine must hold. Never shrinks (see mergePartitions). */
  partitions?: PartitionSpec[];
  /** The stamp PG administrator role (`pgAdminIdentity.name`): the engine grants it SELECT on the partition table, nothing else. */
  pgAdminName: string;
  /** The NetworkPolicy peer list hashed into the revision. Defaults to what the production host renders; tests vary it. */
  ingressPeers?: readonly IngressPeer[];
  /**
   * The engine image reference the host renders into the Deployment (FhirEngineHost.engineImage; production passes it on every render,
   * fhir-tenant-jobs.ts render()). Hashed into the revision, not returned in the body: deploy-health pins LOOM_HEALTH_CP_FHIR_IMAGE by
   * digest (#5439), so a new FHIR build plus a deploy changes this string, every engine's revision moves, and the drift reconciler
   * (#5486) re-applies every engine, existing ones included. Without it a new image never reached a running engine.
   */
  engineImage?: string;
}

export interface RenderedEngineConfig {
  tenantId: string;
  stampId: string;
  names: FhirNames;
  /** The identity the engine pod runs as (workload identity). Part of the revision: a re-created identity re-applies. */
  identity: FhirIdentity;
  /** Plain environment for the engine container. Holds no credential and no secret reference. */
  env: Record<string, string>;
  overrides: EngineOverrides;
  /** Partition mode is a creation-time property of the database (ADR-003). Always true here. */
  partitioning: true;
  /** Desired partitions, sorted by id. Rendered into LOOM_HEALTH_PARTITIONS, so a change is a new revision and rolls the pod. */
  partitions: PartitionSpec[];
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
  if (pdp.pathname !== '/') {
    // B3 probe run 45201088369: the full decision endpoint here made the plugin call <endpoint>/v1/data/lhds/authz/decision,
    // OPA answered an undefined document (200, no result) and every token-bearing request was a 503.
    throw new JobFailure('pdp_url_invalid', 'the PDP url must be the OPA base url with no path (the engine appends /v1/data/lhds/authz/decision itself); with a path every token-bearing request is answered 503, so no engine is configured. Fix LOOM_HEALTH_CP_PDP_URL (health.bicep pdpBaseUrl) and re-run');
  }
  let stampBase: URL;
  try {
    stampBase = new URL(i.stampBaseUrl);
  } catch {
    throw new JobFailure('stamp_base_url_invalid', `the stamp ${i.stampId} has no usable base URL (got ${i.stampBaseUrl ? 'a value that is not a URL' : 'nothing'}); the engine cannot be told its public FHIR base, so every token would be refused and no engine is configured. Set the stamp baseUrl (PATCH /api/health/stamps/${i.stampId}) and re-run`);
  }
  if (stampBase.protocol !== 'https:' || stampBase.username || stampBase.hash || stampBase.search || stampBase.href.includes('@')) {
    throw new JobFailure('stamp_base_url_invalid', `the stamp ${i.stampId} base URL must be https without credentials, query or fragment; no engine is configured`);
  }
  if (!IDENTITY_NAME.test(i.identity.name)) {
    throw new JobFailure('fhir_identity_invalid', 'the tenant FHIR identity has an invalid name; the engine cannot be bound to it, so no engine is configured');
  }
  if (!IDENTITY_NAME.test(i.pgAdminName)) {
    throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no valid pgAdminIdentity.name (lane B2a output); the engine cannot be told which role may read its partition table, so no engine is configured');
  }
  const partitions = [...(i.partitions ?? [])].map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.id - b.id);
  assertPartitions(partitions);
  const overrides = OverridesSchema.parse(i.overrides ?? {});
  const maxPage = overrides.maxPageSize ?? BASE_MAX_PAGE_SIZE;
  const defPage = overrides.defaultPageSize ?? Math.min(20, maxPage);
  if (defPage > maxPage) {
    throw new JobFailure('caps_invalid', `defaultPageSize ${defPage} exceeds maxPageSize ${maxPage}; nothing was changed`);
  }
  const names = fhirNames(i.tenantId);
  const pool = overrides.poolSize ?? poolSizeFor(i.maxRequestsPerMinute);
  const env: Record<string, string> = {
    // The tenant's OWN database on the stamp server; sslmode=require as W0 measured. The plugin fetches the Entra
    // token with the pod's workload identity and presents it as the connection credential; none is configured here.
    SPRING_DATASOURCE_URL: `jdbc:postgresql://${i.postgresFqdn}:5432/${names.databaseName}?sslmode=require&authenticationPluginClassName=${JDBC_AUTH_PLUGIN}`,
    SPRING_DATASOURCE_USERNAME: i.identity.name,
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
    // Decision 13: the engine's PUBLIC base, byte-for-byte the bundle base and the token aud. The HAPI jpaserver-starter turns
    // hapi.fhir.server_address into a HardcodedServerAddressStrategy; the plugin sends that base (minus the facility partition) as `base`.
    HAPI_FHIR_SERVER_ADDRESS: tenantFhirBase(i.stampBaseUrl, i.tenantId),
    LOOM_HEALTH_TENANT: i.tenantId,
    LOOM_HEALTH_PDP_URL: pdp.toString().replace(/\/$/, ''),
    LOOM_HEALTH_PDP_TIMEOUT_MS: '1500',
    // Decision 11: the engine reconciles its own partitions at startup (in-process, no HTTP, no auth exemption) and then grants SELECT on
    // hfj_partition to this role. Canonical JSON, keys id then name, sorted by id: the same list is always the same bytes.
    LOOM_HEALTH_PARTITIONS: JSON.stringify(partitions),
    LOOM_HEALTH_PG_ADMIN_ROLE: i.pgAdminName,
  };
  const identity = { name: i.identity.name, clientId: i.identity.clientId, principalId: i.identity.principalId };
  const body = { tenantId: i.tenantId, stampId: i.stampId, names, identity, env, overrides, partitioning: true as const, partitions };
  // The NetworkPolicy peer list is in the revision but not in the returned body: it is not engine config, it is what the host
  // renders beside it. A peer change therefore re-applies (and, through the pod-template revision annotation, restarts) every engine once.
  // The engine image is in the revision for the same reason (#5439): a new digest re-applies and restarts every engine once.
  const revision = createHash('sha256')
    .update(canonical({ ...body, ingressPeers: ingressPeersTerm(i.ingressPeers), engineImage: i.engineImage ?? '' }))
    .digest('hex');
  return { ...body, revision };
}
