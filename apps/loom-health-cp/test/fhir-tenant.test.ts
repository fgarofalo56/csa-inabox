import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_INTERCEPTOR,
  JDBC_AUTH_PLUGIN,
  PDP_INTERCEPTOR,
  fhirNames,
  poolSizeFor,
  renderEngineConfig,
  type RenderedEngineConfig,
} from '../src/jobs/fhir-tenant-config.js';
import {
  fhirTenantHandlers,
  type AppliedEngineConfig,
  type EngineProbe,
  type FhirEngineHost,
  type RoleReadback,
} from '../src/jobs/fhir-tenant-jobs.js';
import { JobRunner } from '../src/jobs/runner.js';
import { ArmError, stampResourceGroup, tenantNames, type ResourceReadback, type TenantArm } from '../src/jobs/tenant-arm.js';
import type { JobDoc } from '../src/jobs/types.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { MemoryCollection } from './helpers.js';

const STAMP = 'dev01';
const SLUG = 'acme-health';
const RG = stampResourceGroup(STAMP, 'eastus2');
const PG_ID = `/subscriptions/s/resourceGroups/${RG}/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg`;
const PG_FQDN = 'pg-dev01.postgres.database.azure.com';
const PDP = 'http://pdp.lhds.svc.cluster.local:8181';
const DB = tenantNames(STAMP, SLUG).databaseName;
const IDENT = { name: `id-lhds-${STAMP}-${SLUG}-fhir`, clientId: '11111111-2222-3333-4444-555555555555', principalId: 'aaaaaaaa-2222-3333-4444-555555555555' };

const ENGINE_DIR = new URL('../../loom-health-fhir/', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ENGINE_DIR), 'utf8');

const baseInput = { tenantId: SLUG, stampId: STAMP, postgresFqdn: PG_FQDN, identity: IDENT, maxRequestsPerMinute: 600, pdpUrl: PDP };

