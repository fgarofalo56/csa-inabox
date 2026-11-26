// #5482 item 6: the engine drift reconciler. Engines are created through the REAL fhir-tenant.create job (so "current" is current by
// construction, never a hand-copied hash); a stale engine is one whose running revision is what this control plane rendered BEFORE the
// edge-router peer (#5481), computed from the same render with the pre-edge peer list. Every assertion names the value that breaks it.

import { describe, expect, it } from 'vitest';
import { ENGINE_INGRESS_PEERS, renderEngineConfig } from '../src/jobs/fhir-tenant-config.js';
import { fhirTenantHandlers, RECONCILE_KIND, type AppliedEngineConfig, type EngineProbe, type FhirEngineHost, type ListedEngine, type RoleReadback } from '../src/jobs/fhir-tenant-jobs.js';
import { reconcileEnginesOnce, reconcileKey, type ReconcileDeps } from '../src/jobs/fhir-engine-reconcile.js';
import { JobRunner } from '../src/jobs/runner.js';
import { stampResourceGroup, type TenantArm } from '../src/jobs/tenant-arm.js';
import type { JobDoc } from '../src/jobs/types.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { MemoryCollection } from './helpers.js';

const STAMP = 'dev01';
const RG = stampResourceGroup(STAMP, 'eastus2');
const PG_ID = `/subscriptions/s/resourceGroups/${RG}/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg`;
const PG_FQDN = 'pg-dev01.postgres.database.azure.com';
const PG_ADMIN = `id-lhds-${STAMP}-pgadmin`;
const PDP = 'http://pdp.lhds.svc.cluster.local:8181';
const BASE = 'https://x.example';
const RPM = 600;
const NOW = new Date('2026-11-25T10:00:00.000Z');
// Two builds of loom-health-fhir as deploy-health pins them (#5439): same registry and repository, different digests.
const IMG_BUILD_1 = `acrx.azurecr.io/loom-health-fhir@sha256:${'1'.repeat(64)}`;
const IMG_BUILD_2 = `acrx.azurecr.io/loom-health-fhir@sha256:${'2'.repeat(64)}`;
const ident = (slug: string) => ({ name: `id-lhds-${STAMP}-${slug}-fhir`, clientId: '11111111-2222-3333-4444-555555555555', principalId: 'aaaaaaaa-2222-3333-4444-555555555555' });

/** Several tenants' engines on one stamp. `gate` holds every apply open until released, so a job can be observed queued/running. */
class FakeHost implements FhirEngineHost {
  /** The reference this control plane renders (deploy-health pins it by digest, #5439). A test re-pins it to simulate a new build + deploy. */
  engineImage = IMG_BUILD_1;
  configs = new Map<string, AppliedEngineConfig>();
  applyCalls: Array<{ tenantId: string; revision: string }> = [];
  listCalls = 0;
  listFails = false;
  roleForeign = false;
  gate: Promise<void> | undefined;
  async ensureDatabaseRole() {}
  async readDatabaseRole(tenantId: string): Promise<RoleReadback> {
    const db = `lhds_${tenantId.replaceAll('-', '_')}`;
    return { exists: true, connectableDatabases: this.roleForeign ? [db, 'lhds_other'] : [db] };
  }
  async removeDatabaseRole() {}
  async applyEngineConfig(cfg: { tenantId: string; revision: string; overrides: AppliedEngineConfig['overrides']; partitions: AppliedEngineConfig['partitions'] }) {
    if (this.gate) await this.gate;
    this.applyCalls.push({ tenantId: cfg.tenantId, revision: cfg.revision });
    this.configs.set(cfg.tenantId, { revision: cfg.revision, overrides: cfg.overrides, partitioning: true, partitions: cfg.partitions });
  }
  async readEngineConfig(tenantId: string) {
    const c = this.configs.get(tenantId);
    return c ? structuredClone(c) : undefined;
  }
  async listEngineConfigs(): Promise<ListedEngine[]> {
    this.listCalls++;
    if (this.listFails) throw Object.assign(new Error('x'), { name: 'ArmError' });
    return [...this.configs].map(([tenantId, config]) => ({ tenantId, config: structuredClone(config) }));
  }
  /** The engine reports the partitions its applied config carries (it creates them itself at startup). */
  async probeEngine(tenantId: string): Promise<EngineProbe> {
    return { ready: true, fhirVersion: '4.0.1', partitions: (this.configs.get(tenantId)?.partitions ?? []).map((p) => p.name) };
  }
  async readPartitionRows() {
    return undefined;
  }
  async ensurePartitions() {}
  async removeEngine() {}
}

