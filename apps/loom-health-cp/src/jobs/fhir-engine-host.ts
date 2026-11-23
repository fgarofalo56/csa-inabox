// Production FhirEngineHost (LHDS W2-2b B2c): delivers a per-tenant HAPI FHIR engine to the PRIVATE stamp AKS
// through ARM managedClusters/runCommand (aks-run-command.ts), kubectl running as the control-plane UAMI.
//
// What the control plane may do there is exactly the ClusterRole `edit` in namespace `loom-health` (engines.bicep):
// namespaced objects only, no Namespaces, no RBAC objects. Everything below stays inside that. In particular the
// PostgreSQL principal is NOT created by this identity: it applies a Job that runs as the ServiceAccount
// `lhds-pg-admin`, which is federated to the stamp UAMI that is a PG Entra administrator (#5422 decision 10).
//
// Every result is read back (deploy-integrity R6/R7): an error states what kubectl/psql printed and what is NOT
// established; output is excerpted, masked and bounded before it reaches a job message.

import { randomBytes } from 'node:crypto';
import { assertPartitions, fhirNames, IDENTITY_NAME, type EngineOverrides, type PartitionSpec, type RenderedEngineConfig } from './fhir-tenant-config.js';
import type { AppliedEngineConfig, EngineProbe, FhirEngineHost, RoleReadback } from './fhir-tenant-jobs.js';
import type { AksRunCommand, AksTarget, RunCommandResult } from './aks-run-command.js';
import { classifyArm, stampResourceGroup, type TenantArm } from './tenant-arm.js';
import type { StampDoc, TenantDoc } from '../registry/types.js';
import type { Collection } from '../store/types.js';
import { JobFailure } from './types.js';

export const ENGINE_NAMESPACE = 'loom-health';
/** The stamp-wide ServiceAccount federated to the PG administrator UAMI (B2a, stamp manifest). */
export const PG_ADMIN_SERVICE_ACCOUNT = 'lhds-pg-admin';
export const ENGINE_PORT = 8080;
export const SERVICE_PORT = 80;
export const ANN_REVISION = 'loom.health/engine-revision';
export const ANN_OVERRIDES = 'loom.health/engine-overrides';
export const ANN_PARTITIONING = 'loom.health/partitioning';
/** The desired partition list the Deployment was rendered with (canonical JSON): what readEngineConfig hands back so a re-run never shrinks it. */
export const ANN_PARTITIONS = 'loom.health/partitions';
/** HAPI 8.12 `PartitionEntity` is `@Table(name = "HFJ_PARTITION")` with columns PART_ID / PART_NAME (measured by config/probe/engine-config-probe.sh); PostgreSQL folds them to lower case. */
export const PARTITION_TABLE = 'hfj_partition';
const DEFAULT_ROLLOUT_SECONDS = 240;

/** Everything about the stamp the host needs that the job port does not carry. */
export interface EngineTarget extends AksTarget {
  postgresFqdn: string;
  /** Name of the stamp's PG administrator UAMI (the PG user the Job connects as). */
  pgAdminName: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const DB_NAME = /^lhds_[a-z0-9_]{1,60}$/;
const FQDN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9.\-/:_]{0,200}@sha256:[0-9a-f]{64}$/;
/** A digest, or an explicit tag other than `latest`. An untagged reference means `latest`, so it is refused too. */
export function assertEngineImagePinned(image: string): void {
  if (image.includes('@sha256:')) return;
  const last = image.split('/').pop() ?? '';
  const tag = last.includes(':') ? last.split(':').pop() : '';
  if (!tag || tag.toLowerCase() === 'latest') {
    throw new JobFailure('fhir_image_unpinned', 'the FHIR engine image must carry an explicit tag other than latest, or a digest; an untagged or :latest reference can change under a running tenant');
  }
}