describe('renderEngineConfig', () => {
  it('points the datasource at the tenant OWN database as its FHIR identity, through the JDBC auth plugin, with no credential', () => {
    const c = renderEngineConfig(baseInput);
    // Input that breaks it: a template that used another tenant's database or the server's admin database.
    expect(c.env.SPRING_DATASOURCE_URL).toBe(`jdbc:postgresql://${PG_FQDN}:5432/${DB}?sslmode=require&authenticationPluginClassName=${JDBC_AUTH_PLUGIN}`);
    // The plugin class name is the contract with lane B2b's image: a changed class breaks this literal.
    expect(JDBC_AUTH_PLUGIN).toBe('com.azure.identity.extensions.jdbc.postgresql.AzurePostgresqlAuthenticationPlugin');
    expect(c.env.SPRING_DATASOURCE_USERNAME).toBe(IDENT.name);
    const other = renderEngineConfig({ ...baseInput, tenantId: 'other-co' });
    expect(other.env.SPRING_DATASOURCE_URL).not.toContain(DB);
    expect(other.env.SPRING_DATASOURCE_URL).toContain('/lhds_other_co?');
    // Positive pair of the absence checks: a datasource exists and carries a username, so deleting the datasource cannot pass.
    expect(Object.keys(c.env)).toContain('SPRING_DATASOURCE_USERNAME');
    expect(Object.keys(c.env).filter((k) => /PASSWORD/i.test(k))).toEqual([]);
    expect('secretRefs' in c).toBe(false);
    expect(Object.values(c.env).some((v) => /password|secret/i.test(v))).toBe(false);
  });

  it('refuses a malformed identity and puts the identity in the revision', () => {
    expect(() => renderEngineConfig({ ...baseInput, identity: { ...IDENT, name: "bad name!" } })).toThrow(/invalid name, client id or principal id/);
    expect(() => renderEngineConfig({ ...baseInput, identity: { ...IDENT, clientId: "not-a-guid" } })).toThrow(/invalid name, client id or principal id/);
    // A re-created identity (new client id) must re-apply: equal revisions would leave the old annotation in place.
    expect(renderEngineConfig({ ...baseInput, identity: { ...IDENT, clientId: '99999999-2222-3333-4444-555555555555' } }).revision).not.toBe(renderEngineConfig(baseInput).revision);
  });

  it('database name equals the one tenant.bicep creates (lifted from the bicep source)', () => {
    const bicep = readFileSync(new URL('../../../platform/fiab/bicep/modules/health/tenant.bicep', import.meta.url), 'utf8');
    const m = /name: '(lhds_)\$\{replace\(tenantSlug, '-', '_'\)\}'/.exec(bicep);
    if (!m?.[1]) throw new Error('database name pattern not found in tenant.bicep');
    // 'abc-d' -> lhds_abc_d: a hyphen kept, or a different prefix, breaks the equality.
    expect(`${m[1]}abc_d`).toBe(fhirNames('abc-d').databaseName);
    expect(fhirNames('abc-d').databaseName).toBe(tenantNames(STAMP, 'abc-d').databaseName);
  });

  it('registers the PDP interceptor BEFORE the audit interceptor, and both exist in the plugin source', () => {
    const c = renderEngineConfig(baseInput);
    const list = c.env.HAPI_FHIR_CUSTOM_INTERCEPTOR_CLASSES?.split(',') ?? [];
    // Swapped order is the input that breaks it: audit would run before authorization.
    expect(list).toEqual([PDP_INTERCEPTOR, AUDIT_INTERCEPTOR]);
    for (const cls of list) {
      const path = `plugin/src/main/java/${cls.replaceAll('.', '/')}.java`;
      expect(read(path), `${path} must declare ${cls.split('.').pop()}`).toContain(`class ${cls.split('.').pop()}`);
    }
  });

  it('every LOOM_HEALTH_* variable it renders is read by the plugin; and the plugin-required ones are rendered', () => {
    const c = renderEngineConfig(baseInput);
    // Every main-source file of the plugin, so a variable read in any class counts (and one read nowhere does not).
    const root = new URL('plugin/src/main/java/', ENGINE_DIR);
    const pluginSrc = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.java'))
      .map((f) => readFileSync(new URL(f.replaceAll('\\', '/'), root), 'utf8'))
      .join('\n');
    const read_ = new Set(pluginSrc.match(/LOOM_HEALTH_[A-Z_]+/g) ?? []);
    const rendered = Object.keys(c.env).filter((k) => k.startsWith('LOOM_HEALTH_'));
    expect(rendered.length).toBeGreaterThanOrEqual(3);
    for (const k of rendered) expect(read_.has(k), `${k} is rendered but the plugin never reads it`).toBe(true);
    // Unset tenant or PDP url makes the plugin answer 503 to everything (README): both must be rendered.
    expect(rendered).toEqual(expect.arrayContaining(['LOOM_HEALTH_TENANT', 'LOOM_HEALTH_PDP_URL']));
    expect(c.env.LOOM_HEALTH_TENANT).toBe(SLUG);
  });

  it('revision is stable for equal input and changes when any rendered value changes', () => {
    const a = renderEngineConfig(baseInput);
    expect(renderEngineConfig({ ...baseInput }).revision).toBe(a.revision);
    // A revision that ignored overrides would make fhir-tenant.configure a no-op.
    expect(renderEngineConfig({ ...baseInput, overrides: { maxPageSize: 50 } }).revision).not.toBe(a.revision);
    expect(renderEngineConfig({ ...baseInput, pdpUrl: 'http://pdp2.lhds.svc:8181' }).revision).not.toBe(a.revision);
  });

  it('caps may only LOWER the file ceiling: 201 is refused, a default above the max is refused', () => {
    expect(() => renderEngineConfig({ ...baseInput, overrides: { maxPageSize: 201 } })).toThrow(); // zod: max 200
    expect(renderEngineConfig({ ...baseInput, overrides: { maxPageSize: 200 } }).env.HAPI_FHIR_MAX_PAGE_SIZE).toBe('200'); // boundary accepted
    expect(() => renderEngineConfig({ ...baseInput, overrides: { maxPageSize: 10, defaultPageSize: 11 } })).toThrow(/defaultPageSize 11 exceeds maxPageSize 10/);
    const c = renderEngineConfig({ ...baseInput, overrides: { maxPageSize: 10 } });
    expect(c.env.HAPI_FHIR_DEFAULT_PAGE_SIZE).toBe('10'); // default 20 would exceed the new max of 10
  });

  it('pool size follows the request quota, clamped to [8, 50]', () => {
    expect(poolSizeFor(1)).toBe(8);
    expect(poolSizeFor(600)).toBe(8); // 4 + 2 = 6 -> clamped up
    expect(poolSizeFor(3000)).toBe(14);
    expect(poolSizeFor(1_000_000)).toBe(50);
    expect(renderEngineConfig({ ...baseInput, maxRequestsPerMinute: 3000 }).env.SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE).toBe('14');
  });

  it('refuses an unusable PostgreSQL host or PDP url with a message that says which', () => {
    expect(() => renderEngineConfig({ ...baseInput, postgresFqdn: '' })).toThrow(/postgresFqdn is not a host name \(got nothing\)/);
    expect(() => renderEngineConfig({ ...baseInput, postgresFqdn: 'bad host!' })).toThrow(/invalid value/);
    expect(() => renderEngineConfig({ ...baseInput, pdpUrl: 'not a url' })).toThrow(/PDP url is not a URL/);
    expect(() => renderEngineConfig({ ...baseInput, pdpUrl: 'http://u:p@pdp:8181' })).toThrow(/without credentials/);
  });
});

