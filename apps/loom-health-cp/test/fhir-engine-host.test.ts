// W2-2b B2c: the runCommand client and the production FhirEngineHost. The cluster is a SCRIPTED FAKE: a function from
// the command text to {exitCode, logs}, so the manifests the host sends are the ones asserted on (not a copy of them).
// Every assertion names the value that breaks it; each absence check is paired with a positive one.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';
import { RestAksRunCommand, RUN_COMMAND_API, RUN_COMMAND_ATTEMPTS, type AksRunCommand, type AksTarget, type RunCommandResult } from '../src/jobs/aks-run-command.js';
import {
  ANN_REVISION,
  ANN_OVERRIDES,
  ANN_PARTITIONING,
  ANN_PARTITIONS,
  engineListCommand,
  parseEngineList,
  RunCommandFhirEngineHost,
  engineProbeScript,
  armEngineTarget,
  ensurePrincipalSteps,
  excerpt,
  comparePartitions,
  parsePartitionRows,
  readPartitionSteps,
  pgJobScript,
  readPrincipalSteps,
  removePrincipalSteps,
  renderEngineManifest,
  renderEngineNetworkPolicy,
  ENGINE_INGRESS_PEERS,
  ENGINE_PORT,
  EDGE_ROUTER_PEER,
  renderPgJobManifest,
  type EngineTarget,
} from '../src/jobs/fhir-engine-host.js';
import { loadFhirEngineConfig } from '../src/jobs/fhir-engine-config.js';
import { JDBC_AUTH_PLUGIN, renderEngineConfig } from '../src/jobs/fhir-tenant-config.js';
import { fhirTenantHandlers } from '../src/jobs/fhir-tenant-jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import type { TenantArm } from '../src/jobs/tenant-arm.js';
import { JobFailure, type JobDoc } from '../src/jobs/types.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { AUDIENCE, AUTHORITY, MemoryCollection, TENANT, memoryStores, testKeyResolver } from './helpers.js';

const SLUG = 'acme-health';
const DB = 'lhds_acme_health';
const SUB = '00000000-0000-0000-0000-000000000001';
const ARM = 'https://management.azure.com';
const PID = 'aaaaaaaa-2222-3333-4444-555555555555';
const PID2 = 'bbbbbbbb-2222-3333-4444-555555555555';
const IDENT = { name: 'id-lhds-dev01-acme-health-fhir', clientId: '11111111-2222-3333-4444-555555555555', principalId: PID };
const PG_FQDN = 'pg-dev01.postgres.database.azure.com';
const PDP = 'http://loom-health-pdp.loom-health.svc.cluster.local';
const FHIR_IMAGE = 'acrx.azurecr.io/loom-health-fhir:v0.1';
const PG_IMAGE = `acrx.azurecr.io/postgres@sha256:${'a'.repeat(64)}`;
const TARGET: EngineTarget = { resourceGroup: 'rg-csa-loom-health-dev01-eastus2', cluster: 'aks-lhds-dev01', postgresFqdn: PG_FQDN, pgAdminName: 'id-lhds-dev01-pgadmin' };

const cfgFor = (over: Partial<Parameters<typeof renderEngineConfig>[0]> = {}) =>
  renderEngineConfig({ tenantId: SLUG, stampId: 'dev01', stampBaseUrl: 'https://x.example', postgresFqdn: PG_FQDN, identity: IDENT, maxRequestsPerMinute: 600, pdpUrl: PDP, pgAdminName: TARGET.pgAdminName, ...over });

// ────────────────────────────────────────────────────────────── runCommand client

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
}