export interface RunCommandHostOptions {
  run: AksRunCommand;
  target: (tenantId: string) => Promise<EngineTarget>;
  /** Full image reference of the HAPI engine (lane B2b image), in the hub ACR. */
  fhirImage: string;
  /** Digest-pinned PG client image (psql + busybox wget), in the hub ACR. */
  pgClientImage: string;
  /** OAuth scope for Azure Database for PostgreSQL tokens in this cloud. */
  pgScope: string;
  namespace?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between polls of the PG Job status. */
  jobPollMs?: number;
  /** Polls before the PG Job is declared not finished (default 40 * 6 s). */
  jobMaxPolls?: number;
  rolloutSeconds?: number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

// ── pure renderers (unit-tested) ─────────────────────────────────────────────

/** Bounded, masked, single-line excerpt of command output for a job message. */
export function excerpt(text: string, max = 400): string {
  const flat = text
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function envList(env: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.keys(env)
    .sort()
    .map((name) => ({ name, value: env[name] as string }));
}

/** ServiceAccount + Deployment + Service of one tenant engine, as a kubectl `List` (JSON is valid YAML). */
export function renderEngineManifest(cfg: RenderedEngineConfig, o: { image: string; namespace: string }): string {
  const { workloadName: name } = fhirNames(cfg.tenantId);
  const labels = { app: name, 'app.kubernetes.io/managed-by': 'loom-health-cp', 'loom.health/tenant': cfg.tenantId };
  const list = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name, namespace: o.namespace, labels, annotations: { 'azure.workload.identity/client-id': cfg.identity.clientId } },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name,
          namespace: o.namespace,
          labels,
          annotations: { [ANN_REVISION]: cfg.revision, [ANN_OVERRIDES]: JSON.stringify(cfg.overrides), [ANN_PARTITIONING]: String(cfg.partitioning), [ANN_PARTITIONS]: JSON.stringify(cfg.partitions) },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name, 'azure.workload.identity/use': 'true', 'loom.health/tenant': cfg.tenantId }, annotations: { [ANN_REVISION]: cfg.revision } },
            spec: {
              serviceAccountName: name,
              securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [
                {
                  name: 'hapi',
                  image: o.image,
                  env: envList(cfg.env),
                  ports: [{ name: 'http', containerPort: ENGINE_PORT }],
                  resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
                  securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                  volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
                  startupProbe: { httpGet: { path: '/fhir/metadata', port: ENGINE_PORT }, periodSeconds: 10, failureThreshold: 30 },
                  readinessProbe: { httpGet: { path: '/fhir/metadata', port: ENGINE_PORT }, periodSeconds: 10, timeoutSeconds: 5 },
                  livenessProbe: { httpGet: { path: '/fhir/metadata', port: ENGINE_PORT }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
                },
              ],
              volumes: [{ name: 'tmp', emptyDir: {} }],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace: o.namespace, labels },
        spec: { type: 'ClusterIP', selector: { app: name }, ports: [{ name: 'http', port: SERVICE_PORT, targetPort: 'http' }] },
      },
    ],
  };
  return JSON.stringify(list);
}

/** One psql step: the database it runs in and the SQL. */
export interface PgStep {
  db: string;
  sql: string;
  /** Run the step only if this database exists (checked in `postgres` first); otherwise print LOOM_SKIPPED_<n>=database_absent. */
  requireDb?: string;
}

function assertPgNames(principal: string, db?: string): void {
  if (!IDENTITY_NAME.test(principal)) throw new JobFailure('bad_principal_name', 'refusing a malformed PostgreSQL principal name; nothing was sent');
  if (db !== undefined && !DB_NAME.test(db)) throw new JobFailure('bad_database_name', 'refusing a malformed tenant database name; nothing was sent');
}

/**
 * Create-if-missing, then CONNECT on the tenant database only. Isolation: PUBLIC's default CONNECT is revoked on every
 * `lhds_*` database (the principal inherits PUBLIC, so a role-level grant alone cannot confine it) and the stamp admin
 * group keeps its own access. The create is `pg_catalog.pgaadauth_create_principal_with_oid`, bound to the exact object id (no by-name directory lookup, which can be
 * ambiguous and needs Graph egress); it errors when the role exists, so it is guarded.
 * Role bindings are recorded as `SECURITY LABEL FOR "pgaadauth" ON ROLE ... IS 'aadauth,oid=<objectId>,type=<objectType>[,admin]'`
 * (https://learn.microsoft.com/azure/postgresql/security/security-manage-entra-users).
 */