describe('config/application.yaml (static policy)', () => {
  const yaml = read('config/application.yaml');
  const lines = yaml.split('\n');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  /** Value of `key:` among the direct children of `parent:` (a deeper-indented block), or undefined. */
  const child = (parent: string, key: string): string | undefined => {
    const p = lines.findIndex((l) => l.trim() === `${parent}:`);
    if (p < 0) return undefined;
    const base = indentOf(lines[p] as string);
    for (let i = p + 1; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      if (indentOf(l) <= base) return undefined;
      const m = new RegExp(`^\\s*${key}:\\s*(\\S+)`).exec(l);
      if (m && indentOf(l) === base + 2) return m[1];
    }
    return undefined;
  };

  it('database_partition_mode_enabled sits UNDER partitioning (a sibling of hapi.fhir is silently ignored by the starter)', () => {
    // Measured on the pinned image: directly under hapi.fhir it logs "Database Partition Mode Enabled: false".
    expect(child('partitioning', 'database_partition_mode_enabled')).toBe('true');
    expect(child('fhir', 'database_partition_mode_enabled')).toBeUndefined();
  });

  it('referential integrity, validation, and the destructive-path switches carry the ADR-003 values', () => {
    expect(child('fhir', 'enforce_referential_integrity_on_write')).toBe('true');
    expect(child('fhir', 'enforce_referential_integrity_on_delete')).toBe('true');
    expect(child('validation', 'requests_enabled')).toBe('true');
    expect(child('fhir', 'expunge_enabled')).toBe('false');
    expect(child('fhir', 'allow_multiple_delete')).toBe('false');
    expect(child('fhir', 'allow_external_references')).toBe('false');
    expect(child('partitioning', 'allow_references_across_partitions')).toBe('false');
  });
});

// ---------------------------------------------------------------- jobs