describe('RestAksRunCommand', () => {
  const T: AksTarget = { resourceGroup: 'rg-x', cluster: 'aks-x' };
  const mk = (script: Array<(url: string, init: RequestInit) => Response>, extra: { sleeps?: number[] } = {}) => {
    const calls: Array<{ method: string; url: string; body?: string; auth?: string }> = [];
    let i = 0;
    const rc = new RestAksRunCommand({
      armEndpoint: ARM,
      subscriptionId: SUB,
      token: async (scope) => `tok:${scope}`,
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url, body: init.body as string | undefined, auth: (init.headers as Record<string, string>).authorization });
        const f = script[i++];
        if (!f) throw new Error('unexpected extra request');
        return f(url, init);
      }) as unknown as typeof fetch,
      sleep: async (ms) => void extra.sleeps?.push(ms),
      log: () => {},
    });
    return { rc, calls };
  };
  const done = (exitCode: number | undefined, logs = '', state = 'Succeeded') => res(200, { properties: { provisioningState: state, ...(exitCode === undefined ? {} : { exitCode }), logs } });
  const accepted = () => res(202, { id: 'cmd-0123456789abcdef', properties: { provisioningState: 'Accepted' } });

  it('POSTs the command to managedClusters/<aks>/runCommand, polls commandResults/<id>, returns exitCode and logs', async () => {
    const { rc, calls } = mk([accepted, () => res(202, undefined), () => done(0, 'deployment.apps/x configured')]);
    const out = await rc.run(T, 'kubectl get ns');
    expect(out).toEqual({ exitCode: 0, logs: 'deployment.apps/x configured' });
    const base = `${ARM}/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.ContainerService/managedClusters/aks-x`;
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${base}/runCommand?api-version=${RUN_COMMAND_API}`, auth: `Bearer tok:${ARM}/.default` });
    // Breaks if clusterToken is dropped (live: HTTP 400 MissingAADClusterToken) or issued for the wrong audience
    // (e.g. the ARM scope instead of the AKS server app): the literal GUID below is Learn's, not the source constant.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ command: 'kubectl get ns', clusterToken: 'tok:6dae42f8-4368-4678-94ff-3960e28e3630/.default' });
    // The poll goes to the id the POST returned; a poll of any other id breaks this.
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${base}/commandResults/cmd-0123456789abcdef?api-version=${RUN_COMMAND_API}` });
    expect(calls).toHaveLength(3);
  });

  it('no cluster token means no request: a retryable failure that names the AKS server app, and zero calls', async () => {
    // Breaks if a token failure is swallowed and the POST goes out without clusterToken (calls would be 1), or if the
    // failure is labelled as a cause nobody measured (code would not be 'transient').
    const calls: unknown[] = [];
    const rc = new RestAksRunCommand({
      armEndpoint: ARM,
      subscriptionId: SUB,
      token: async (scope) => { if (scope.startsWith('6dae42f8')) throw new Error('no token'); return 'arm'; },
      fetchFn: (async () => { calls.push(1); return res(500, undefined); }) as unknown as typeof fetch,
      sleep: async () => {},
      log: () => {},
    });
    const err = await rc.run(T, 'kubectl get ns').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).code).toBe('transient');
    expect((err as JobFailure).message).toContain('6dae42f8-4368-4678-94ff-3960e28e3630');
    expect(calls).toHaveLength(0);
  });

  it('a non-zero kubectl exit is RETURNED, not retried (one POST only; 2 would mean it re-ran a command that answered)', async () => {
    const { rc, calls } = mk([accepted, () => done(1, 'Error from server (NotFound)', 'Failed')]);
    expect(await rc.run(T, 'kubectl get x')).toEqual({ exitCode: 1, logs: 'Error from server (NotFound)' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('retries a send that ended with NO exit code, with the documented backoff, and succeeds on the next', async () => {
    const sleeps: number[] = [];
    const { rc, calls } = mk([accepted, () => done(undefined, '', 'Failed'), accepted, () => done(0, 'ok')], { sleeps });
    expect((await rc.run(T, 'c')).exitCode).toBe(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(sleeps).toContain(10_000); // first backoff
  });

  it('gives up after exactly RUN_COMMAND_ATTEMPTS sends and says it does NOT know whether kubectl ran', async () => {
    const script = Array.from({ length: RUN_COMMAND_ATTEMPTS }, () => [accepted, () => res(200, { properties: { provisioningState: 'Failed', reason: 'pod not scheduled in 60s' } })]).flat();
    const { rc, calls } = mk(script);
    const err = await rc.run(T, 'c').catch((e: unknown) => e as Error & { code: string });
    expect((err as { code: string }).code).toBe('run_command_no_result');
    expect((err as Error).message).toContain('NOT established');
    expect((err as Error).message).toContain('pod not scheduled in 60s');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(RUN_COMMAND_ATTEMPTS);
    // R7: the message must not assert that kubectl did not run.
    expect((err as Error).message).not.toMatch(/did not run|never ran/i);
  });

  it('a genuine ARM 403 is classified permission on the FIRST attempt; a non-ARM 403 is retried then fails closed', async () => {
    const arm403 = () => res(403, { error: { code: 'AuthorizationFailed', message: "does not have authorization to perform action 'Microsoft.ContainerService/managedClusters/runCommand/action' over scope '/subscriptions/s'" } }, { 'x-ms-request-id': 'r' });
    const one = mk([arm403]);
    const e1 = (await one.rc.run(T, 'c').catch((e: unknown) => e)) as { code: string; message: string };
    expect(e1.code).toBe('permission');
    expect(e1.message).toContain('Microsoft.ContainerService/managedClusters/runCommand/action');
    expect(one.calls).toHaveLength(1);
    const html = () => new Response('<html><title>Denied</title></html>', { status: 403, headers: { 'content-type': 'text/html' } });
    const three = mk([html, html, html]);
    const e3 = (await three.rc.run(T, 'c').catch((e: unknown) => e)) as { code: string };
    expect(e3.code).toBe('permission');
    expect(three.calls).toHaveLength(3);
  });

  it('refuses a malformed cluster name before any request', async () => {
    const { rc, calls } = mk([]);
    await expect(rc.run({ resourceGroup: 'rg', cluster: 'x/../y' }, 'c')).rejects.toMatchObject({ code: 'bad_cluster_target' });
    expect(calls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────── pure renderers

describe('renderEngineManifest', () => {
  const list = JSON.parse(renderEngineManifest(cfgFor(), { image: FHIR_IMAGE, namespace: 'loom-health' })) as { items: Array<Record<string, any>> };
  const sa = list.items.find((i) => i.kind === 'ServiceAccount') as Record<string, any>;
  const dep = list.items.find((i) => i.kind === 'Deployment') as Record<string, any>;
  const svc = list.items.find((i) => i.kind === 'Service') as Record<string, any>;
  const ctr = dep.spec.template.spec.containers[0] as Record<string, any>;

  it('the ServiceAccount is fhir-<slug>, annotated with the tenant identity CLIENT id (breaks if the principal id or name is used)', () => {
    expect(sa.metadata.name).toBe(`fhir-${SLUG}`);
    expect(sa.metadata.annotations['azure.workload.identity/client-id']).toBe(IDENT.clientId);
    expect(dep.spec.template.spec.serviceAccountName).toBe(`fhir-${SLUG}`);
  });

  it('the pod opts in to workload identity (label is the string "true")', () => {
    expect(dep.spec.template.metadata.labels['azure.workload.identity/use']).toBe('true');
  });

  it('the container has the JDBC plugin in the URL, the identity as the user, and NO password variable', () => {
    const env = Object.fromEntries((ctr.env as Array<{ name: string; value: string }>).map((e) => [e.name, e.value]));
    expect(env.SPRING_DATASOURCE_URL).toContain(`authenticationPluginClassName=${JDBC_AUTH_PLUGIN}`);
    expect(env.SPRING_DATASOURCE_URL).toContain(`/${DB}?`);
    expect(env.SPRING_DATASOURCE_USERNAME).toBe(IDENT.name);
    // Paired: the datasource variables exist (a manifest with no env at all cannot pass the absence check).
    expect(Object.keys(env).length).toBeGreaterThan(8);
    expect(Object.keys(env).filter((k) => /PASSWORD/i.test(k))).toEqual([]);
    expect(JSON.stringify(ctr)).not.toMatch(/secretKeyRef|valueFrom/);
    expect(ctr.image).toBe(FHIR_IMAGE);
  });

  it('restricted security context, probes, the revision annotation, and a ClusterIP service to the http port', () => {
    expect(dep.spec.template.spec.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    expect(ctr.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(ctr.readinessProbe.httpGet.path).toBe('/fhir/metadata');
    expect(ctr.startupProbe.failureThreshold).toBeGreaterThanOrEqual(30);
    expect(dep.metadata.annotations[ANN_REVISION]).toBe(cfgFor().revision);
    expect(dep.metadata.annotations['loom.health/partitioning']).toBe('true');
    expect(svc.spec.type).toBe('ClusterIP');
    expect(svc.spec.ports[0]).toMatchObject({ port: 80, targetPort: 'http' });
    expect(svc.metadata.name).toBe(`fhir-${SLUG}`);
  });

  it('every object is namespaced to loom-health (the only namespace the control plane may write)', () => {
    expect(list.items.map((i) => i.metadata.namespace)).toEqual(['loom-health', 'loom-health', 'loom-health', 'loom-health']);
  });

  describe('NetworkPolicy (#5441)', () => {
    type Peer = { namespaceSelector?: { matchLabels?: Record<string, string> }; podSelector?: { matchLabels?: Record<string, string> } };
    const build = (slug: string, edgePeers?: Peer[]) => {
      const l = JSON.parse(renderEngineManifest(cfgFor({ tenantId: slug }), { image: FHIR_IMAGE, namespace: 'loom-health', ...(edgePeers ? { edgePeers: edgePeers as never } : {}) })) as { items: Array<Record<string, any>> };
      return { l, np: l.items.filter((i) => i.kind === 'NetworkPolicy') };
    };

    it('exactly one policy beside the engine, named and labelled like it', () => {
      const { l, np } = build(SLUG);
      expect(np).toHaveLength(1); // breaks at 0 (not rendered) or 2
      expect(np[0]!.metadata.name).toBe(`fhir-${SLUG}`);
      expect(np[0]!.metadata.labels).toEqual(l.items.find((i) => i.kind === 'Deployment')!.metadata.labels); // breaks when managed-by/tenant labels are dropped
    });

    it("selects ONLY this tenant's engine pods (app AND tenant label), and those labels are on the pod template", () => {
      const a = build(SLUG).np[0]!;
      expect(a.spec.podSelector.matchLabels).toEqual({ app: `fhir-${SLUG}`, 'loom.health/tenant': SLUG }); // breaks on {} or an app-only selector
      const b = build('beta-clinic').np[0]!;
      expect(b.spec.podSelector.matchLabels['loom.health/tenant']).toBe('beta-clinic');
      const tmpl = build(SLUG).l.items.find((i) => i.kind === 'Deployment')!.spec.template.metadata.labels;
      for (const [k, v] of Object.entries(a.spec.podSelector.matchLabels)) expect(tmpl[k]).toBe(v); // breaks if the selector no longer matches the pods
    });

    it('ingress admits aks-command and the konnectivity tunnel by SCOPED selectors, nothing broader', () => {
      const rules = build(SLUG).np[0]!.spec.ingress;
      expect(rules).toHaveLength(1);
      expect(rules[0].from).toEqual([
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'aks-command' } } },
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { app: 'konnectivity-agent' } } },
      ]); // breaks on an empty from, namespaceSelector: {}, an ipBlock, or a selector without its label
      for (const p of rules[0].from as Peer[]) {
        expect(Object.keys(p.namespaceSelector?.matchLabels ?? {}).length).toBeGreaterThan(0);
        expect(p).not.toHaveProperty('ipBlock');
      }
    });

    it('the port set is EXACT (TCP 8080 only) and the policy is ingress-only (egress stays open by design)', () => {
      const np = build(SLUG).np[0]!;
      expect(np.spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 8080 }]); // breaks when 9999 or the service port 80 joins
      expect(ENGINE_PORT).toBe(8080);
      expect(np.spec.policyTypes).toEqual(['Ingress']); // adding Egress without rules would black-hole PG and Entra
      expect(np.spec).not.toHaveProperty('egress');
    });

    it('the edge hook appends a scoped peer after the base peers; an unscoped one is refused', () => {
      const edge = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lhds-edge' } }, podSelector: { matchLabels: { app: 'apim-edge' } } };
      const from = build(SLUG, [edge]).np[0]!.spec.ingress[0].from;
      expect(from).toHaveLength(ENGINE_INGRESS_PEERS.length + 1);
      expect(from[from.length - 1]).toEqual(edge);
      const base = { name: 'fhir-x', tenantId: 'x', namespace: 'loom-health', labels: {} };
      expect(() => renderEngineNetworkPolicy({ ...base, edgePeers: [{ namespaceSelector: { matchLabels: {} } }] })).toThrow(/every namespace/); // breaks if {} is accepted
      expect(() => renderEngineNetworkPolicy({ ...base, edgePeers: [{ namespaceSelector: { matchLabels: { a: 'b' } }, podSelector: { matchLabels: {} } }] })).toThrow(/every pod/);
    });
  });
});

describe('PostgreSQL principal Job', () => {
  it('ensure SQL is idempotent: create is guarded by a pg_roles check, then CONNECT only on the tenant database', () => {
    const [admin, tenantDb] = ensurePrincipalSteps(IDENT.name, DB, PID);
    const sql = admin?.sql ?? '';
    const guard = sql.indexOf(`IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${IDENT.name}')`);
    const create = sql.indexOf('pgaadauth_create_principal_with_oid(');
    // The create call must come AFTER the guard: a bare create fails on the second run (breaks if the guard is dropped).
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(guard);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE "${DB}" TO "${IDENT.name}"`);
    // Create is bound to the exact object id and the 'service' type (not a by-name directory lookup): a name-based
    // pgaadauth_create_principal, another id, or 'user' breaks this literal.
    expect(sql).toContain(`pg_catalog.pgaadauth_create_principal_with_oid('${IDENT.name}', '${PID}', 'service', false, false)`);
    expect(sql).not.toMatch(/pgaadauth_create_principal\(/);
    expect(sql).toContain('REVOKE CONNECT ON DATABASE %I FROM PUBLIC');
    expect(admin?.db).toBe('postgres');
    expect(tenantDb).toEqual({ db: DB, sql: `GRANT USAGE, CREATE ON SCHEMA public TO "${IDENT.name}";` });
  });

  it('refuses a principal or database name that could carry SQL', () => {
    expect(() => ensurePrincipalSteps("x'; DROP DATABASE y; --", DB, PID)).toThrow(/malformed PostgreSQL principal/);
    expect(() => ensurePrincipalSteps(IDENT.name, 'lhds_x"; --', PID)).toThrow(/malformed tenant database/);
    expect(() => readPrincipalSteps('a b')).toThrow();
    expect(() => removePrincipalSteps(IDENT.name, 'other')).toThrow();
  });

  it('the Job runs as lhds-pg-admin with workload identity, a digest-pinned image, no token in the manifest, and one-shot semantics', () => {
    const m = JSON.parse(renderPgJobManifest({ jobName: 'pgp-x-ab12cd', namespace: 'loom-health', tenantId: SLUG, image: PG_IMAGE, postgresFqdn: PG_FQDN, pgAdminName: TARGET.pgAdminName, pgScope: 'https://ossrdbms-aad.database.windows.net/.default', steps: ensurePrincipalSteps(IDENT.name, DB, PID) })) as Record<string, any>;
    const pod = m.spec.template;
    expect(pod.spec.serviceAccountName).toBe('lhds-pg-admin');
    expect(pod.metadata.labels['azure.workload.identity/use']).toBe('true');
    expect(pod.spec.containers[0].image).toBe(PG_IMAGE);
    expect(pod.spec.restartPolicy).toBe('Never');
    expect([m.spec.backoffLimit, m.spec.activeDeadlineSeconds]).toEqual([0, 180]);
    const env = Object.fromEntries(pod.spec.containers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env.PGUSER).toBe(TARGET.pgAdminName);
    expect(env.LOOM_DB_2).toBe(DB);
    expect(env.LOOM_PG_SCOPE_ENC).toBe(encodeURIComponent('https://ossrdbms-aad.database.windows.net/.default'));
    // The token is only ever a shell variable inside the pod; neither the manifest nor the script prints it.
    expect(Object.keys(env).filter((k) => /PGPASSWORD/.test(k))).toEqual([]);
    const script = pod.spec.containers[0].args[0] as string;
    expect(script).toContain('export PGPASSWORD="$TOKEN"');
    expect(script).not.toMatch(/echo[^\n]*\$TOKEN|set -x/);
    expect(script).toContain('LOOM_PG_DONE=1');
    expect(script.match(/psql /g)).toHaveLength(2);
    expect(pgJobScript([{ db: 'postgres', sql: 'x' }]).match(/psql /g)).toHaveLength(1);
  });
});

describe('small parsers', () => {
  it('excerpt masks a JWT and a bearer token and bounds the length (200 chars of padding cannot get through)', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOiJ4.sig_nature';
    const out = excerpt(`token ${jwt} Authorization: Bearer abcdefghijklmnop ${'x'.repeat(600)}`, 100);
    expect(out).toContain('<jwt>');
    expect(out).toContain('Bearer <redacted>');
    expect(out).not.toContain(jwt);
    expect(out.length).toBeLessThanOrEqual(103);
  });

  it('parsePartitionRows reads LOOM_PARTITION=<id>:<name> lines and ignores everything else', () => {
    expect(parsePartitionRows('EXIT=0\nLOOM_PARTITION=3:site-a\nnoise LOOM_PARTITION=9:x\nLOOM_PARTITION=4:site-b\nLOOM_PG_DONE=1')).toEqual([{ id: 3, name: 'site-a' }, { id: 4, name: 'site-b' }]);
    expect(parsePartitionRows('not a row')).toEqual([]);
  });

  it('comparePartitions: present is ok, absent is missing, same name other id and same id other name are conflicts, extras are tolerated', () => {
    const want = [{ id: 1, name: 'site-a' }, { id: 2, name: 'site-b' }, { id: 3, name: 'site-c' }];
    expect(comparePartitions(want, [{ id: 1, name: 'site-a' }, { id: 2, name: 'site-b' }, { id: 3, name: 'site-c' }, { id: 9, name: 'extra' }])).toEqual({ missing: [], conflicting: [] });
    expect(comparePartitions(want, [{ id: 1, name: 'site-a' }]).missing.map((p) => p.name)).toEqual(['site-b', 'site-c']);
    const c = comparePartitions(want, [{ id: 1, name: 'site-a' }, { id: 5, name: 'site-b' }, { id: 3, name: 'other' }]);
    expect(c.missing).toEqual([]);
    expect(c.conflicting.map((x) => x.want.name)).toEqual(['site-b', 'site-c']);
  });

  it('the partition readback SQL selects hfj_partition in the TENANT database and nothing else', () => {
    const [step, ...rest] = readPartitionSteps(DB);
    expect(rest).toEqual([]);
    expect(step?.db).toBe(DB);
    expect(step?.sql).toBe("SELECT 'LOOM_PARTITION=' || part_id || ':' || part_name FROM hfj_partition ORDER BY part_id;");
    expect(() => readPartitionSteps('postgres')).toThrow(/malformed tenant database name/);
  });
});

// ────────────────────────────────────────────────────────────── scripted cluster

/** A tiny cluster behind AksRunCommand: it parses what the host sends and keeps state, so the host is tested against its own output. */
class FakeCluster implements AksRunCommand {
  commands: string[] = [];
  roleExists = false;
  /** Databases the principal can connect to once it exists. */
  roleDbs: string[] = [DB];
  deployment: { rev: string; ovr: string; part: string } | undefined;
  fhirVersion = '4.0.1';
  capability = true;
  jobFails = false;
  jobStuck = false;
  proxyRc = 0;
  proxyErr = '';
  applyExit = 0;
  applyLogs = '';
  rolloutExit = 0;
  /** The tenant database's hfj_partition rows. */
  partitions: Array<{ id: number; name: string }> = [];
  partsAnnotation = '';
  /** Simulate the engine reconciling at startup when a Deployment is applied. */
  engineReconciles = true;
  /** The grant to the PG admin is absent. */
  partitionsDenied = false;
  lastJobEnv: Record<string, string> = {};
  jobsApplied: string[] = [];
  jobsDeleted: string[] = [];
  deleteLeavesWorkload = false;
  workloadPresent = false;
  /** The engine NetworkPolicy is modelled apart from the Deployment so a teardown that leaves ONLY it behind is expressible. */
  policyPresent = false;
  deleteLeavesPolicy = false;
  /** The tenant database was dropped by tenant.destroy. */
  dbAbsent = false;
  /** Entra object id the existing role is bound to. */
  roleOid: string | undefined;

  async run(_t: AksTarget, command: string): Promise<RunCommandResult> {
    this.commands.push(command);
    const ok = (logs = ''): RunCommandResult => ({ exitCode: 0, logs });
    if (command.includes('"kind":"Job"')) {
      if (this.applyExit !== 0) return { exitCode: this.applyExit, logs: this.applyLogs };
      const manifest = JSON.parse(/<<'LOOM_MANIFEST_EOF'\n([\s\S]*)\nLOOM_MANIFEST_EOF/.exec(command)?.[1] ?? '{}') as any;
      this.jobsApplied.push(manifest.metadata.name);
      this.lastJobEnv = Object.fromEntries(manifest.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]));
      this.runJobSql();
      return ok('LOOM_APPLIED=1');
    }
    if (command.includes('"kind":"List"')) {
      if (this.applyExit !== 0) return { exitCode: this.applyExit, logs: this.applyLogs };
      const m = JSON.parse(/<<'LOOM_MANIFEST_EOF'\n([\s\S]*)\nLOOM_MANIFEST_EOF/.exec(command)?.[1] ?? '{}') as any;
      const d = m.items.find((i: any) => i.kind === 'Deployment');
      this.deployment = { rev: d.metadata.annotations['loom.health/engine-revision'], ovr: d.metadata.annotations['loom.health/engine-overrides'], part: d.metadata.annotations['loom.health/partitioning'] };
      this.partsAnnotation = d.metadata.annotations['loom.health/partitions'] ?? '';
      if (this.engineReconciles) this.reconcileFrom(d.spec.template.spec.containers[0].env);
      this.workloadPresent = true;
      this.policyPresent = m.items.some((i: any) => i.kind === 'NetworkPolicy');
      return this.rolloutExit === 0 ? ok('LOOM_APPLIED=1\ndeployment successfully rolled out') : { exitCode: this.rolloutExit, logs: 'LOOM_APPLIED=1\nerror: timed out waiting for the condition' };
    }
    if (/kubectl get job\//.test(command)) return ok(this.jobStuck ? 'SUCCEEDED= FAILED=' : this.jobFails ? 'SUCCEEDED= FAILED=1' : 'SUCCEEDED=1 FAILED=');
    if (command.includes('-l job-name=') && command.includes('waiting.reason')) return ok('ImagePullBackOff');
    if (command.includes('kubectl logs')) {
      if (this.jobFails) return ok('EXIT=1\npsql: error: FATAL: password authentication failed');
      const sql = this.lastJobEnv.LOOM_SQL_1 ?? '';
      if (sql.includes('hfj_partition')) {
        if (this.partitionsDenied) return ok('EXIT=1\npsql: error: ERROR:  permission denied for table hfj_partition');
        return ok(['EXIT=0', ...this.partitions.map((p) => `LOOM_PARTITION=${p.id}:${p.name}`), 'LOOM_PG_DONE=1'].join('\n'));
      }
      if (sql.includes('LOOM_ROLE_EXISTS')) {
        const dbs = this.roleExists ? this.roleDbs.map((d) => `LOOM_ROLE_DB=${d}`) : [];
        return ok(['EXIT=0', `LOOM_ROLE_EXISTS=${this.roleExists ? 't' : 'f'}`, ...dbs, 'LOOM_PG_DONE=1'].join('\n'));
      }
      return ok('EXIT=0\nLOOM_PG_DONE=1');
    }
    if (command.startsWith('kubectl delete job/')) {
      this.jobsDeleted.push(/job\/(\S+)/.exec(command)?.[1] ?? '');
      return ok();
    }
    if (command.includes('kubectl get deployment/') && command.includes('jsonpath')) {
      return ok(this.deployment ? `FOUND=fhir-${SLUG}\nREV=${this.deployment.rev}\nPART=${this.deployment.part}\nOVR=${this.deployment.ovr}\nPARTS=${this.partsAnnotation}\n` : '');
    }
    if (command.includes('/metadata')) {
      const lines = [`LOOM_PROBE_RC=${this.proxyRc}`];
      if (this.proxyRc !== 0) lines.push(this.proxyErr);
      else {
        if (this.capability) lines.push('LOOM_CAPABILITY=1');
        if (this.fhirVersion) lines.push(`LOOM_FHIR_VERSION=${this.fhirVersion}`);
      }
      return ok(lines.join('\n'));
    }
    if (command.startsWith('kubectl rollout status')) return this.rolloutExit === 0 ? ok('deployment successfully rolled out') : { exitCode: this.rolloutExit, logs: 'error: timed out waiting for the condition' };
    if (command.startsWith('kubectl delete deployment/')) {
      if (!this.deleteLeavesWorkload) {
        this.deployment = undefined;
        this.workloadPresent = false;
      }
      if (!this.deleteLeavesPolicy) this.policyPresent = false;
      return ok();
    }
    if (command.includes('-o name')) {
      // The read-back only lists what the GET names: a get that omits networkpolicy/<name> cannot see the policy.
      const lines = [this.workloadPresent ? `deployment.apps/fhir-${SLUG}` : '', this.policyPresent && command.includes(`networkpolicy/fhir-${SLUG}`) ? `networkpolicy.networking.k8s.io/fhir-${SLUG}` : ''].filter(Boolean);
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    }
    return { exitCode: 127, logs: `fake cluster: unscripted command ${command.slice(0, 60)}` };
  }

  /** What psql would do with the applied Job, step by step: a step with no database guard against an absent DB FAILS (psql: database does not exist). */
  runJobSql(): void {
    const env = this.lastJobEnv;
    for (let n = 1; env[`LOOM_SQL_${n}`] !== undefined; n++) {
      const sql = env[`LOOM_SQL_${n}`] as string;
      const db = env[`LOOM_DB_${n}`];
      if (env[`LOOM_REQ_DB_${n}`] && this.dbAbsent) continue; // guarded step skipped
      if (db === DB && this.dbAbsent) {
        this.jobFails = true;
        return;
      }
      const oid = /oid=([0-9a-f-]{36})/.exec(sql)?.[1];
      // The stale-role drop only fires if its guard really is "role exists AND no pgaadauth label with this oid".
      const dropArmed = /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = '[^']+'\) AND NOT EXISTS \(SELECT 1 FROM pg_seclabels/.test(sql);
      if (oid && dropArmed && this.roleExists && this.roleOid !== oid) this.roleExists = false; // DROP ROLE of the stale role
      if (sql.includes('pgaadauth_create_principal') && !this.roleExists) {
        this.roleExists = true;
        this.roleOid = oid ?? this.roleOid;
      }
      if (sql.includes('DROP ROLE') && !oid) this.roleExists = false;
    }
  }

  /** What the real engine does at startup: it reads LOOM_HEALTH_PARTITIONS and creates the missing rows itself (the plugin's reconciler). */
  reconcileFrom(env: Array<{ name: string; value: string }>): void {
    const want = JSON.parse(env.find((e) => e.name === 'LOOM_HEALTH_PARTITIONS')?.value ?? '[]') as Array<{ id: number; name: string }>;
    for (const w of want) if (!this.partitions.some((p) => p.id === w.id && p.name === w.name)) this.partitions.push(w);
  }
}

function hostOver(cluster: FakeCluster, over: { jobMaxPolls?: number } = {}) {
  return new RunCommandFhirEngineHost({
    run: cluster,
    target: async () => TARGET,
    fhirImage: FHIR_IMAGE,
    pgClientImage: PG_IMAGE,
    pgScope: 'https://ossrdbms-aad.database.windows.net/.default',
    sleep: async () => {},
    jobMaxPolls: over.jobMaxPolls ?? 3,
    log: () => {},
  });
}

describe('RunCommandFhirEngineHost', () => {
  it('ensure then read: the principal exists and can connect to exactly the tenant database; the Job is deleted afterwards', async () => {
    const c = new FakeCluster();
    const h = hostOver(c);
    expect(await h.readDatabaseRole(SLUG, IDENT.name)).toEqual({ exists: false, connectableDatabases: [] });
    await h.ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID });
    expect(await h.readDatabaseRole(SLUG, IDENT.name)).toEqual({ exists: true, connectableDatabases: [DB] });
    // 3 Jobs ran and every one was deleted (2 would mean a leaked Job).
    expect(c.jobsApplied).toHaveLength(3);
    expect(c.jobsDeleted).toEqual(c.jobsApplied);
  });

  it('ensure is idempotent at the SQL level: a second ensure sends the same guarded SQL and succeeds', async () => {
    const c = new FakeCluster();
    const h = hostOver(c);
    await h.ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID });
    const first = c.lastJobEnv.LOOM_SQL_1;
    await h.ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID });
    expect(c.lastJobEnv.LOOM_SQL_1).toBe(first);
    expect(first).toContain('IF NOT EXISTS');
    expect(c.jobsApplied).toHaveLength(2);
  });

  it('a Job that fails surfaces what it printed, names what is NOT established, and the Job is still deleted', async () => {
    const c = new FakeCluster();
    c.jobFails = true;
    const err = (await hostOver(c).ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID }).catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe('pg_job_failed');
    expect(err.message).toContain('FATAL: password authentication failed'); // exactly what psql printed
    expect(err.message).toContain('Not established');
    expect(c.jobsDeleted).toHaveLength(1);
  });

  it('a Job that never finishes is pg_job_timeout with the pod waiting reason, and does not claim the SQL did not run', async () => {
    const c = new FakeCluster();
    c.jobStuck = true;
    const err = (await hostOver(c, { jobMaxPolls: 2 }).readDatabaseRole(SLUG, IDENT.name).catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe('pg_job_timeout');
    expect(err.message).toContain('ImagePullBackOff');
    expect(err.message).toContain('NOT established');
    expect(c.jobsDeleted).toHaveLength(1);
  });

  it('kubectl refusing the Job apply is classified permission and names the edit-only rights; nothing is polled', async () => {
    const c = new FakeCluster();
    c.applyExit = 1;
    c.applyLogs = 'Error from server (Forbidden): jobs.batch is forbidden: User "oid" cannot create resource "jobs"';
    const err = (await hostOver(c).ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID }).catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe('permission');
    expect(err.message).toContain('kubectl exit 1');
    expect(err.message).toContain('loom-health-cp-edit');
    expect(c.commands.some((x) => x.includes('kubectl get job/'))).toBe(false);
  });

  it('a read-back Job that prints no existence line is pg_job_unproven (never "does not exist")', async () => {
    const c = new FakeCluster();
    const run = c.run.bind(c);
    c.run = async (t, cmd) => (cmd.includes('kubectl logs') ? { exitCode: 0, logs: 'EXIT=0\nLOOM_PG_DONE=1' } : run(t, cmd));
    await expect(hostOver(c).readDatabaseRole(SLUG, IDENT.name)).rejects.toMatchObject({ code: 'pg_job_unproven' });
  });

  it('removeDatabaseRole reassigns ownership before dropping the role, in the tenant database first', async () => {
    const c = new FakeCluster();
    c.roleExists = true;
    await hostOver(c).removeDatabaseRole(SLUG, IDENT.name);
    expect(c.roleExists).toBe(false);
    expect(c.lastJobEnv.LOOM_DB_1).toBe(DB);
    expect(c.lastJobEnv.LOOM_SQL_1?.indexOf('REASSIGN OWNED')).toBeGreaterThanOrEqual(0);
    expect(c.lastJobEnv.LOOM_DB_2).toBe('postgres');
    expect(c.lastJobEnv.LOOM_SQL_2).toContain('DROP ROLE');
  });

  it('apply -> read: the config reads back the applied revision, overrides and partition mode', async () => {
    const c = new FakeCluster();
    const h = hostOver(c);
    expect(await h.readEngineConfig(SLUG)).toBeUndefined();
    const cfg = cfgFor({ overrides: { maxPageSize: 50 } });
    await h.applyEngineConfig(cfg);
    expect(await h.readEngineConfig(SLUG)).toEqual({ revision: cfg.revision, overrides: { maxPageSize: 50 }, partitioning: true, partitions: [] });
    const sent = c.commands.find((x) => x.includes('"kind":"List"')) ?? '';
    expect(sent).toContain(`"azure.workload.identity/client-id":"${IDENT.clientId}"`);
    expect(sent).toContain('"azure.workload.identity/use":"true"');
    expect(sent).toContain('kubectl rollout status deployment/fhir-acme-health -n loom-health');
    expect(sent).not.toMatch(/PASSWORD/);
  });

  it('the engine the host APPLIES admits the stamp edge router (G1) by scoped selectors, after the base peers', async () => {
    const c = new FakeCluster();
    await hostOver(c).applyEngineConfig(cfgFor());
    const sent = c.commands.find((x) => x.includes('"kind":"List"')) ?? '';
    const json = sent.split('\n').find((l) => l.startsWith('{"apiVersion":"v1","kind":"List"')) ?? '';
    const np = (JSON.parse(json) as { items: Array<Record<string, any>> }).items.find((i) => i.kind === 'NetworkPolicy')!;
    const from = np.spec.ingress[0].from as unknown[];
    // Breaks when applyEngineConfig stops passing edgePeers (length 2, edge missing): the router then gets a dropped SYN, never a 200.
    expect(from).toHaveLength(ENGINE_INGRESS_PEERS.length + 1);
    // Breaks on a label that differs from edge-router.bicep's namespace/pod label (e.g. 'lhds-edge'), or on an unscoped peer.
    expect(from[from.length - 1]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'loom-health-edge' } },
      podSelector: { matchLabels: { app: 'loom-health-edge' } },
    });
    expect(EDGE_ROUTER_PEER).toEqual(from[from.length - 1]);
    // Positive control on the base peers: they are still first and unchanged (breaks if the edge REPLACED them).
    expect(from.slice(0, ENGINE_INGRESS_PEERS.length)).toEqual([...ENGINE_INGRESS_PEERS]);
  });

  it('a failed apply and a failed rollout are different errors (the LOOM_APPLIED marker decides, not a guess)', async () => {
    const a = new FakeCluster();
    a.applyExit = 1;
    a.applyLogs = 'error: unable to recognize';
    await expect(hostOver(a).applyEngineConfig(cfgFor())).rejects.toMatchObject({ code: 'engine_apply_failed' });
    const b = new FakeCluster();
    b.rolloutExit = 1;
    const err = (await hostOver(b).applyEngineConfig(cfgFor()).catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe('engine_rollout_failed');
    expect(err.message).toContain('NOT established');
  });

  it('a Deployment this control plane did not apply (no revision annotation) is engine_unmanaged, not silently adopted', async () => {
    const c = new FakeCluster();
    const run = c.run.bind(c);
    c.run = async (t, cmd) => (cmd.includes('kubectl get deployment/') ? { exitCode: 0, logs: `FOUND=fhir-${SLUG}\nREV=\nPART=\nOVR=\n` } : run(t, cmd));
    await expect(hostOver(c).readEngineConfig(SLUG)).rejects.toMatchObject({ code: 'engine_unmanaged' });
  });

  it('probe reports FHIR 4.0.1 when the CapabilityStatement says so, through the API server service proxy', async () => {
    const c = new FakeCluster();
    const p = await hostOver(c).probeEngine(SLUG);
    expect(p).toEqual({ ready: true, fhirVersion: '4.0.1', partitions: [] });
    const cmd = c.commands.find((x) => x.includes('/metadata')) ?? '';
    expect(cmd).toContain(`kubectl get --raw '/api/v1/namespaces/loom-health/services/fhir-${SLUG}:80/proxy/fhir/metadata'`);
  });

  // The probe SCRIPT itself, executed by a real POSIX sh (FakeCluster above fakes its output, so it never runs there).
  // kubectl is a shell function that emits a CapabilityStatement; sed is a function that fails exactly as the distroless
  // AKS command pod does ("sed: not found", 127), so a script that reaches for sed again is caught here.
  // Skipped only where no `sh` exists; disclosed, not counted, in that case.
  const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
  it.skipIf(!hasSh)('the probe script runs with ONLY the command pod toolset (no sed) and reports capability and version', () => {
    const fixture = '{"resourceType" : "CapabilityStatement","status":"active","fhirVersion" : "4.0.1","format":["json"]}';
    const prelude = [
      'sed() { echo "sed: not found" >&2; return 127; }',
      `kubectl() { printf '%s' '${fixture}'; }`,
    ].join('\n');
    const r = spawnSync('sh', ['-c', `${prelude}\n${engineProbeScript('/api/v1/namespaces/loom-health/services/fhir-x:80/proxy/fhir')}`], { encoding: 'utf8' });
    // Breaks if the script uses sed again: inside $(...) the failed sed leaves V empty while the script still exits 0, so it
    // is the LOOM_FHIR_VERSION assertion that goes red (measured by mutation), not the status. Also breaks if the cut picks
    // the wrong field (the version would differ). The status assertion pins the separate "always exit 0" contract.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^LOOM_PROBE_RC=0$/m);
    expect(r.stdout).toMatch(/^LOOM_CAPABILITY=1$/m);
    expect(r.stdout).toMatch(/^LOOM_FHIR_VERSION=4\.0\.1$/m);
  });

  it.skipIf(!hasSh)('the probe script still exits 0, with no version line, when the body has no fhirVersion', () => {
    // Breaks if an absent version makes the script exit non-zero (probeEngine would then report engine_probe_failed
    // for an engine that answered). Paired positive: the capability marker is still printed.
    const r = spawnSync('sh', ['-c', `kubectl() { printf '%s' '{"resourceType":"CapabilityStatement"}'; }\n${engineProbeScript('/x')}`], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^LOOM_CAPABILITY=1$/m);
    expect(r.stdout).not.toMatch(/LOOM_FHIR_VERSION/);
  });

  it('a proxy failure that is not a refusal is "not ready"; a refusal is permission', async () => {
    const c = new FakeCluster();
    c.proxyRc = 1;
    c.proxyErr = 'Error from server (ServiceUnavailable): no endpoints available';
    expect(await hostOver(c).probeEngine(SLUG)).toEqual({ ready: false, partitions: [] });
    c.proxyErr = 'Error from server (Forbidden): services/proxy is forbidden';
    await expect(hostOver(c).probeEngine(SLUG)).rejects.toMatchObject({ code: 'permission' });
  });

  const WANT = [{ id: 7, name: 'site-a' }, { id: 8, name: 'site-b' }];

  it('the Deployment carries the desired partitions as an annotation and as LOOM_HEALTH_PARTITIONS, and readEngineConfig hands the list back', async () => {
    const c = new FakeCluster();
    const h = hostOver(c);
    const cfg = cfgFor({ partitions: WANT });
    await h.applyEngineConfig(cfg);
    const dep = (JSON.parse(renderEngineManifest(cfg, { image: FHIR_IMAGE, namespace: 'loom-health' })) as { items: Array<Record<string, any>> }).items.find((i) => i.kind === 'Deployment')!;
    expect(dep.metadata.annotations['loom.health/partitions']).toBe('[{"id":7,"name":"site-a"},{"id":8,"name":"site-b"}]');
    expect(dep.spec.template.spec.containers[0].env.find((e: any) => e.name === 'LOOM_HEALTH_PARTITIONS').value).toBe('[{"id":7,"name":"site-a"},{"id":8,"name":"site-b"}]');
    expect((await h.readEngineConfig(SLUG))?.partitions).toEqual(WANT);
  });

  it('ensurePartitions waits for the rollout, reads hfj_partition through the PG job, and passes when every desired row is there', async () => {
    const c = new FakeCluster();
    c.partitions = [{ id: 7, name: 'site-a' }, { id: 8, name: 'site-b' }, { id: 99, name: 'extra' }];
    await hostOver(c).ensurePartitions(SLUG, WANT);
    const rollout = c.commands.findIndex((x) => x.startsWith('kubectl rollout status deployment/fhir-acme-health'));
    const job = c.commands.findIndex((x) => x.includes('"kind":"Job"'));
    expect(rollout, 'a rollout wait was sent').toBeGreaterThanOrEqual(0);
    expect(job, 'a PG job was sent').toBeGreaterThan(rollout);
    expect(c.lastJobEnv.LOOM_SQL_1).toContain('FROM hfj_partition');
    expect(c.lastJobEnv.LOOM_DB_1).toBe(DB);
  });

  it('ensurePartitions fails readback_mismatch, naming the partition, when a desired row is absent (a mismatch is never accepted)', async () => {
    const c = new FakeCluster();
    c.partitions = [{ id: 7, name: 'site-a' }];
    const err = (await hostOver(c).ensurePartitions(SLUG, WANT).catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe('readback_mismatch');
    expect(err.message).toContain('site-b (id 8) is absent');
    expect(err.message).not.toContain('site-a (id 7) is absent'); // the present row is not blamed
    expect(err.message).toContain('Not established: why');
  });

  it('ensurePartitions fails readback_mismatch on a row with the desired name under another id', async () => {
    const c = new FakeCluster();
    c.partitions = [{ id: 7, name: 'site-a' }, { id: 3, name: 'site-b' }];
    await expect(hostOver(c).ensurePartitions(SLUG, WANT)).rejects.toMatchObject({ code: 'readback_mismatch', message: expect.stringContaining('disagrees with the row site-b (id 3)') });
  });

  it('ensurePartitions: an unrolled-out engine and an ungranted table are each their own TRUE error', async () => {
    const a = new FakeCluster();
    a.rolloutExit = 1;
    await expect(hostOver(a).ensurePartitions(SLUG, WANT)).rejects.toMatchObject({ code: 'engine_rollout_failed' });
    expect(a.jobsApplied.length).toBe(1); // exactly one PG job: the read-only cause lookup (it never creates anything)
    expect(a.lastJobEnv.LOOM_SQL_1).toMatch(/^SELECT .* FROM hfj_partition/);
    const b = new FakeCluster();
    b.partitionsDenied = true;
    b.jobFails = false;
    const err = (await hostOver(b).ensurePartitions(SLUG, WANT).catch((e: unknown) => e)) as Error & { code: string };
    // The Job's own psql output is passed through; the host does not guess why the table is unreadable.
    expect(err.code).toBe('pg_job_failed');
    expect(err.message).toContain('permission denied for table hfj_partition');
  });

  it('a failed rollout names a partition conflict only when the table shows one; otherwise it says what was ruled out or that the cause is NOT established', async () => {
    const conflict = new FakeCluster();
    conflict.rolloutExit = 1;
    conflict.partitions = [{ id: 7, name: 'site-x' }, { id: 8, name: 'site-b' }]; // id 7 is taken by another name
    const e1 = (await hostOver(conflict).ensurePartitions(SLUG, WANT).catch((e: unknown) => e)) as Error & { code: string };
    expect(e1.code).toBe('engine_rollout_failed');
    expect(e1.message).toContain('site-a (id 7) disagrees with the row site-x (id 7)');
    expect(e1.message).toContain('partitions.conflict');
    const clean = new FakeCluster();
    clean.rolloutExit = 1;
    clean.partitions = [{ id: 7, name: 'site-a' }];
    const e2 = (await hostOver(clean).ensurePartitions(SLUG, WANT).catch((e: unknown) => e)) as Error;
    expect(e2.message).toContain('a partition conflict is ruled out');
    expect(e2.message).not.toContain('disagrees');
    const unreadable = new FakeCluster();
    unreadable.rolloutExit = 1;
    unreadable.partitionsDenied = true;
    const e3 = (await hostOver(unreadable).ensurePartitions(SLUG, WANT).catch((e: unknown) => e)) as Error;
    expect(e3.message).toContain('hfj_partition could not be read; the cause is NOT established');
    expect(e3.message).not.toContain('ruled out');
  });

  it('readPartitionRows returns the rows, and undefined (not an empty list) when the table cannot be read', async () => {
    const c = new FakeCluster();
    c.partitions = [{ id: 1, name: 'site-a' }];
    expect(await hostOver(c).readPartitionRows(SLUG)).toEqual([{ id: 1, name: 'site-a' }]);
    c.partitionsDenied = true;
    expect(await hostOver(c).readPartitionRows(SLUG)).toBeUndefined();
  });

  it('NO command the host sends ever touches $partition-management-* (the engine answers 401 there); the positive controls are the PG job and /metadata', async () => {
    const c = new FakeCluster();
    const h = hostOver(c);
    await h.applyEngineConfig(cfgFor({ partitions: WANT }));
    await h.probeEngine(SLUG);
    await h.probeEngine(SLUG, { partitions: true });
    await h.ensurePartitions(SLUG, WANT);
    expect(c.commands.filter((x) => /partition-management/.test(x))).toEqual([]);
    expect(c.commands.some((x) => x.includes('/proxy/fhir/metadata'))).toBe(true);
    expect(c.commands.some((x) => x.includes('FROM hfj_partition') || x.includes('"kind":"Job"'))).toBe(true);
  });

  it('probeEngine({partitions:true}) takes its partition names from the DATABASE, and still checks /metadata through the proxy', async () => {
    const c = new FakeCluster();
    c.partitions = [{ id: 7, name: 'site-a' }, { id: 8, name: 'site-b' }];
    expect(await hostOver(c).probeEngine(SLUG, { partitions: true })).toEqual({ ready: true, fhirVersion: '4.0.1', partitions: ['site-a', 'site-b'] });
    c.partitionsDenied = true;
    await expect(hostOver(c).probeEngine(SLUG, { partitions: true })).rejects.toMatchObject({ code: 'pg_job_failed' }); // an unreadable table is never reported as "no partitions"
  });

  it('removeEngine deletes the three objects by name and fails teardown_incomplete when one is still listed', async () => {
    const ok = new FakeCluster();
    await hostOver(ok).applyEngineConfig(cfgFor());
    await hostOver(ok).removeEngine(SLUG);
    expect(await hostOver(ok).readEngineConfig(SLUG)).toBeUndefined();
    expect(ok.commands.some((x) => x.startsWith(`kubectl delete deployment/fhir-${SLUG} service/fhir-${SLUG} serviceaccount/fhir-${SLUG} networkpolicy/fhir-${SLUG} -n loom-health`))).toBe(true);
    const stuck = new FakeCluster();
    await hostOver(stuck).applyEngineConfig(cfgFor());
    stuck.deleteLeavesWorkload = true;
    await expect(hostOver(stuck).removeEngine(SLUG)).rejects.toMatchObject({ code: 'teardown_incomplete' });
  });

  it('removeEngine reads the NetworkPolicy back: a policy left behind ALONE is teardown_incomplete', async () => {
    const c = new FakeCluster();
    await hostOver(c).applyEngineConfig(cfgFor());
    expect(c.policyPresent).toBe(true); // positive: the fake saw the policy in the applied manifest
    c.deleteLeavesPolicy = true; // deployment, service and serviceaccount go; ONLY the policy stays
    await expect(hostOver(c).removeEngine(SLUG)).rejects.toMatchObject({ code: 'teardown_incomplete', message: expect.stringContaining(`networkpolicy.networking.k8s.io/fhir-${SLUG}`) });
    expect(c.workloadPresent).toBe(false);
    const get = c.commands.find((x) => x.startsWith('kubectl get deployment/') && x.includes('-o name'));
    expect(get).toContain(`networkpolicy/fhir-${SLUG}`); // breaks when the read-back GET drops the policy
  });

  it('refuses an unpinned PG client image at construction', () => {
    expect(() => new RunCommandFhirEngineHost({ run: new FakeCluster(), target: async () => TARGET, fhirImage: FHIR_IMAGE, pgClientImage: 'acrx.azurecr.io/postgres:16-alpine', pgScope: 's' })).toThrow(/pinned by digest/);
  });

  it('refuses a stamp with no pgAdminIdentity name (B2a output) before sending anything', async () => {
    const c = new FakeCluster();
    const h = new RunCommandFhirEngineHost({ run: c, target: async () => ({ ...TARGET, pgAdminName: '' }), fhirImage: FHIR_IMAGE, pgClientImage: PG_IMAGE, pgScope: 's', sleep: async () => {} });
    await expect(h.readDatabaseRole(SLUG, IDENT.name)).rejects.toMatchObject({ code: 'stamp_manifest_incomplete' });
    expect(c.commands).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────── end to end through the jobs

function e2e() {
  const stamps = new MemoryCollection<StampDoc>();
  const tenants = new MemoryCollection<TenantDoc>();
  const jobsStore = new MemoryCollection<JobDoc>();
  const ts = '2026-11-16T00:00:00.000Z';
  stamps.docs.set('dev01', { id: 'dev01', displayName: 'Dev', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy', baseUrl: 'https://x.example', engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
  tenants.docs.set(SLUG, { id: SLUG, displayName: 'Acme', stampId: 'dev01', status: 'active', quotas: { maxRequestsPerMinute: 600, maxStorageGiB: 100 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
  const pgId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg';
  const arm = {
    async getStampManifest() {
      return { state: 'found' as const, value: { postgresFqdn: PG_FQDN, postgresServerId: pgId, aksClusterName: 'aks-lhds-dev01', pgAdminIdentity: { name: TARGET.pgAdminName, clientId: 'c', principalId: 'p' } } };
    },
    async getTenantManifest() {
      return { state: 'found' as const, value: { fhirIdentity: { id: 'i', ...IDENT } } };
    },
    async readResource(id: string) {
      return { id, exists: true, name: DB };
    },
  } as unknown as TenantArm;
  const cluster = new FakeCluster();
  const host = new RunCommandFhirEngineHost({ run: cluster, target: armEngineTarget({ stamps, tenants, arm }), fhirImage: FHIR_IMAGE, pgClientImage: PG_IMAGE, pgScope: 's', sleep: async () => {}, jobMaxPolls: 3, log: () => {} });
  const runner = new JobRunner(jobsStore, async (_t, i) => i === SLUG, () => {});
  for (const h of fhirTenantHandlers({ stamps, tenants, arm, engine: host, pdpUrl: PDP })) runner.register(h);
  const run = async (kind: 'fhir-tenant.create' | 'fhir-tenant.teardown', key: string, input: Record<string, unknown> = {}) => {
    const { job } = await runner.submit({ kind, subjectType: 'tenant', subjectId: SLUG, idempotencyKey: key, input, requestedBy: 't' });
    await runner.idle();
    return runner.get(job.id);
  };
  return { cluster, run, tenants };
}

describe('fhir-tenant.create through the production host', () => {
  it('provisions the principal, applies the engine, and succeeds when the engine reports FHIR 4.0.1', async () => {
    const { cluster, run } = e2e();
    const job = await run('fhir-tenant.create', 'k1', { partitions: ['site-a'] });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(cluster.roleExists).toBe(true);
    expect(cluster.deployment?.part).toBe('true');
    expect(cluster.partitions.map((p) => p.name)).toEqual(['site-a']);
    expect(cluster.jobsDeleted.length).toBe(cluster.jobsApplied.length);
  });

  it('an engine reporting FHIR 4.0.0 fails readback_mismatch naming 4.0.0 (4.0.1 passes in the test above)', async () => {
    const { cluster, run } = e2e();
    cluster.fhirVersion = '4.0.0';
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain('4.0.0');
    expect(job.error?.message).toContain('4.0.1');
  });

  it('an engine whose CapabilityStatement is not served is engine_not_ready, not success', async () => {
    const { cluster, run } = e2e();
    cluster.capability = false;
    expect((await run('fhir-tenant.create', 'k1')).error?.code).toBe('engine_not_ready');
  });

  it('a principal that can reach another tenant database fails role_not_isolated and NO engine is applied', async () => {
    const { cluster, run } = e2e();
    cluster.roleDbs = [DB, 'lhds_other_co'];
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('role_not_isolated');
    expect(job.error?.message).toContain('lhds_other_co');
    expect(cluster.deployment).toBeUndefined();
  });

  it('a failing PG Job surfaces its true error through the job and applies no engine', async () => {
    const { cluster, run } = e2e();
    cluster.jobFails = true;
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('pg_job_failed');
    expect(job.error?.message).toContain('FATAL');
    expect(cluster.deployment).toBeUndefined();
  });

  it('a re-run applies nothing new to the engine (the Deployment revision is unchanged) and keeps the principal', async () => {
    const { cluster, run } = e2e();
    await run('fhir-tenant.create', 'k1');
    const applies = cluster.commands.filter((x) => x.includes('"kind":"List"')).length;
    const again = await run('fhir-tenant.create', 'k2');
    expect(again.state, JSON.stringify(again.error)).toBe('succeeded');
    expect(cluster.commands.filter((x) => x.includes('"kind":"List"')).length).toBe(applies);
    expect(again.receipts.map((r) => r.step)).toContain('config.unchanged');
  });
});

// ────────────────────────────────────────────────────────────── compose gating + config

describe('compose gating of the fhir-tenant.* kinds', () => {
  const noopHost = new FakeCluster();
  const host = hostOver(noopHost);
  const fakeArm = {} as TenantArm;
  const build = (fhirEngine: { host: typeof host; pdpUrl: string } | undefined, tenantArm: TenantArm | undefined) => {
    const stores = memoryStores();
    const ts = '2026-11-16T00:00:00.000Z';
    (stores.tenants as unknown as MemoryCollection<TenantDoc>).docs.set(SLUG, { id: SLUG, displayName: 'A', stampId: 'dev01', status: 'active', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e' });
    const app = compose({
      stores,
      auth: { authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [], keyResolver: testKeyResolver },
      sloAvailabilityTarget: 0.999,
      log: () => {},
      tenantArm,
      fhirEngine,
    });
    return (kind: string) => app.jobs.submit({ kind, subjectType: 'tenant', subjectId: SLUG, idempotencyKey: `k-${kind}`, input: { partitions: [] }, requestedBy: 't' });
  };

  it('registers create/configure/teardown when host, ARM adapter and PDP url are all present', async () => {
    const submit = build({ host, pdpUrl: PDP }, fakeArm);
    await expect(submit('fhir-tenant.create')).resolves.toBeDefined();
    // Positive control for the rejections below: the kind exists, so "unknown job kind" is not a blanket answer.
    await expect(submit('fhir-tenant.nonsense')).rejects.toThrow(/unknown job kind/);
  });

  it('fails CLOSED with an EMPTY pdpUrl: the kind answers unknown job kind', async () => {
    await expect(build({ host, pdpUrl: '' }, fakeArm)('fhir-tenant.create')).rejects.toThrow(/unknown job kind/);
    await expect(build({ host, pdpUrl: '   ' }, fakeArm)('fhir-tenant.create')).rejects.toThrow(/unknown job kind/);
  });

  it('is absent without a host, and without the ARM adapter', async () => {
    await expect(build(undefined, fakeArm)('fhir-tenant.create')).rejects.toThrow(/unknown job kind/);
    await expect(build({ host, pdpUrl: PDP }, undefined)('fhir-tenant.create')).rejects.toThrow(/unknown job kind/);
  });
});

describe('loadFhirEngineConfig', () => {
  const digest = `acrx.azurecr.io/postgres@sha256:${'b'.repeat(64)}`;
  it('is off when neither image is set, and refuses one without the other (names the missing variable)', () => {
    expect(loadFhirEngineConfig('commercial', {})).toBeUndefined();
    expect(() => loadFhirEngineConfig('commercial', { LOOM_HEALTH_CP_FHIR_IMAGE: FHIR_IMAGE })).toThrow(/LOOM_HEALTH_CP_PG_CLIENT_IMAGE/);
  });
  it('requires the PG client image pinned by digest and picks the cloud token scope', () => {
    expect(() => loadFhirEngineConfig('commercial', { LOOM_HEALTH_CP_FHIR_IMAGE: FHIR_IMAGE, LOOM_HEALTH_CP_PG_CLIENT_IMAGE: 'acrx.azurecr.io/postgres:16-alpine' })).toThrow(/pinned by digest/);
    const env = { LOOM_HEALTH_CP_FHIR_IMAGE: FHIR_IMAGE, LOOM_HEALTH_CP_PG_CLIENT_IMAGE: digest };
    expect(loadFhirEngineConfig('commercial', env)?.pgScope).toBe('https://ossrdbms-aad.database.windows.net/.default');
    expect(loadFhirEngineConfig('gcc-high', env)?.pgScope).toBe('https://ossrdbms-aad.database.usgovcloudapi.net/.default');
  });
});

// ────────────────────────────────────────────────────────────── rework round 1

describe('teardown when the tenant database is already gone, and ensure for a re-created slug', () => {
  it('removePrincipalSteps guards ONLY the in-database step; DROP ROLE in postgres is unguarded', () => {
    const [inDb, inPostgres] = removePrincipalSteps(IDENT.name, DB);
    expect(inDb?.requireDb).toBe(DB);
    expect(inPostgres?.requireDb).toBeUndefined(); // a guard here would skip DROP ROLE exactly when the DB is gone
    expect(inPostgres?.sql).toContain(`DROP ROLE "${IDENT.name}"`);
    const script = pgJobScript(removePrincipalSteps(IDENT.name, DB));
    expect(script).toContain('LOOM_SKIPPED_1=database_absent');
    expect(script).not.toContain('LOOM_SKIPPED_2');
  });

  it('with the tenant database absent, teardown still drops the role and does not fail on "database does not exist"', async () => {
    const c = new FakeCluster();
    c.roleExists = true;
    c.dbAbsent = true;
    await hostOver(c).removeDatabaseRole(SLUG, IDENT.name);
    expect(c.roleExists).toBe(false); // true would mean DROP ROLE never ran
  });

  it('with the database present the same teardown also runs the in-database step first', async () => {
    const c = new FakeCluster();
    c.roleExists = true;
    await hostOver(c).removeDatabaseRole(SLUG, IDENT.name);
    expect(c.lastJobEnv.LOOM_REQ_DB_1).toBe(DB);
    expect(c.roleExists).toBe(false);
  });

  it('ensure replaces a role bound to an OLD Entra object id and binds the new one (same name, new UAMI)', async () => {
    const c = new FakeCluster();
    c.roleExists = true;
    c.roleOid = PID2; // stale: the destroyed tenant's identity
    await hostOver(c).ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID });
    expect(c.roleExists).toBe(true);
    expect(c.roleOid).toBe(PID); // PID2 would mean the stale binding was kept
  });

  it('ensure leaves a role already bound to the CURRENT object id alone (no drop)', async () => {
    const c = new FakeCluster();
    c.roleExists = true;
    c.roleOid = PID;
    await hostOver(c).ensureDatabaseRole({ tenantId: SLUG, databaseName: DB, roleName: IDENT.name, principalId: PID });
    expect(c.roleOid).toBe(PID);
    const sql = ensurePrincipalSteps(IDENT.name, DB, PID)[0]?.sql ?? '';
    // The oid is interpolated lower-cased and differs per identity: two ids must give two statements.
    expect(sql).toContain(`oid=${PID}`);
    expect(ensurePrincipalSteps(IDENT.name, DB, PID2)[0]?.sql).not.toBe(sql);
    expect(sql.indexOf('DROP ROLE')).toBeLessThan(sql.indexOf('pgaadauth_create_principal'));
  });

  it('refuses a malformed object id before sending anything', () => {
    expect(() => ensurePrincipalSteps(IDENT.name, DB, "x' OR '1'='1")).toThrow(/malformed Entra object id/);
  });
});

describe('engine image pin', () => {
  const mk = (fhirImage: string) => () => new RunCommandFhirEngineHost({ run: new FakeCluster(), target: async () => TARGET, fhirImage, pgClientImage: PG_IMAGE, pgScope: 's' });
  it('refuses :latest, an untagged reference (also behind a registry port) and accepts an explicit tag or a digest', () => {
    expect(mk('acrx.azurecr.io/loom-health-fhir:latest')).toThrow(/fhir engine image must carry an explicit tag/i);
    expect(mk('acrx.azurecr.io/loom-health-fhir:LATEST')).toThrow(/explicit tag/);
    expect(mk('acrx.azurecr.io/loom-health-fhir')).toThrow(/explicit tag/);
    expect(mk('acrx.azurecr.io:5000/loom-health-fhir')).toThrow(/explicit tag/); // the port colon is not a tag
    expect(mk('acrx.azurecr.io/loom-health-fhir:v0.1')).not.toThrow();
    expect(mk(`acrx.azurecr.io/loom-health-fhir@sha256:${'c'.repeat(64)}`)).not.toThrow();
  });
  it('the config loader refuses the same, naming the variable', () => {
    const base = { LOOM_HEALTH_CP_PG_CLIENT_IMAGE: `acrx.azurecr.io/postgres@sha256:${'b'.repeat(64)}` };
    expect(() => loadFhirEngineConfig('commercial', { ...base, LOOM_HEALTH_CP_FHIR_IMAGE: 'acrx.azurecr.io/loom-health-fhir:latest' })).toThrow(/LOOM_HEALTH_CP_FHIR_IMAGE.*latest/);
    expect(() => loadFhirEngineConfig('commercial', { ...base, LOOM_HEALTH_CP_FHIR_IMAGE: 'acrx.azurecr.io/loom-health-fhir' })).toThrow(/LOOM_HEALTH_CP_FHIR_IMAGE/);
    expect(loadFhirEngineConfig('commercial', { ...base, LOOM_HEALTH_CP_FHIR_IMAGE: FHIR_IMAGE })?.fhirImage).toBe(FHIR_IMAGE);
  });
});

// #5482 item 6: one runCommand lists every managed engine of a stamp for the drift reconciler. kubectl's real jsonpath output is NOT
// exercised here (the fake prints the line); the key names are pinned against the manifest constants instead.
describe('listEngineConfigs (engine drift reconciler)', () => {
  /** What kubectl would print for the cluster's one Deployment, in the field order engineListCommand asks for. */
  function listing(c: FakeCluster, over: Partial<Record<'tenant' | 'name', string>> = {}): string {
    if (!c.deployment) return 'LOOM_LIST_DONE=1\n';
    const d = c.deployment;
    const cols = [`LOOM_ENGINE=${over.tenant ?? SLUG}`, `NAME=${over.name ?? `fhir-${SLUG}`}`, `REV=${d.rev}`, `PART=${d.part}`, `OVR=${d.ovr}`, `PARTS=${c.partsAnnotation}`];
    return [cols.join('\t'), 'LOOM_LIST_DONE=1', ''].join('\n');
  }
  function listingHost(c: FakeCluster, logs: (c: FakeCluster) => string) {
    const run = c.run.bind(c);
    c.run = async (t, cmd) => {
      if (!cmd.includes('kubectl get deployments -n')) return run(t, cmd);
      c.commands.push(cmd);
      return { exitCode: 0, logs: logs(c) };
    };
    return new RunCommandFhirEngineHost({ run: c, target: async () => TARGET, stampTarget: async () => TARGET, fhirImage: FHIR_IMAGE, pgClientImage: PG_IMAGE, pgScope: 'x', sleep: async () => {}, log: () => {} });
  }

  it('lists what readEngineConfig reads, for the same Deployment, in one command', async () => {
    const c = new FakeCluster();
    const h = listingHost(c, (x) => listing(x));
    await h.applyEngineConfig(cfgFor({ overrides: { maxPageSize: 50 }, partitions: [{ id: 1, name: 'north' }] }));
    const before = c.commands.length;
    const listed = await h.listEngineConfigs('dev01');
    expect(c.commands.length - before).toBe(1); // one runCommand per stamp; N would be the per-tenant cost this exists to avoid
    // Breaks if a field is mis-mapped (e.g. OVR read as PARTS): the two reads of the same Deployment would disagree.
    expect(listed).toEqual([{ tenantId: SLUG, config: await h.readEngineConfig(SLUG) }]);
    expect(listed[0]?.config?.overrides).toEqual({ maxPageSize: 50 });
    expect(listed[0]?.config?.partitions).toEqual([{ id: 1, name: 'north' }]);
  });

  it('the jsonpath names exactly the annotations the manifest writes (lifted from the constants, not retyped)', () => {
    const cmd = engineListCommand('loom-health');
    const esc = (a: string) => a.replaceAll('.', '\\.');
    // Breaks on a typo in any annotation key: kubectl prints an empty value for an unknown key, and the engine would read as unmanaged.
    for (const ann of [ANN_REVISION, ANN_PARTITIONING, ANN_OVERRIDES, ANN_PARTITIONS]) expect(cmd).toContain(`{.metadata.annotations.${esc(ann)}}`);
    expect(cmd).toContain('-l app.kubernetes.io/managed-by=loom-health-cp');
    expect(cmd).toContain('{.metadata.labels.loom\\.health/tenant}');
    expect(cmd.trimEnd().endsWith('echo LOOM_LIST_DONE=1')).toBe(true);
  });

  it('a listing without its completion marker is engine_list_unproven, never "no engines"', async () => {
    // Breaks if the marker check is removed: an empty, unproven listing would read as a stamp with no engines.
    await expect(listingHost(new FakeCluster(), () => '').listEngineConfigs('dev01')).rejects.toMatchObject({ code: 'engine_list_unproven' });
    await expect(listingHost(new FakeCluster(), () => 'LOOM_LIST_DONE=1\n').listEngineConfigs('dev01')).resolves.toEqual([]);
  });

  it('an entry whose name is not its tenant workload, or that has no revision, comes back as a problem with no config', async () => {
    const c = new FakeCluster();
    const h = listingHost(c, (x) => listing(x, { name: 'fhir-other-co' }));
    await h.applyEngineConfig(cfgFor());
    // Breaks if NAME is not checked against the tenant label: a mislabelled Deployment would be re-rendered as acme-health.
    expect(await h.listEngineConfigs('dev01')).toEqual([{ tenantId: SLUG, problem: 'engine_list_malformed' }]);
    const noRev = [`LOOM_ENGINE=${SLUG}`, `NAME=fhir-${SLUG}`, 'REV=', 'PART=true', 'OVR={}', 'PARTS=[]'].join('\t');
    expect(parseEngineList(noRev, 'loom-health')).toEqual([{ tenantId: SLUG, problem: 'engine_unmanaged' }]);
  });

  it('without a stamp target the host refuses to list (the reconciler then logs it), rather than answer empty', async () => {
    await expect(hostOver(new FakeCluster()).listEngineConfigs('dev01')).rejects.toMatchObject({ code: 'engine_list_unavailable' });
  });
});