export function ensurePrincipalSteps(principal: string, db: string, principalId: string): PgStep[] {
  assertPgNames(principal, db);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principalId)) throw new JobFailure('bad_principal_id', 'refusing a malformed Entra object id; nothing was sent');
  return [
    {
      db: 'postgres',
      sql: [
        // A role of this name bound to ANOTHER Entra object id is a stale one from a destroyed tenant (the re-created UAMI has the
        // same name and a new object id). Replace it: DROP ROLE refuses while the role owns or is granted anything, so a live
        // role that was misread as stale fails closed with psql's own message instead of losing data.
        `DO $do$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${principal}') AND NOT EXISTS (SELECT 1 FROM pg_seclabels WHERE provider = 'pgaadauth' AND objtype = 'role' AND objname = '${principal}' AND label LIKE '%oid=${principalId.toLowerCase()}%') THEN DROP ROLE "${principal}"; END IF; END $do$;`,
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${principal}') THEN PERFORM pg_catalog.pgaadauth_create_principal_with_oid('${principal}', '${principalId.toLowerCase()}', 'service', false, false); END IF; END $do$;`,
        `DO $do$ DECLARE d text; BEGIN FOR d IN SELECT datname FROM pg_database WHERE datname LIKE 'lhds\\_%' LOOP EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d); EXECUTE format('GRANT CONNECT ON DATABASE %I TO azure_pg_admin', d); END LOOP; END $do$;`,
        `GRANT CONNECT ON DATABASE "${db}" TO "${principal}";`,
      ].join('\n'),
    },
    { db, sql: `GRANT USAGE, CREATE ON SCHEMA public TO "${principal}";` },
  ];
}

/** Print the principal's existence and every application database it can CONNECT to (postgres + azure_* are system, not tenant data). */
export function readPrincipalSteps(principal: string): PgStep[] {
  assertPgNames(principal);
  const exists = `EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${principal}')`;
  return [
    {
      db: 'postgres',
      sql: [
        `SELECT 'LOOM_ROLE_EXISTS=' || CASE WHEN ${exists} THEN 't' ELSE 'f' END;`,
        `SELECT 'LOOM_ROLE_DB=' || datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND datname <> 'postgres' AND datname NOT LIKE 'azure\\_%' AND CASE WHEN ${exists} THEN has_database_privilege('${principal}', oid, 'CONNECT') ELSE false END ORDER BY datname;`,
      ].join('\n'),
    },
  ];
}

/** Ownership moves to the admin group (data kept), then the principal's privileges and the role go. */
export function removePrincipalSteps(principal: string, db: string): PgStep[] {
  assertPgNames(principal, db);
  const has = `EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${principal}')`;
  return [
    // The tenant database is dropped by tenant.destroy BEFORE a retried teardown can run: step 1 is skipped when it is gone and DROP ROLE still runs.
    { db, requireDb: db, sql: `DO $do$ BEGIN IF ${has} THEN REASSIGN OWNED BY "${principal}" TO azure_pg_admin; DROP OWNED BY "${principal}"; END IF; END $do$;` },
    { db: 'postgres', sql: `DO $do$ BEGIN IF ${has} THEN DROP ROLE "${principal}"; END IF; END $do$;` },
  ];
}

/** The shell the PG Job runs: token via the workload-identity federated token, then psql per step. The token is never printed. */
export function pgJobScript(steps: PgStep[]): string {
  const lines = [
    'set -eu',
    'AUTH="${AZURE_AUTHORITY_HOST%/}"',
    'RESP=$(wget -O - --post-data "client_id=${AZURE_CLIENT_ID}&grant_type=client_credentials&scope=${LOOM_PG_SCOPE_ENC}&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=$(cat "$AZURE_FEDERATED_TOKEN_FILE")" "$AUTH/$AZURE_TENANT_ID/oauth2/v2.0/token") || { echo "LOOM_ERR=token_request_failed"; exit 11; }',
    "TOKEN=$(printf '%s' \"$RESP\" | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')",
    '[ -n "$TOKEN" ] || { echo "LOOM_ERR=no_access_token"; exit 12; }',
    'export PGPASSWORD="$TOKEN"',
  ];
  steps.forEach((step, k) => {
    const i = k + 1;
    const run = `printf '%s\\n' "$LOOM_SQL_${i}" | psql -X -q -v ON_ERROR_STOP=1 -At -d "$LOOM_DB_${i}" -f -`;
    if (step.requireDb) {
      lines.push(
        `if [ "$(psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$LOOM_REQ_DB_${i}'")" = "1" ]; then ${run}; else echo "LOOM_SKIPPED_${i}=database_absent"; fi`,
      );
    } else lines.push(run);
  });
  lines.push('echo LOOM_PG_DONE=1');
  return lines.join('\n');
}

/**
 * The /metadata probe, run through runCommand in the AKS command pod. That pod is distroless; measured on aks-lhds-dev01
 * 2026-11-23 it HAS sh grep head cut cat tr awk kubectl curl and has NO sed (the first live probe died on
 * "sed: not found", exit 127, W2-2b B3 run 45134282351). So only those tools appear here, and the version is cut out
 * by field (`"fhirVersion" : "4.0.1"` splits on `"` with the value in field 4). The script always exits 0 once
 * kubectl has answered; what it found is carried in the LOOM_* markers, which probeEngine parses.
 */