class FakeHost implements FhirEngineHost {
  config: AppliedEngineConfig | undefined;
  role: RoleReadback = { exists: false, connectableDatabases: [] };
  /** What a role ensure leaves behind (default: scoped to its own database). */
  roleAfterEnsure: (databaseName: string) => RoleReadback = (db) => ({ exists: true, connectableDatabases: [db] });
  applyCalls: RenderedEngineConfig[] = [];
  ensureRoleCalls = 0;
  removeEngineCalls = 0;
  removeRoleCalls = 0;
  order: string[] = [];
  ready = true;
  fhirVersion: string | undefined = '4.0.1';
  partitionsHave = new Set<string>();
  ensurePartitionsDropsAll = false;
  reportRevision: ((real: string) => string) | undefined;
  removeEngineIsNoop = false;
  removeRoleIsNoop = false;

  async ensureDatabaseRole(i: { databaseName: string }) {
    this.ensureRoleCalls++;
    this.role = this.roleAfterEnsure(i.databaseName);
  }
  async readDatabaseRole(_tenantId: string, _roleName: string) {
    return structuredClone(this.role);
  }
  async removeDatabaseRole(_tenantId: string, _roleName: string) {
    this.removeRoleCalls++;
    this.order.push('role');
    if (!this.removeRoleIsNoop) this.role = { exists: false, connectableDatabases: [] };
  }
  async applyEngineConfig(cfg: RenderedEngineConfig) {
    this.applyCalls.push(cfg);
    this.config = { revision: this.reportRevision ? this.reportRevision(cfg.revision) : cfg.revision, overrides: cfg.overrides, partitioning: cfg.partitioning };
  }
  async readEngineConfig() {
    return this.config ? structuredClone(this.config) : undefined;
  }
  async probeEngine(): Promise<EngineProbe> {
    return { ready: this.ready, ...(this.fhirVersion ? { fhirVersion: this.fhirVersion } : {}), partitions: [...this.partitionsHave] };
  }
  async ensurePartitions(_t: string, names: string[]) {
    if (!this.ensurePartitionsDropsAll) for (const n of names) this.partitionsHave.add(n);
  }
  async removeEngine() {
    this.removeEngineCalls++;
    this.order.push('engine');
    if (!this.removeEngineIsNoop) this.config = undefined;
  }
}

class FakeArm implements Partial<TenantArm> {
  stampState: 'absent' | 'no_outputs' | 'found' = 'found';
  stampManifest: Record<string, unknown> = { postgresFqdn: PG_FQDN, postgresServerId: PG_ID };
  databases = new Map<string, string>([[`${PG_ID}/databases/${DB}`, DB]]);
  readError: Error | undefined;
  tenantManifest: Record<string, unknown> | 'absent' = { fhirIdentity: { id: 'x', ...IDENT } };
  async getTenantManifest() {
    return this.tenantManifest === 'absent' ? { state: 'absent' as const } : { state: 'found' as const, value: this.tenantManifest };
  }
  async getStampManifest() {
    return this.stampState === 'found' ? { state: 'found' as const, value: this.stampManifest } : { state: this.stampState };
  }
  scopeFor(rg: string) {
    return `/subscriptions/s/resourceGroups/${rg}`;
  }
  async readResource(id: string): Promise<ResourceReadback> {
    if (this.readError) throw this.readError;
    const name = this.databases.get(id);
    return name === undefined ? { id, exists: false } : { id, exists: true, name };
  }
}