// Not `implements Partial<TenantArm>`: the manifest values are partial fixtures, cast once where the deps are built.
class FakeArm {
  async getStampManifest() {
    return { state: 'found' as const, value: { postgresFqdn: PG_FQDN, postgresServerId: PG_ID, pgAdminIdentity: { name: PG_ADMIN } } };
  }
  async getTenantManifest(_rg: string, slug: string) {
    return { state: 'found' as const, value: { fhirIdentity: { id: 'x', ...ident(slug) } } };
  }
  async readResource(id: string) {
    return { id, exists: true, name: id.split('/').pop() };
  }
}

function setup(slugs: string[]) {
  const stamps = new MemoryCollection<StampDoc>();
  const tenants = new MemoryCollection<TenantDoc>();
  const jobsStore = new MemoryCollection<JobDoc>();
  const ts = '2026-11-16T00:00:00.000Z';
  stamps.docs.set(STAMP, { id: STAMP, displayName: 'Dev', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy', baseUrl: BASE, engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
  for (const id of slugs) {
    tenants.docs.set(id, { id, displayName: id, stampId: STAMP, status: 'active', quotas: { maxRequestsPerMinute: RPM, maxStorageGiB: 100 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
  }
  const host = new FakeHost();
  const base = { stamps, tenants, arm: new FakeArm() as unknown as TenantArm, engine: host, pdpUrl: PDP };
  /** A control-plane replica: its own runner (its own in-process exclusion) over the SHARED job store. */
  const replica = () => {
    const runner = new JobRunner(jobsStore, async (_t, id) => tenants.docs.has(id), () => {}, () => NOW);
    for (const h of fhirTenantHandlers(base)) runner.register(h);
    const deps: ReconcileDeps = { ...base, jobs: runner, log: () => {}, now: () => NOW };
    return { runner, pass: (over: Partial<ReconcileOverrides> = {}) => reconcileEnginesOnce({ ...deps, ...over }) };
  };
  const a = replica();
  const create = async (id: string) => {
    const { job } = await a.runner.submit({ kind: 'fhir-tenant.create', subjectType: 'tenant', subjectId: id, idempotencyKey: 'c1', requestedBy: 't' });
    await a.runner.idle();
    expect((await a.runner.get(job.id)).state).toBe('succeeded');
  };
  /** The revision this tenant's engine had before the edge peer existed: the same render, the pre-#5481 peer list. */
  const preEdge = (id: string) =>
    renderEngineConfig({ tenantId: id, stampId: STAMP, stampBaseUrl: BASE, postgresFqdn: PG_FQDN, identity: ident(id), maxRequestsPerMinute: RPM, pdpUrl: PDP, pgAdminName: PG_ADMIN, partitions: [], ingressPeers: ENGINE_INGRESS_PEERS }).revision;
  /** Create the engine through the real job, then make it run the pre-edge revision (the dev01 tenant's state). Returns [stale, fresh]. */
  const makeStale = async (id: string): Promise<[string, string]> => {
    await create(id);
    const c = host.configs.get(id) as AppliedEngineConfig;
    const fresh = c.revision;
    const stale = preEdge(id);
    // Fixture check: if these were equal the "stale" tests would be testing an engine that is not stale.
    expect(stale).not.toBe(fresh);
    expect(stale).toMatch(/^[0-9a-f]{64}$/);
    host.configs.set(id, { ...c, revision: stale });
    return [stale, fresh];
  };
  const reconcileJobs = async () => (await jobsStore.list(500)).filter((j) => j.kind === RECONCILE_KIND);
  return { host, tenants, stamps, jobsStore, a, replica, create, makeStale, reconcileJobs };
}
type ReconcileOverrides = Pick<ReconcileDeps, 'maxInflight' | 'maxAttempts'>;

describe('engine drift reconciler (#5482 item 6)', () => {
  it('a stale revision submits exactly one reconcile, which re-applies the fresh revision once', async () => {
    const s = setup(['acme-health']);
    const [stale, fresh] = await s.makeStale('acme-health');
    const applied = s.host.applyCalls.length; // 1, from create
    const pass = await s.a.pass();
    await s.a.runner.idle();
    // Breaks if the comparison is skipped or inverted: submitted would be [] and current ['acme-health'].
    expect(pass.submitted).toEqual(['acme-health']);
    const jobs = await s.reconcileJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state, JSON.stringify(jobs[0]?.error)).toBe('succeeded');
    expect(jobs[0]?.input).toEqual({ expectedRevision: fresh, runningRevision: stale });
    expect(jobs[0]?.idempotencyKey).toBe(reconcileKey(fresh, stale, NOW));
    // Exactly one more apply, of the fresh revision (2 more = the job applied twice; the stale one = it re-applied what was running).
    expect(s.host.applyCalls.slice(applied)).toEqual([{ tenantId: 'acme-health', revision: fresh }]);
    expect(s.host.configs.get('acme-health')?.revision).toBe(fresh);
    // And the engine is current afterwards: a further pass submits nothing.
    const after = await s.a.pass();
    expect([after.current, after.submitted]).toEqual([['acme-health'], []]);
  });

  it('#5439: a re-pinned engine image (new build + deploy-health) makes every EXISTING engine stale, and one pass re-applies each once', async () => {
    const s = setup(['acme-health', 'beta-clinic']);
    await s.create('acme-health');
    await s.create('beta-clinic');
    const before = new Map([...s.host.configs].map(([id, c]) => [id, c.revision]));
    const applied = s.host.applyCalls.length; // 2, from the creates
    // Fixture check: the two references differ, so the test is not re-pinning to the same value.
    expect(IMG_BUILD_2).not.toBe(IMG_BUILD_1);
    // The control plane restarts on the new LOOM_HEALTH_CP_FHIR_IMAGE: nothing else changed (same tenants, quotas, stamp, PDP).
    s.host.engineImage = IMG_BUILD_2;
    const pass = await s.a.pass();
    await s.a.runner.idle();
    // Input that breaks it: a revision that ignores the image renders the SAME revision for both builds, so submitted is [] and
    // current is both tenants -- the engines keep running the old jar forever (the measured defect).
    expect([...pass.submitted].sort()).toEqual(['acme-health', 'beta-clinic']);
    expect(pass.current).toEqual([]);
    const reapplied = s.host.applyCalls.slice(applied);
    expect(reapplied.map((c) => c.tenantId).sort()).toEqual(['acme-health', 'beta-clinic']);
    for (const c of reapplied) expect(c.revision).not.toBe(before.get(c.tenantId));
    // Settled: a second pass on the same image submits nothing (breaks on a term that is not deterministic, e.g. hashes a timestamp).
    const after = await s.a.pass();
    expect([[...after.current].sort(), after.submitted]).toEqual([['acme-health', 'beta-clinic'], []]);
  });

  it('an equal revision submits nothing and applies nothing', async () => {
    const s = setup(['acme-health']);
    await s.create('acme-health');
    const pass = await s.a.pass();
    await s.a.runner.idle();
    // Breaks if every listed engine is submitted regardless of revision: submitted ['acme-health'] and one reconcile job.
    expect(pass.current).toEqual(['acme-health']);
    expect(pass.submitted).toEqual([]);
    expect(await s.reconcileJobs()).toHaveLength(0);
    expect(s.host.applyCalls).toHaveLength(1); // the create's apply only
    expect(s.host.listCalls).toBe(1); // one list per stamp per pass, never one per tenant
  });

  it('a second pass and a second replica on the same drift land on the SAME job: one job, one apply', async () => {
    const s = setup(['acme-health']);
    await s.makeStale('acme-health');
    const applied = s.host.applyCalls.length;
    let release!: () => void;
    s.host.gate = new Promise((r) => (release = r));
    const b = s.replica();
    // Two replicas start together, then the first replica's timer fires again while the job is still held open.
    const [pa, pb] = await Promise.all([s.a.pass(), b.pass()]);
    const again = await s.a.pass();
    // Breaks if the key carries anything per-call (a timestamp, a random id, the replica): the store would hold 2 or 3 jobs.
    expect(await s.reconcileJobs()).toHaveLength(1);
    expect([...pa.submitted, ...pb.submitted]).toEqual(['acme-health']);
    expect([...pa.pending, ...pb.pending, ...again.pending]).toEqual(['acme-health', 'acme-health']);
    expect(again.submitted).toEqual([]);
    release();
    s.host.gate = undefined;
    await Promise.all([s.a.runner.idle(), b.runner.idle()]);
    expect(s.host.applyCalls.length - applied).toBe(1);
  });

  it('never touches a creating or destroying tenant, while an active stale neighbour on the same stamp is reconciled', async () => {
    const s = setup(['acme-health', 'beta-clinic', 'gamma-care']);
    for (const id of ['acme-health', 'beta-clinic', 'gamma-care']) await s.makeStale(id);
    const doc = (id: string) => s.tenants.docs.get(id) as TenantDoc;
    s.tenants.docs.set('beta-clinic', { ...doc('beta-clinic'), status: 'creating' });
    s.tenants.docs.set('gamma-care', { ...doc('gamma-care'), status: 'destroying' });
    const pass = await s.a.pass();
    await s.a.runner.idle();
    // Breaks if the status filter is removed: beta-clinic and gamma-care would be submitted too.
    expect(pass.submitted).toEqual(['acme-health']);
    expect(pass.skipped).toEqual([
      { tenantId: 'beta-clinic', reason: 'tenant_creating' },
      { tenantId: 'gamma-care', reason: 'tenant_destroying' },
    ]);
    expect((await s.reconcileJobs()).map((j) => j.subjectId)).toEqual(['acme-health']);
  });

  it('bounds the fan-out: three stale tenants with a ceiling of 2 submit 2 and defer 1', async () => {
    const s = setup(['acme-health', 'beta-clinic', 'gamma-care']);
    for (const id of ['acme-health', 'beta-clinic', 'gamma-care']) await s.makeStale(id);
    let release!: () => void;
    s.host.gate = new Promise((r) => (release = r));
    const pass = await s.a.pass({ maxInflight: 2 });
    // Breaks if the ceiling is not enforced: submitted would hold all 3 and deferred none.
    expect(pass.submitted).toHaveLength(2);
    expect(pass.deferred).toHaveLength(1);
    // The ceiling counts jobs already in the store: with 2 in flight a second pass submits nothing.
    expect((await s.a.pass({ maxInflight: 2 })).submitted).toEqual([]);
    release();
    s.host.gate = undefined;
    await s.a.runner.idle();
    expect((await s.a.pass({ maxInflight: 2 })).submitted).toEqual(pass.deferred);
  });

  it('retries a failed reconcile while attempts < max, then reports it stuck', async () => {
    const s = setup(['acme-health']);
    await s.makeStale('acme-health');
    s.host.roleForeign = true; // the job fails role_not_isolated BEFORE any apply, so the drift persists
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await s.a.pass({ maxAttempts: 3 });
      await s.a.runner.idle();
      outcomes.push(p.submitted.length ? 'submitted' : p.retried.length ? 'retried' : p.stuck.length ? 'stuck' : 'other');
    }
    // Breaks with `<=` (a 4th attempt: retried instead of stuck) or with no retry at all (stuck from the second pass).
    expect(outcomes).toEqual(['submitted', 'retried', 'retried', 'stuck']);
    const [job] = await s.reconcileJobs();
    expect([job?.state, job?.attempts, job?.error?.code]).toEqual(['failed', 3, 'role_not_isolated']);
  });

  it('a stamp that cannot be listed is reported unlisted and nothing is submitted', async () => {
    const s = setup(['acme-health']);
    await s.makeStale('acme-health');
    s.host.listFails = true;
    const pass = await s.a.pass();
    expect(pass.unlisted).toEqual([{ stampId: STAMP, reason: 'ArmError' }]);
    expect(pass.submitted).toEqual([]);
    // Positive pair: the same tenant IS submitted once the stamp lists.
    s.host.listFails = false;
    expect((await s.a.pass()).submitted).toEqual(['acme-health']);
  });

  it('the job refuses to apply a revision other than the one it was submitted for (revision_moved, nothing applied)', async () => {
    const s = setup(['acme-health']);
    const [stale, fresh] = await s.makeStale('acme-health');
    const applied = s.host.applyCalls.length;
    const other = 'b'.repeat(64);
    const { job } = await s.a.runner.submit({ kind: RECONCILE_KIND, subjectType: 'tenant', subjectId: 'acme-health', idempotencyKey: 'k1', input: { expectedRevision: other, runningRevision: stale }, requestedBy: 't' });
    await s.a.runner.idle();
    const done = await s.a.runner.get(job.id);
    // Breaks if the expected-revision check is removed: the job would succeed and apply the fresh revision.
    expect(done.error?.code).toBe('revision_moved');
    expect(s.host.applyCalls.length).toBe(applied);
    // Positive pair: the same job with the revision this code renders applies it.
    const ok = await s.a.runner.submit({ kind: RECONCILE_KIND, subjectType: 'tenant', subjectId: 'acme-health', idempotencyKey: 'k2', input: { expectedRevision: fresh, runningRevision: stale }, requestedBy: 't' });
    await s.a.runner.idle();
    expect((await s.a.runner.get(ok.job.id)).state).toBe('succeeded');
    expect(s.host.applyCalls.length).toBe(applied + 1);
  });

  it('a reconcile keeps the engine overrides and partitions it re-renders (no data-loss on re-apply)', async () => {
    const s = setup(['acme-health']);
    const run = async (kind: string, key: string, input: Record<string, unknown>) => {
      const { job } = await s.a.runner.submit({ kind, subjectType: 'tenant', subjectId: 'acme-health', idempotencyKey: key, input, requestedBy: 't' });
      await s.a.runner.idle();
      const done = await s.a.runner.get(job.id);
      expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    };
    await run('fhir-tenant.create', 'c1', { partitions: ['north'] });
    await run('fhir-tenant.configure', 'cf1', { maxPageSize: 50 });
    const c = s.host.configs.get('acme-health') as AppliedEngineConfig;
    // Fixture check: the engine really carries a non-default override and a partition before it goes stale.
    expect([c.overrides, c.partitions]).toEqual([{ maxPageSize: 50 }, [{ id: 1, name: 'north' }]]);
    s.host.configs.set('acme-health', { ...c, revision: 'd'.repeat(64) });
    const applied = s.host.applyCalls.length;
    expect((await s.a.pass()).submitted).toEqual(['acme-health']);
    await s.a.runner.idle();
    expect(s.host.applyCalls.length).toBe(applied + 1);
    // Breaks if the reconcile renders from defaults (render(deps, r, {}, [])): overrides {} and partitions [] would be applied.
    const after = s.host.configs.get('acme-health') as AppliedEngineConfig;
    expect(after.overrides).toEqual({ maxPageSize: 50 });
    expect(after.partitions).toEqual([{ id: 1, name: 'north' }]);
    expect(after.revision).toBe(c.revision);
  });

  it('the job refuses at RUN time a tenant that is no longer active (tenant_not_active, zero applies)', async () => {
    const s = setup(['acme-health']);
    const [stale, fresh] = await s.makeStale('acme-health');
    const applied = s.host.applyCalls.length;
    // Flipped after the drift was observed and before the runner executes the job: only the handler's own check can stop it.
    s.tenants.docs.set('acme-health', { ...(s.tenants.docs.get('acme-health') as TenantDoc), status: 'destroying' });
    const { job } = await s.a.runner.submit({ kind: RECONCILE_KIND, subjectType: 'tenant', subjectId: 'acme-health', idempotencyKey: 'k1', input: { expectedRevision: fresh, runningRevision: stale }, requestedBy: 't' });
    await s.a.runner.idle();
    // Breaks if that check is removed: the job succeeds and applies the fresh revision to a tenant being destroyed.
    expect((await s.a.runner.get(job.id)).error?.code).toBe('tenant_not_active');
    expect(s.host.applyCalls.length).toBe(applied);
    // Positive pair: the same submit on the active tenant applies.
    s.tenants.docs.set('acme-health', { ...(s.tenants.docs.get('acme-health') as TenantDoc), status: 'active' });
    const ok = await s.a.runner.submit({ kind: RECONCILE_KIND, subjectType: 'tenant', subjectId: 'acme-health', idempotencyKey: 'k2', input: { expectedRevision: fresh, runningRevision: stale }, requestedBy: 't' });
    await s.a.runner.idle();
    expect((await s.a.runner.get(ok.job.id)).state).toBe('succeeded');
    expect(s.host.applyCalls.length).toBe(applied + 1);
  });

  it('reconcileKey fits the runner key limit and moves with the day (a recurring drift is retried the next day)', () => {
    const r = 'a'.repeat(64);
    const d = 'c'.repeat(64);
    const k = reconcileKey(r, d, NOW);
    expect(k).toMatch(/^[A-Za-z0-9._:-]{1,80}$/); // 81+ chars would be refused by JobRunner.submit
    expect(k).toBe(`rev:${'a'.repeat(32)}:${'c'.repeat(32)}:20261125`);
    expect(reconcileKey(r, d, new Date('2026-11-26T00:00:00.000Z'))).not.toBe(k);
    expect(reconcileKey(r, d, new Date('2026-11-25T23:59:59.000Z'))).toBe(k);
  });
});