export function engineProbeScript(base: string): string {
  return [
    'set -u',
    `kubectl get --raw '${base}/metadata' > /tmp/m.json 2> /tmp/m.err; RC=$?`,
    'echo "LOOM_PROBE_RC=$RC"',
    'if [ "$RC" -ne 0 ]; then head -c 400 /tmp/m.err; exit 0; fi',
    `if grep -q '"resourceType" *: *"CapabilityStatement"' /tmp/m.json; then echo LOOM_CAPABILITY=1; fi`,
    `V=$(grep -o '"fhirVersion" *: *"[^"]*"' /tmp/m.json | head -n 1 | cut -d '"' -f 4)`,
    'if [ -n "$V" ]; then echo "LOOM_FHIR_VERSION=$V"; fi',
  ].join('\n');
}

export function renderPgJobManifest(i: {
  jobName: string;
  namespace: string;
  tenantId: string;
  image: string;
  postgresFqdn: string;
  pgAdminName: string;
  pgScope: string;
  steps: PgStep[];
}): string {
  const env: Array<{ name: string; value: string }> = [
    { name: 'PGHOST', value: i.postgresFqdn },
    { name: 'PGPORT', value: '5432' },
    { name: 'PGUSER', value: i.pgAdminName },
    { name: 'PGSSLMODE', value: 'require' },
    { name: 'LOOM_PG_SCOPE_ENC', value: encodeURIComponent(i.pgScope) },
    ...i.steps.flatMap((s, n) => [
      { name: `LOOM_DB_${n + 1}`, value: s.db },
      { name: `LOOM_SQL_${n + 1}`, value: s.sql },
      ...(s.requireDb ? [{ name: `LOOM_REQ_DB_${n + 1}`, value: s.requireDb }] : []),
    ]),
  ];
  return JSON.stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: i.jobName, namespace: i.namespace, labels: { 'app.kubernetes.io/managed-by': 'loom-health-cp', 'loom.health/tenant': i.tenantId } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 180,
      // Backstop only: the host deletes the Job itself. If that delete fails the finished Job still ages out.
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'azure.workload.identity/use': 'true', 'loom.health/tenant': i.tenantId } },
        spec: {
          serviceAccountName: PG_ADMIN_SERVICE_ACCOUNT,
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 70, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'psql',
              image: i.image,
              command: ['/bin/sh', '-c'],
              args: [pgJobScript(i.steps)],
              env,
              resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: {} }],
        },
      },
    },
  });
}

/** `kubectl apply -f -` of a manifest passed inline (no zip context needed for a few KB). */
function applyCommand(manifest: string, extra = ''): string {
  const delim = 'LOOM_MANIFEST_EOF';
  if (manifest.includes(delim)) throw new JobFailure('manifest_unsafe', 'the rendered manifest contains the heredoc delimiter; nothing was sent');
  return `set -e\nkubectl apply -f - <<'${delim}'\n${manifest}\n${delim}\necho LOOM_APPLIED=1${extra ? `\n${extra}` : ''}`;
}

/**
 * Read the tenant database's partition table. HAPI creates it in the tenant's OWN database; the engine grants SELECT on it (and only it) to the
 * stamp PG administrator at startup (#5422 decision 11), which is who the Job connects as. No HTTP is involved: the engine's PDP answers 401 to
 * anything but /metadata, and that is not changed.
 */
export function readPartitionSteps(db: string): PgStep[] {
  if (!DB_NAME.test(db)) throw new JobFailure('bad_database_name', 'refusing a malformed tenant database name; nothing was sent');
  return [{ db, sql: `SELECT 'LOOM_PARTITION=' || part_id || ':' || part_name FROM ${PARTITION_TABLE} ORDER BY part_id;` }];
}

/** `LOOM_PARTITION=<id>:<name>` lines of the Job's output. Anything else is ignored (it is not a partition row). */
export function parsePartitionRows(logs: string): PartitionSpec[] {
  const out: PartitionSpec[] = [];
  for (const m of logs.matchAll(/^LOOM_PARTITION=(\d+):(\S+)$/gm)) out.push({ id: Number(m[1]), name: m[2] as string });
  return out;
}

const hfjRead = (n: number): string => `${PARTITION_TABLE} was read (${n} row${n === 1 ? '' : 's'})`;

export interface PartitionComparison {
  /** Desired, and no row has that name or that id. */
  missing: PartitionSpec[];
  /** Desired, but a row has the same name under another id, or the same id under another name. */
  conflicting: Array<{ want: PartitionSpec; found: PartitionSpec }>;
}