function setup(tenantStatus: TenantDoc['status'] = 'active') {
  const stamps = new MemoryCollection<StampDoc>();
  const tenants = new MemoryCollection<TenantDoc>();
  const jobsStore = new MemoryCollection<JobDoc>();
  const ts = '2026-11-16T00:00:00.000Z';
  stamps.docs.set(STAMP, {
    id: STAMP, displayName: 'Dev', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy',
    baseUrl: 'https://x.example', engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0',
  });
  tenants.docs.set(SLUG, {
    id: SLUG, displayName: 'Acme', stampId: STAMP, status: tenantStatus,
    quotas: { maxRequestsPerMinute: 600, maxStorageGiB: 100 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0',
  });
  const arm = new FakeArm();
  const host = new FakeHost();
  const runner = new JobRunner(jobsStore, async (_t, i) => i === SLUG, () => {});
  for (const h of fhirTenantHandlers({ stamps, tenants, arm: arm as unknown as TenantArm, engine: host, pdpUrl: PDP })) runner.register(h);
  type Kind = 'fhir-tenant.create' | 'fhir-tenant.configure' | 'fhir-tenant.teardown';
  const run = async (kind: Kind, key: string, input: Record<string, unknown> = {}) => {
    const { job } = await runner.submit({ kind, subjectType: 'tenant', subjectId: SLUG, idempotencyKey: key, input, requestedBy: 't' });
    await runner.idle();
    return runner.get(job.id);
  };
  return { arm, host, stamps, tenants, runner, run };
}

describe('fhir-tenant.create', () => {
  it('provisions the role, applies the config, reads every step back, and records ids only', async () => {
    const { host, run } = setup();
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(host.applyCalls).toHaveLength(1);
    expect(host.applyCalls[0]?.identity).toEqual(IDENT);
    expect(host.applyCalls[0]?.env.SPRING_DATASOURCE_URL).toContain(`/${DB}?`);
    const steps = job.receipts.map((r) => r.step);
    // Each readback step missing breaks this list: the job must not skip proving what it did.
    expect(steps).toEqual(['database.readback', 'role.ensured', 'role.readback', 'config.applied', 'config.readback', 'engine.probe']);
    expect(job.receipts.find((r) => r.step === 'role.readback')?.detail).toBe(`role=${IDENT.name} exists=true databases=1`);
    expect(JSON.stringify(job.receipts)).not.toMatch(/password|secret|jdbc:/i);
    expect(job.receipts.find((r) => r.step === 'role.ensured')?.detail).toBe(`role=${IDENT.name} database=${DB}`);
  });

  it('is idempotent: a re-run applies nothing (applyCalls stays 1; 2 would mean it re-applied) and keeps the role', async () => {
    const { host, run } = setup();
    expect((await run('fhir-tenant.create', 'k1')).state).toBe('succeeded');
    const second = await run('fhir-tenant.create', 'k2');
    expect(second.state, JSON.stringify(second.error)).toBe('succeeded');
    expect(host.applyCalls).toHaveLength(1);
    expect(host.ensureRoleCalls).toBe(1);
    expect(second.receipts.map((r) => r.step)).toEqual(['database.readback', 'role.unchanged', 'role.readback', 'config.unchanged', 'config.readback', 'engine.probe']);
  });

  it('self-heals: a config deleted out of band is re-applied on the next run (positive pair of the idempotency test)', async () => {
    const { host, run } = setup();
    await run('fhir-tenant.create', 'k1');
    host.config = undefined;
    const job = await run('fhir-tenant.create', 'k2');
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(host.applyCalls).toHaveLength(2); // 1 would mean it trusted a stale "unchanged"
    expect(job.receipts.find((r) => r.step === 'config.applied')?.detail).toContain('previous=none');
  });

  it('keeps an existing override across a re-run of create (a re-create must not undo a configure)', async () => {
    const { host, run } = setup();
    await run('fhir-tenant.create', 'k1');
    expect((await run('fhir-tenant.configure', 'c1', { maxPageSize: 50 })).state).toBe('succeeded');
    host.config = undefined;
    host.config = { revision: 'x', overrides: { maxPageSize: 50 }, partitioning: true };
    await run('fhir-tenant.create', 'k3');
    expect(host.applyCalls.at(-1)?.env.HAPI_FHIR_MAX_PAGE_SIZE).toBe('50'); // 200 would mean the override was dropped
  });

  it('fails closed when the tenant database is missing, touching nothing on the host', async () => {
    const { arm, host, run } = setup();
    arm.databases.clear();
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('tenant_database_missing');
    expect(job.error?.message).toContain(`${PG_ID}/databases/${DB}`);
    expect(job.error?.message).toContain('run tenant.create');
    expect([host.ensureRoleCalls, host.applyCalls.length]).toEqual([0, 0]);
  });

  it('refuses a role that can reach another database and does NOT apply the config', async () => {
    const { host, run } = setup();
    // The input that breaks it: PUBLIC keeps CONNECT, so the role reaches a neighbour tenant database.
    host.roleAfterEnsure = (db) => ({ exists: true, connectableDatabases: [db, 'lhds_other_co'] });
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('role_not_isolated');
    expect(job.error?.message).toContain('lhds_other_co');
    expect(job.error?.message).toContain('NOT applied');
    expect(host.applyCalls).toHaveLength(0);
  });

  it('refuses a role that cannot connect to its own database (an empty grant list is not isolation)', async () => {
    const { host, run } = setup();
    host.roleAfterEnsure = () => ({ exists: true, connectableDatabases: [] });
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain('cannot connect to its own database');
    expect(host.applyCalls).toHaveLength(0);
  });

  it('will not touch an engine that is running with partition mode OFF (cannot be enabled later)', async () => {
    const { host, run } = setup();
    host.role = { exists: true, connectableDatabases: [DB] };
    host.config = { revision: 'old', overrides: {}, partitioning: false };
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('partition_mode_immutable');
    expect(job.error?.message).toContain('partition mode OFF');
    expect(host.applyCalls).toHaveLength(0);
    expect(host.config.revision).toBe('old'); // unchanged
  });

  it('a host that reports a different revision after apply fails readback_mismatch (success is never assumed)', async () => {
    const { host, run } = setup();
    host.reportRevision = (real) => `0000${real.slice(4)}`;
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain('expected');
  });

  it('an engine that is not answering is engine_not_ready, never success', async () => {
    const { host, run } = setup();
    host.ready = false;
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('engine_not_ready');
  });

  it('an engine reporting another FHIR version fails (a different image answering is not this engine)', async () => {
    const { host, run } = setup();
    host.fhirVersion = '5.0.0';
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain('5.0.0');
  });

  it('ensures the requested facility partitions and fails when one is missing afterwards', async () => {
    const { host, run } = setup();
    const ok = await run('fhir-tenant.create', 'k1', { partitions: ['site-a', 'site-b'] });
    expect(ok.state, JSON.stringify(ok.error)).toBe('succeeded');
    expect([...host.partitionsHave].sort()).toEqual(['site-a', 'site-b']);
    host.ensurePartitionsDropsAll = true;
    const bad = await run('fhir-tenant.create', 'k2', { partitions: ['site-c'] });
    expect(bad.error?.code).toBe('readback_mismatch');
    expect(bad.error?.message).toContain('site-c');
  });

  it('names the PostgreSQL gap instead of guessing when the stamp has none', async () => {
    const { arm, host, run } = setup();
    arm.stampManifest = { postgresServerId: PG_ID };
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('stamp_manifest_incomplete');
    expect(job.error?.message).toContain('postgresFqdn');
    expect(host.ensureRoleCalls).toBe(0);
  });

  it('classifies an ARM permission failure with the exact action, and does nothing on the host', async () => {
    const { arm, host, run } = setup();
    arm.readError = new ArmError(403, 'AuthorizationFailed', 'read resource');
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('permission');
    expect(host.ensureRoleCalls + host.applyCalls.length).toBe(0);
  });

  it('refuses a destroying tenant', async () => {
    const { host, run } = setup('destroying');
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('tenant_destroying');
    expect(host.applyCalls).toHaveLength(0);
  });

  it('rejects unknown input keys at submit (strict), so a typo cannot silently change nothing', async () => {
    const { runner } = setup();
    await expect(
      runner.submit({ kind: 'fhir-tenant.create', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'k', input: { partition: ['x'] }, requestedBy: 't' }),
    ).rejects.toThrow(/input:/);
  });
});

describe('fhir-tenant identity (from the tenant manifest)', () => {
  it('a tenant manifest with no fhirIdentity fails fhir_identity_missing and creates nothing', async () => {
    const { arm, host, run } = setup();
    arm.tenantManifest = { identityId: 'only-the-old-one' };
    const job = await run('fhir-tenant.create', 'k1');
    expect(job.error?.code).toBe('fhir_identity_missing');
    expect(job.error?.message).toContain('Not established');
    expect([host.ensureRoleCalls, host.applyCalls.length]).toEqual([0, 0]);
  });

  it('an absent tenant deployment fails tenant_manifest_missing', async () => {
    const { arm, run } = setup();
    arm.tenantManifest = 'absent';
    expect((await run('fhir-tenant.create', 'k1')).error?.code).toBe('tenant_manifest_missing');
  });

  it('teardown with no fhirIdentity skips the principal and says so (does not claim removal)', async () => {
    const { arm, host, run } = setup('destroying');
    arm.tenantManifest = {};
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.receipts.map((r) => r.step)).toEqual(['engine.removed', 'role.skipped']);
    expect(job.receipts[1]?.detail).toContain('no valid fhirIdentity output');
    expect(host.removeRoleCalls).toBe(0);
  });

  it('the role.skipped receipt names the cause that was observed: deployment absent, no outputs, or stamp not registered', async () => {
    const absent = setup('destroying');
    absent.arm.tenantManifest = 'absent';
    const a = await absent.run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(a.receipts[1]?.detail).toContain(`lhds-tenant-${SLUG} was not found`);
    expect(a.receipts[1]?.detail).not.toContain('fhirIdentity'); // an absent deployment must not be reported as a missing field
    const noStamp = setup('destroying');
    noStamp.stamps.docs.delete(STAMP);
    const s = await noStamp.run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(s.receipts[1]?.detail).toContain('stamp that is not registered');
    expect(s.receipts[1]?.detail).not.toContain('was not found');
  });
});

describe('fhir-tenant.configure', () => {
  it('refuses to create an engine implicitly: no config means engine_not_configured and nothing is applied', async () => {
    const { host, run } = setup();
    const job = await run('fhir-tenant.configure', 'c1', { maxPageSize: 50 });
    expect(job.error?.code).toBe('engine_not_configured');
    expect(host.applyCalls).toHaveLength(0);
  });

  it('merges a patch onto the existing overrides instead of replacing them (50 then pool 20 keeps both)', async () => {
    const { host, run } = setup();
    await run('fhir-tenant.create', 'k1');
    expect((await run('fhir-tenant.configure', 'c1', { maxPageSize: 50 })).state).toBe('succeeded');
    const job = await run('fhir-tenant.configure', 'c2', { poolSize: 20 });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const last = host.applyCalls.at(-1) as RenderedEngineConfig;
    expect(last.env.HAPI_FHIR_MAX_PAGE_SIZE).toBe('50'); // 200 would mean the second patch erased the first
    expect(last.env.SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE).toBe('20');
  });

  it('a configure that changes nothing applies nothing (idempotent), a changing one applies once', async () => {
    const { host, run } = setup();
    await run('fhir-tenant.create', 'k1');
    await run('fhir-tenant.configure', 'c1', { maxPageSize: 50 });
    const n = host.applyCalls.length;
    const same = await run('fhir-tenant.configure', 'c2', { maxPageSize: 50 });
    expect(same.receipts.some((r) => r.step === 'config.unchanged')).toBe(true);
    expect(host.applyCalls.length).toBe(n);
  });

  it('cannot relax what is not configurable: partition mode, RI and validation keys are rejected by name', async () => {
    const { runner } = setup();
    for (const key of ['partitioning', 'enforceReferentialIntegrityOnWrite', 'validationEnabled', 'databasePartitionModeEnabled']) {
      await expect(
        runner.submit({ kind: 'fhir-tenant.configure', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: `k-${key}`, input: { [key]: false }, requestedBy: 't' }),
        key,
      ).rejects.toThrow(/input:/);
    }
    // Positive control: a real knob is accepted by the same schema.
    await expect(
      runner.submit({ kind: 'fhir-tenant.configure', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'ok', input: { maxPageSize: 10 }, requestedBy: 't' }),
    ).resolves.toBeDefined();
  });

  it('a cap above the file ceiling is refused at submit (201 fails; 200 is accepted)', async () => {
    const { runner } = setup();
    await expect(
      runner.submit({ kind: 'fhir-tenant.configure', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'k1', input: { maxPageSize: 201 }, requestedBy: 't' }),
    ).rejects.toThrow(/input:/);
    await expect(
      runner.submit({ kind: 'fhir-tenant.configure', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'k2', input: { maxPageSize: 200 }, requestedBy: 't' }),
    ).resolves.toBeDefined();
  });

  it('an empty patch is refused', async () => {
    const { runner } = setup();
    await expect(
      runner.submit({ kind: 'fhir-tenant.configure', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'k1', input: {}, requestedBy: 't' }),
    ).rejects.toThrow(/at least one field/);
  });
});