/** Every desired partition must exist with the desired id AND name. Extra rows are not a mismatch: the engine never deletes one. */
export function comparePartitions(desired: PartitionSpec[], found: PartitionSpec[]): PartitionComparison {
  const missing: PartitionSpec[] = [];
  const conflicting: PartitionComparison['conflicting'] = [];
  for (const want of desired) {
    if (found.some((f) => f.id === want.id && f.name === want.name)) continue;
    const clash = found.find((f) => f.id === want.id || f.name === want.name);
    if (clash) conflicting.push({ want, found: clash });
    else missing.push(want);
  }
  return { missing, conflicting };
}

// ── the host ─────────────────────────────────────────────────────────────────

export class RunCommandFhirEngineHost implements FhirEngineHost {
  private readonly ns: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (event: string, fields: Record<string, string | number>) => void;

  constructor(private readonly o: RunCommandHostOptions) {
    assertEngineImagePinned(o.fhirImage);
    if (!IMAGE_BY_DIGEST.test(o.pgClientImage)) throw new JobFailure('pg_client_image_unpinned', 'the PG client image must be pinned by digest (name@sha256:<64 hex>)');
    this.ns = o.namespace ?? ENGINE_NAMESPACE;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? (() => {});
  }

  private async resolve(tenantId: string): Promise<EngineTarget> {
    if (!SLUG.test(tenantId)) throw new JobFailure('bad_tenant_id', 'refusing a malformed tenant id; nothing was sent');
    const t = await this.o.target(tenantId);
    if (!FQDN.test(t.postgresFqdn)) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest postgresFqdn is not a host name');
    if (!IDENTITY_NAME.test(t.pgAdminName)) {
      throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no valid pgAdminIdentity.name (lane B2a output); the PostgreSQL principal job cannot run as the stamp PG administrator');
    }
    return t;
  }

  /** kubectl output -> a JobFailure that says what kubectl printed, never why. */
  private failure(code: string, what: string, r: RunCommandResult): JobFailure {
    const forbidden = /forbidden|unauthorized/i.test(r.logs);
    return new JobFailure(
      forbidden ? 'permission' : code,
      `${what} (kubectl exit ${r.exitCode}): ${excerpt(r.logs) || 'no output'}.${forbidden ? ' Kubernetes refused it. The control plane holds only the ClusterRole edit in namespace loom-health (RoleBinding loom-health-cp-edit); the refused verb and resource are named above.' : ''}`,
    );
  }

  // PostgreSQL principal, through a Job as lhds-pg-admin ───────────────────────

  private async runPgJob(tenantId: string, steps: PgStep[]): Promise<string> {
    const t = await this.resolve(tenantId);
    const jobName = `pgp-${tenantId}-${randomBytes(3).toString('hex')}`;
    const manifest = renderPgJobManifest({
      jobName, namespace: this.ns, tenantId, image: this.o.pgClientImage, postgresFqdn: t.postgresFqdn, pgAdminName: t.pgAdminName, pgScope: this.o.pgScope, steps,
    });
    const target: AksTarget = { resourceGroup: t.resourceGroup, cluster: t.cluster };
    const applied = await this.o.run.run(target, applyCommand(manifest));
    if (applied.exitCode !== 0) throw this.failure('pg_job_apply_failed', `applying the PostgreSQL job ${jobName} failed`, applied);
    try {
      const maxPolls = this.o.jobMaxPolls ?? 40;
      for (let n = 0; n < maxPolls; n++) {
        await this.sleep(this.o.jobPollMs ?? 6000);
        const st = await this.o.run.run(target, `kubectl get job/${jobName} -n ${this.ns} -o jsonpath='SUCCEEDED={.status.succeeded} FAILED={.status.failed}'`);
        if (st.exitCode !== 0) throw this.failure('pg_job_status_failed', `reading the status of the PostgreSQL job ${jobName} failed`, st);
        const done = /SUCCEEDED=1\b/.test(st.logs);
        const failed = /FAILED=[1-9]/.test(st.logs);
        if (!done && !failed) continue;
        const out = await this.o.run.run(
          target,
          `kubectl get pods -n ${this.ns} -l job-name=${jobName} -o jsonpath='EXIT={.items[0].status.containerStatuses[0].state.terminated.exitCode}{"\\n"}'\nkubectl logs -n ${this.ns} job/${jobName} --tail=200`,
        );
        if (out.exitCode !== 0) throw this.failure('pg_job_logs_failed', `reading the output of the PostgreSQL job ${jobName} failed`, out);
        if (failed || !/LOOM_PG_DONE=1/.test(out.logs)) {
          throw new JobFailure(
            'pg_job_failed',
            `the PostgreSQL job ${jobName} ${failed ? 'failed' : 'finished without its completion marker'} (${excerpt(out.logs.split('\n')[0] ?? '', 30)}). Its output: ${excerpt(out.logs.split('\n').slice(1).join(' ')) || 'none'}. Established: what the job printed. Not established: anything it did not print.`,
          );
        }
        return out.logs;
      }
      const why = await this.o.run.run(target, `kubectl get pods -n ${this.ns} -l job-name=${jobName} -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}'`);
      throw new JobFailure(
        'pg_job_timeout',
        `the PostgreSQL job ${jobName} did not finish within ${maxPolls} status polls. Pod waiting reason: ${excerpt(why.exitCode === 0 ? why.logs : `unreadable (kubectl exit ${why.exitCode})`, 120) || 'none reported'}. Whether the SQL ran is NOT established; it is idempotent, so retrying the job is safe.`,
      );
    } finally {
      try {
        const del = await this.o.run.run(target, `kubectl delete job/${jobName} -n ${this.ns} --ignore-not-found --wait=false`);
        if (del.exitCode !== 0) this.log('fhir_engine.pg_job_cleanup_failed', { job: jobName, exit: del.exitCode });
      } catch {
        // Never replaces the job's own result. The finished Job ages out (ttlSecondsAfterFinished).
        this.log('fhir_engine.pg_job_cleanup_failed', { job: jobName, exit: -1 });
      }
    }
  }

  async ensureDatabaseRole(i: { tenantId: string; databaseName: string; roleName: string; principalId: string }): Promise<void> {
    await this.runPgJob(i.tenantId, ensurePrincipalSteps(i.roleName, i.databaseName, i.principalId));
  }

  async readDatabaseRole(tenantId: string, roleName: string): Promise<RoleReadback> {
    const logs = await this.runPgJob(tenantId, readPrincipalSteps(roleName));
    const ex = /^LOOM_ROLE_EXISTS=([tf])$/m.exec(logs);
    if (!ex) throw new JobFailure('pg_job_unproven', 'the PostgreSQL read-back job completed but printed no LOOM_ROLE_EXISTS line, so whether the principal exists is NOT established');
    const dbs = [...logs.matchAll(/^LOOM_ROLE_DB=(\S+)$/gm)].map((m) => m[1] as string);
    return { exists: ex[1] === 't', connectableDatabases: dbs };
  }

  async removeDatabaseRole(tenantId: string, roleName: string): Promise<void> {
    await this.runPgJob(tenantId, removePrincipalSteps(roleName, fhirNames(tenantId).databaseName));
  }

  // The engine workload ─────────────────────────────────────────────────────────

  async applyEngineConfig(cfg: RenderedEngineConfig): Promise<void> {
    const t = await this.resolve(cfg.tenantId);
    const name = fhirNames(cfg.tenantId).workloadName;
    const manifest = renderEngineManifest(cfg, { image: this.o.fhirImage, namespace: this.ns });
    const secs = this.o.rolloutSeconds ?? DEFAULT_ROLLOUT_SECONDS;
    const r = await this.o.run.run(t, applyCommand(manifest, `kubectl rollout status deployment/${name} -n ${this.ns} --timeout=${secs}s`));
    if (r.exitCode === 0) return;
    if (!r.logs.includes('LOOM_APPLIED=1')) throw this.failure('engine_apply_failed', `applying the engine manifest for ${cfg.tenantId} failed`, r);
    throw this.failure(
      'engine_rollout_failed',
      `the engine manifest for ${cfg.tenantId} was applied but deployment/${name} did not finish rolling out within ${secs} s; the cause is NOT established`,
      r,
    );
  }