describe('fhir-tenant.teardown', () => {
  it('removes the engine BEFORE the role, and reads both back', async () => {
    const { host, run } = setup('destroying');
    host.config = { revision: 'r', overrides: {}, partitioning: true };
    host.role = { exists: true, connectableDatabases: [DB] };
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(host.order).toEqual(['engine', 'role']); // reversed order drops the role under a live engine
    expect(job.receipts.map((r) => r.step)).toEqual(['engine.removed', 'role.removed']);
    expect(job.receipts[0]?.detail).toContain('configPresent=false');
  });

  it('refuses a tenant that is not destroying and removes nothing', async () => {
    const { host, run } = setup('active');
    host.config = { revision: 'r', overrides: {}, partitioning: true };
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('tenant_not_destroying');
    expect(job.error?.message).toContain('is active');
    expect([host.removeEngineCalls, host.removeRoleCalls]).toEqual([0, 0]);
    expect(host.config).toBeDefined();
  });

  it('refuses a wrong confirmation', async () => {
    const { host, run } = setup('destroying');
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: 'someone-else' });
    expect(job.error?.code).toBe('confirmation_mismatch');
    expect(host.removeEngineCalls).toBe(0);
  });

  it('an engine whose config is still present after removal fails and the role is NOT removed', async () => {
    const { host, run } = setup('destroying');
    host.config = { revision: 'r', overrides: {}, partitioning: true };
    host.removeEngineIsNoop = true;
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('teardown_incomplete');
    expect(host.removeRoleCalls).toBe(0); // 1 would mean the role was dropped under a live engine
  });

  it('a role that survives removal fails teardown_incomplete', async () => {
    const { host, run } = setup('destroying');
    host.role = { exists: true, connectableDatabases: [DB] };
    host.removeRoleIsNoop = true;
    const job = await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('teardown_incomplete');
    expect(job.error?.message).toContain(IDENT.name);
  });

  it('is idempotent: a second teardown of an already-removed engine succeeds', async () => {
    const { host, run } = setup('destroying');
    host.config = { revision: 'r', overrides: {}, partitioning: true };
    host.role = { exists: true, connectableDatabases: [DB] };
    expect((await run('fhir-tenant.teardown', 't1', { confirmTenantId: SLUG })).state).toBe('succeeded');
    const again = await run('fhir-tenant.teardown', 't2', { confirmTenantId: SLUG });
    expect(again.state, JSON.stringify(again.error)).toBe('succeeded');
  });
});