  async readEngineConfig(tenantId: string): Promise<AppliedEngineConfig | undefined> {
    const t = await this.resolve(tenantId);
    const name = fhirNames(tenantId).workloadName;
    const jp = `'FOUND={.metadata.name}{"\\n"}REV={.metadata.annotations.loom\\.health/engine-revision}{"\\n"}PART={.metadata.annotations.loom\\.health/partitioning}{"\\n"}OVR={.metadata.annotations.loom\\.health/engine-overrides}{"\\n"}PARTS={.metadata.annotations.loom\\.health/partitions}{"\\n"}'`;
    const r = await this.o.run.run(t, `kubectl get deployment/${name} -n ${this.ns} --ignore-not-found -o jsonpath=${jp}`);
    if (r.exitCode !== 0) throw this.failure('engine_read_failed', `reading deployment/${name} failed`, r);
    if (!/^FOUND=\S+$/m.test(r.logs)) return undefined;
    const rev = /^REV=(\S*)$/m.exec(r.logs)?.[1] ?? '';
    if (!rev) {
      throw new JobFailure('engine_unmanaged', `deployment/${name} exists in ${this.ns} but carries no ${ANN_REVISION} annotation, so it was not applied by this control plane; nothing was changed`);
    }
    let overrides: EngineOverrides = {};
    const ovr = /^OVR=(.*)$/m.exec(r.logs)?.[1] ?? '';
    if (ovr) {
      try {
        overrides = JSON.parse(ovr) as EngineOverrides;
      } catch {
        throw new JobFailure('engine_unmanaged', `deployment/${name} carries an unreadable ${ANN_OVERRIDES} annotation; nothing was changed`);
      }
    }
    // No annotation = a Deployment rendered before the list existed: it carries no partitions.
    let partitions: PartitionSpec[] = [];
    const parts = /^PARTS=(.*)$/m.exec(r.logs)?.[1] ?? '';
    if (parts) {
      try {
        partitions = JSON.parse(parts) as PartitionSpec[];
        assertPartitions(partitions);
      } catch {
        throw new JobFailure('engine_unmanaged', `deployment/${name} carries an unreadable ${ANN_PARTITIONS} annotation; nothing was changed, because re-rendering from it could drop a partition`);
      }
    }
    return { revision: rev, overrides, partitioning: /^PART=true$/m.test(r.logs), partitions };
  }

  async probeEngine(tenantId: string, opts?: { partitions?: boolean }): Promise<EngineProbe> {
    const t = await this.resolve(tenantId);
    const base = `/api/v1/namespaces/${this.ns}/services/${fhirNames(tenantId).workloadName}:${SERVICE_PORT}/proxy/fhir`;
    // /metadata is the only path the engine answers without a bearer token. Partitions are NOT read over HTTP: see readPartitions().
    const r = await this.o.run.run(t, engineProbeScript(base));
    if (r.exitCode !== 0) throw this.failure('engine_probe_failed', `probing ${fhirNames(tenantId).workloadName} through the API server proxy failed`, r);
    const rc = /^LOOM_PROBE_RC=(\d+)$/m.exec(r.logs)?.[1];
    if (rc === undefined) throw new JobFailure('engine_probe_unproven', 'the probe command printed no exit marker, so whether the engine answered is NOT established');
    if (rc !== '0') {
      if (/forbidden|unauthorized/i.test(r.logs)) throw this.failure('permission', 'the API server refused the proxy read of the engine service', { exitCode: Number(rc), logs: r.logs });
      return { ready: false, partitions: [] };
    }
    const ready = /^LOOM_CAPABILITY=1$/m.test(r.logs);
    const fhirVersion = /^LOOM_FHIR_VERSION=(\S+)$/m.exec(r.logs)?.[1];
    const partitions = opts?.partitions ? (await this.readPartitions(tenantId)).map((p) => p.name) : [];
    return { ready, ...(fhirVersion ? { fhirVersion } : {}), partitions };
  }

  /** The tenant database's partition rows, through the PG admin Job (B2c pattern). Throws when the table cannot be read; never reports "none" for a failed read. */
  private async readPartitions(tenantId: string): Promise<PartitionSpec[]> {
    const logs = await this.runPgJob(tenantId, readPartitionSteps(fhirNames(tenantId).databaseName));
    return parsePartitionRows(logs);
  }

  async readPartitionRows(tenantId: string): Promise<PartitionSpec[] | undefined> {
    try {
      return await this.readPartitions(tenantId);
    } catch (e) {
      if (!(e instanceof JobFailure)) throw e;
      this.log('fhir_engine.partition_rows_unreadable', { tenant: tenantId, code: e.code });
      return undefined;
    }
  }

  /**
   * The engine creates its own partitions at startup (#5422 decision 11); there is no create here and no `$partition-management-*` call.
   * Wait for the rollout, read the tenant database back, and fail closed on any desired partition that is missing or disagrees.
   */
  async ensurePartitions(tenantId: string, desired: PartitionSpec[]): Promise<void> {
    const t = await this.resolve(tenantId);
    assertPartitions(desired);
    const name = fhirNames(tenantId).workloadName;
    const secs = this.o.rolloutSeconds ?? DEFAULT_ROLLOUT_SECONDS;
    const roll = await this.o.run.run(t, `kubectl rollout status deployment/${name} -n ${this.ns} --timeout=${secs}s`);
    if (roll.exitCode !== 0) {
      // The usual cause of a crash-looping engine here is partitions.conflict. Name it only if the table can be read and shows one.
      const rows = await this.readPartitionRows(tenantId);
      const cmp = rows ? comparePartitions(desired, rows) : undefined;
      const clash = cmp && cmp.conflicting.length > 0 ? cmp.conflicting.map((c) => `${c.want.name} (id ${c.want.id}) disagrees with the row ${c.found.name} (id ${c.found.id})`).join('; ') : '';
      const cause = clash
        ? `the tenant database holds rows that conflict with the desired partitions (${clash}); the engine refuses to start on such a conflict (partitions.conflict) and never renames or deletes, so this is the likely cause, but the engine log was not read`
        : rows
          ? `${hfjRead(rows.length)} and none conflicts with the desired partitions, so a partition conflict is ruled out; the cause is NOT established`
          : `${PARTITION_TABLE} could not be read; the cause is NOT established`;
      throw this.failure('engine_rollout_failed', `deployment/${name} is not rolled out, so its partitions cannot have been reconciled; ${cause}`, roll);
    }
    const found = await this.readPartitions(tenantId);
    const cmp = comparePartitions(desired, found);
    if (cmp.missing.length === 0 && cmp.conflicting.length === 0) return;
    const parts = [
      ...cmp.missing.map((p) => `${p.name} (id ${p.id}) is absent`),
      ...cmp.conflicting.map((c) => `${c.want.name} (id ${c.want.id}) disagrees with the row ${c.found.name} (id ${c.found.id})`),
    ];
    throw new JobFailure(
      'readback_mismatch',
      `the tenant database ${fhirNames(tenantId).databaseName} does not hold the desired partitions: ${parts.join('; ')}. Established: the rows read from ${PARTITION_TABLE} (${found.length}). Not established: why. The engine creates its partitions at startup and logs partitions.reconciled or partitions.conflict.`,
    );
  }

  async removeEngine(tenantId: string): Promise<void> {
    const t = await this.resolve(tenantId);
    const name = fhirNames(tenantId).workloadName;
    const del = await this.o.run.run(t, `kubectl delete deployment/${name} service/${name} serviceaccount/${name} -n ${this.ns} --ignore-not-found --wait=true --timeout=120s`);
    if (del.exitCode !== 0) throw this.failure('engine_remove_failed', `removing the engine workload ${name} failed`, del);
    const left = await this.o.run.run(t, `kubectl get deployment/${name} service/${name} serviceaccount/${name} -n ${this.ns} --ignore-not-found -o name`);
    if (left.exitCode !== 0) throw this.failure('engine_remove_failed', `reading back the removal of ${name} failed`, left);
    if (left.logs.trim() !== '') {
      throw new JobFailure('teardown_incomplete', `after removal ${excerpt(left.logs, 200)} is still present in ${this.ns}; the tenant database was NOT touched. Retry the job.`);
    }
  }
}

/** Where a tenant's engine lives: the stamp's AKS, PostgreSQL host and PG administrator identity, from the stamp manifest. */
export function armEngineTarget(d: { stamps: Collection<StampDoc>; tenants: Collection<TenantDoc>; arm: TenantArm }): (tenantId: string) => Promise<EngineTarget> {
  return async (tenantId) => {
    const tenant = await d.tenants.get(tenantId);
    if (!tenant) throw new JobFailure('tenant_missing', 'the tenant record no longer exists');
    const stamp = await d.stamps.get(tenant.stampId);
    if (!stamp) throw new JobFailure('stamp_missing', 'the tenant references a stamp that is not registered');
    const rg = stampResourceGroup(stamp.id, stamp.region);
    let m;
    try {
      m = await d.arm.getStampManifest(rg, stamp.id);
    } catch (e) {
      throw classifyArm(e);
    }
    if (m.state !== 'found') throw new JobFailure('stamp_manifest_missing', `the stamp deployment lhds-stamp-${stamp.id} ${m.state === 'absent' ? 'was not found' : 'returned no outputs'} in ${rg}`);
    const cluster = String(m.value.aksClusterName ?? '');
    if (!cluster) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no aksClusterName; the engine cannot be delivered');
    const pg = m.value.pgAdminIdentity as { name?: unknown } | undefined;
    return { resourceGroup: rg, cluster, postgresFqdn: String(m.value.postgresFqdn ?? ''), pgAdminName: typeof pg?.name === 'string' ? pg.name : '' };
  };
}
