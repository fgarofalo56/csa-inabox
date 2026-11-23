// fhir-tenant.create / fhir-tenant.configure / fhir-tenant.teardown (W2-2): the per-tenant FHIR engine
// config lifecycle, as control-plane jobs next to tenant.create (W1-2, whose conventions this copies:
// resolve -> act -> read every thing back -> receipt ids only -> fail closed with a message that states
// only what was established, deploy-integrity R6/R7).
//
// auto-bind-by-default: creating the engine config PROVISIONS AND BINDS the tenant's database role and
// the engine settings; there is no second step. The database is the one tenant.create made; its name is
// derived (fhirNames), never typed.
//
// What these jobs do NOT do: they never run the engine. The host (container platform) is behind the
// FhirEngineHost port; its production adapter is RunCommandFhirEngineHost (fhir-engine-host.ts, W2-2b B2c), which
// reaches the private stamp AKS through ARM runCommand. Until a host AND a PDP url are supplied the kinds are not
// registered (compose.ts), so a submit answers "unknown job kind" rather than pretending.
//
// The engine authenticates to PostgreSQL PASSWORDLESS (#5422 decision 9): its own UAMI is a PG Entra principal, so
// there is no credential role and no Key Vault entry to create or remove.

import { z } from 'zod';
import type { StampDoc, TenantDoc } from '../registry/types.js';
import type { Collection } from '../store/types.js';
import {
  renderEngineConfig,
  mergePartitions,
  OverridesSchema,
  PARTITION_NAME,
  type EngineOverrides,
  type FhirIdentity,
  type PartitionSpec,
  type RenderedEngineConfig,
} from './fhir-tenant-config.js';
import { classifyArm, stampResourceGroup, tenantNames, type TenantArm } from './tenant-arm.js';
import { JobFailure, type JobContext, type JobHandler } from './types.js';

/** What the engine host reports as running for a tenant. */
export interface AppliedEngineConfig {
  revision: string;
  overrides: EngineOverrides;
  /** Partition mode of the running engine/database. Cannot be enabled later (ADR-003). */
  partitioning: boolean;
  /** The desired partitions the running Deployment was rendered with (its `loom.health/partitions` annotation); [] when it carries none. */
  partitions: PartitionSpec[];
}

export interface RoleReadback {
  exists: boolean;
  /** Every application database the principal can CONNECT to. Isolation holds only if this is exactly the tenant's own. */
  connectableDatabases: string[];
}

export interface EngineProbe {
  ready: boolean;
  /** `fhirVersion` of the engine's CapabilityStatement. */
  fhirVersion?: string;
  /** Partition names the engine reports as existing. */
  partitions: string[];
}

export interface FhirEngineHost {
  /**
   * Idempotent: ensure the Entra PostgreSQL principal `roleName` (the tenant FHIR identity's name) exists, grant CONNECT
   * on `databaseName` only, and the schema privileges the engine needs to create its tables. No credential is involved.
   * A same-named principal bound to a DIFFERENT Entra object id (a re-created identity) is replaced, never reused.
   */
  ensureDatabaseRole(i: { tenantId: string; databaseName: string; roleName: string; principalId: string }): Promise<void>;
  readDatabaseRole(tenantId: string, roleName: string): Promise<RoleReadback>;
  removeDatabaseRole(tenantId: string, roleName: string): Promise<void>;
  applyEngineConfig(cfg: RenderedEngineConfig): Promise<void>;
  /** undefined = no engine config exists for the tenant. */
  readEngineConfig(tenantId: string): Promise<AppliedEngineConfig | undefined>;
  /** `partitions: true` also lists the partitions, read from the tenant database (never over HTTP); a host that cannot read them throws rather than report none. */
  probeEngine(tenantId: string, opts?: { partitions?: boolean }): Promise<EngineProbe>;
  /**
   * The engine creates its own partitions at startup from the rendered config (#5422 decision 11); nothing is created here.
   * This waits for the rollout, reads the tenant database back, and throws unless every desired partition is present with the desired id and name.
   */
  ensurePartitions(tenantId: string, desired: PartitionSpec[]): Promise<void>;
  /** Stop and remove the engine workload and its config for the tenant (the database is NOT touched). */
  removeEngine(tenantId: string): Promise<void>;
}

export interface FhirTenantJobDeps {
  stamps: Collection<StampDoc>;
  tenants: Collection<TenantDoc>;
  arm: TenantArm;
  engine: FhirEngineHost;
  /** In-cluster PDP decision endpoint (W1-5). */
  pdpUrl: string;
}

export function fhirTenantHandlers(deps: FhirTenantJobDeps): JobHandler[] {
  return [fhirTenantCreateHandler(deps), fhirTenantConfigureHandler(deps), fhirTenantTeardownHandler(deps)];
}

// DEFAULT is HAPI's built-in partition; a tenant partition named it (any case) is refused at the door, not at the engine.
const PartitionsSchema = z
  .array(z.string().regex(PARTITION_NAME).refine((n) => n.toLowerCase() !== 'default', 'DEFAULT is reserved'))
  .max(200);

interface Resolved {
  tenant: TenantDoc;
  stamp: StampDoc;
  rg: string;
  postgresFqdn: string;
  /** The stamp PG administrator role (stamp manifest `pgAdminIdentity.name`); the engine grants it SELECT on its partition table. */
  pgAdminName: string;
  postgresServerId: string;
  /** The tenant's FHIR identity from the tenant deployment (#5422 decision 9). */
  identity: FhirIdentity;
}

async function resolve(ctx: JobContext, deps: FhirTenantJobDeps): Promise<Resolved> {
  const tenant = await deps.tenants.get(ctx.job.subjectId);
  if (!tenant) throw new JobFailure('tenant_missing', 'the tenant record no longer exists');
  const stamp = await deps.stamps.get(tenant.stampId);
  if (!stamp) throw new JobFailure('stamp_missing', 'the tenant references a stamp that is not registered');
  const rg = stampResourceGroup(stamp.id, stamp.region);
  let lookup;
  try {
    lookup = await deps.arm.getStampManifest(rg, stamp.id);
  } catch (e) {
    throw classifyArm(e);
  }
  if (lookup.state !== 'found') {
    throw new JobFailure(
      lookup.state === 'absent' ? 'stamp_manifest_missing' : 'stamp_manifest_unreadable',
      `the stamp deployment lhds-stamp-${stamp.id} ${lookup.state === 'absent' ? 'was not found' : 'returned no outputs'} in ${rg}; it is the source of the PostgreSQL host`,
    );
  }
  const postgresFqdn = String(lookup.value.postgresFqdn ?? '');
  if (!postgresFqdn) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no postgresFqdn (PostgreSQL is not deployed on this stamp); the engine datasource cannot be built');
  const pgAdmin = lookup.value.pgAdminIdentity as { name?: unknown } | undefined;
  const pgAdminName = typeof pgAdmin?.name === 'string' ? pgAdmin.name : '';
  const postgresServerId = String(lookup.value.postgresServerId ?? '');
  if (!postgresServerId) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no postgresServerId, so the tenant database cannot be read back');
  let tm;
  try {
    tm = await deps.arm.getTenantManifest(rg, tenant.id);
  } catch (e) {
    throw classifyArm(e);
  }
  if (tm.state !== 'found') {
    throw new JobFailure(
      'tenant_manifest_missing',
      `the tenant deployment lhds-tenant-${tenant.id} ${tm.state === 'absent' ? 'was not found' : 'returned no usable outputs (this includes a missing or malformed fhirIdentity, e.g. a tenant deployed before the dedicated FHIR identity)'} in ${rg}; it is the source of the tenant FHIR identity. Run tenant.create for ${tenant.id} first. No role or engine config was created.`,
    );
  }
  const { name, clientId, principalId } = tm.value.fhirIdentity;
  const identity: FhirIdentity = { name, clientId, principalId };
  return { tenant, stamp, rg, postgresFqdn, pgAdminName, postgresServerId, identity };
}

/** The tenant database must exist (tenant.create made it); the readback asserts the DERIVED name. */
async function requireTenantDatabase(ctx: JobContext, deps: FhirTenantJobDeps, r: Resolved): Promise<void> {
  const names = tenantNames(r.stamp.id, r.tenant.id);
  const dbId = `${r.postgresServerId}/databases/${names.databaseName}`;
  let rb;
  try {
    rb = await deps.arm.readResource(dbId);
  } catch (e) {
    throw classifyArm(e);
  }
  await ctx.receipt('database.readback', `exists=${rb.exists} id=${dbId}`);
  if (!rb.exists) {
    throw new JobFailure('tenant_database_missing', `the tenant database ${names.databaseName} was not found at ${dbId}; run tenant.create for ${r.tenant.id} first. No role or engine config was created.`);
  }
  if ((rb.name ?? names.databaseName) !== names.databaseName) {
    throw new JobFailure('readback_mismatch', `the database at ${dbId} is named ${rb.name}, expected ${names.databaseName}`);
  }
}

/** Role + isolation. Re-run safe: an existing, correctly-scoped role is left alone. */
async function ensureRole(ctx: JobContext, deps: FhirTenantJobDeps, cfg: RenderedEngineConfig): Promise<void> {
  const want = { databaseName: cfg.names.databaseName, roleName: cfg.identity.name };
  let have = await deps.engine.readDatabaseRole(cfg.tenantId, want.roleName);
  const scoped = (rb: typeof have) => rb.exists && rb.connectableDatabases.length === 1 && rb.connectableDatabases[0] === want.databaseName;
  if (!scoped(have)) {
    await deps.engine.ensureDatabaseRole({ tenantId: cfg.tenantId, databaseName: want.databaseName, roleName: want.roleName, principalId: cfg.identity.principalId });
    await ctx.receipt('role.ensured', `role=${want.roleName} database=${want.databaseName}`);
    have = await deps.engine.readDatabaseRole(cfg.tenantId, want.roleName);
  } else {
    await ctx.receipt('role.unchanged', `role=${want.roleName}`);
  }
  await ctx.receipt('role.readback', `role=${want.roleName} exists=${have.exists} databases=${have.connectableDatabases.length}`);
  if (!have.exists) throw new JobFailure('readback_mismatch', `the role ${want.roleName} does not exist after it was ensured`);
  const foreign = have.connectableDatabases.filter((d) => d !== want.databaseName);
  if (foreign.length > 0) {
    throw new JobFailure(
      'role_not_isolated',
      `the role ${want.roleName} can connect to ${foreign.length} database(s) besides ${want.databaseName} (${foreign.join(', ')}); a tenant engine must reach only its own database. The engine config was NOT applied.`,
    );
  }
  if (!have.connectableDatabases.includes(want.databaseName)) {
    throw new JobFailure('readback_mismatch', `the role ${want.roleName} cannot connect to its own database ${want.databaseName}`);
  }
}

/** Apply if the running config differs, then read it back and probe the engine. */
async function applyAndVerify(ctx: JobContext, deps: FhirTenantJobDeps, cfg: RenderedEngineConfig): Promise<void> {
  const current = await deps.engine.readEngineConfig(cfg.tenantId);
  if (current && !current.partitioning) {
    throw new JobFailure(
      'partition_mode_immutable',
      `the engine for ${cfg.tenantId} is running with partition mode OFF. HAPI cannot enable partition mode on an existing database (ADR-003), so nothing was changed. Restore the data into a new tenant database, or recreate the tenant.`,
    );
  }
  if (current?.revision === cfg.revision) {
    await ctx.receipt('config.unchanged', `revision=${cfg.revision.slice(0, 12)}`);
  } else {
    await deps.engine.applyEngineConfig(cfg);
    await ctx.receipt('config.applied', `revision=${cfg.revision.slice(0, 12)} previous=${current ? current.revision.slice(0, 12) : 'none'}`);
  }
  const back = await deps.engine.readEngineConfig(cfg.tenantId);
  await ctx.receipt('config.readback', `revision=${back ? back.revision.slice(0, 12) : 'absent'}`);
  if (!back) throw new JobFailure('readback_mismatch', 'the engine config was applied but the host reports none for this tenant');
  if (back.revision !== cfg.revision) {
    throw new JobFailure('readback_mismatch', `the host reports engine config revision ${back.revision.slice(0, 12)}, expected ${cfg.revision.slice(0, 12)}`);
  }
  if (!back.partitioning) {
    throw new JobFailure('partition_mode_off', 'the applied engine reports partition mode off; it cannot be enabled later (ADR-003). The tenant database must be recreated before the engine is started.');
  }
  const probe = await deps.engine.probeEngine(cfg.tenantId);
  await ctx.receipt('engine.probe', `ready=${probe.ready} fhirVersion=${probe.fhirVersion ?? 'unknown'}`);
  if (!probe.ready) throw new JobFailure('engine_not_ready', 'the engine config was applied and read back, but the engine does not answer /metadata yet; retry the job');
  if (probe.fhirVersion !== '4.0.1') {
    throw new JobFailure('readback_mismatch', `the engine reports FHIR version ${probe.fhirVersion ?? 'none'}, expected 4.0.1`);
  }
  if (cfg.partitions.length > 0) {
    // The engine created these itself at startup; this only waits for it and reads the database back.
    await deps.engine.ensurePartitions(cfg.tenantId, cfg.partitions);
    const after = await deps.engine.probeEngine(cfg.tenantId, { partitions: true });
    const missing = cfg.partitions.map((p) => p.name).filter((p) => !after.partitions.includes(p));
    await ctx.receipt('partitions.readback', `wanted=${cfg.partitions.length} missing=${missing.length}`);
    if (missing.length > 0) throw new JobFailure('readback_mismatch', `partitions not present after ensure: ${missing.join(', ')}`);
  }
}

function render(deps: FhirTenantJobDeps, r: Resolved, overrides: EngineOverrides | undefined, partitions: PartitionSpec[]): RenderedEngineConfig {
  return renderEngineConfig({
    partitions,
    pgAdminName: r.pgAdminName,
    tenantId: r.tenant.id,
    stampId: r.stamp.id,
    postgresFqdn: r.postgresFqdn,
    identity: r.identity,
    maxRequestsPerMinute: r.tenant.quotas.maxRequestsPerMinute,
    pdpUrl: deps.pdpUrl,
    overrides,
  });
}

export function fhirTenantCreateHandler(deps: FhirTenantJobDeps): JobHandler {
  return {
    kind: 'fhir-tenant.create',
    subjectType: 'tenant',
    inputSchema: z.strictObject({ partitions: PartitionsSchema.optional() }),
    async run(ctx) {
      const r = await resolve(ctx, deps);
      if (r.tenant.status === 'destroying') throw new JobFailure('tenant_destroying', 'the tenant is being destroyed; no engine config is created');
      await requireTenantDatabase(ctx, deps, r);
      // Self-heal: an engine that already carries overrides keeps them across a re-run of create.
      const existing = await deps.engine.readEngineConfig(r.tenant.id);
      const cfg = render(deps, r, existing?.overrides, mergePartitions(existing?.partitions ?? [], (ctx.input.partitions as string[] | undefined) ?? []));
      await ensureRole(ctx, deps, cfg);
      await applyAndVerify(ctx, deps, cfg);
    },
  };
}

export function fhirTenantConfigureHandler(deps: FhirTenantJobDeps): JobHandler {
  return {
    kind: 'fhir-tenant.configure',
    subjectType: 'tenant',
    // Only the knobs that may change on a running engine. Partition mode, referential integrity and
    // validation are NOT here: strictObject rejects them by name instead of ignoring them.
    inputSchema: z
      .strictObject({ ...OverridesSchema.shape, partitions: PartitionsSchema.optional() })
      .refine((v) => Object.keys(v).length > 0, 'at least one field is required'),
    async run(ctx) {
      const r = await resolve(ctx, deps);
      if (r.tenant.status === 'destroying') throw new JobFailure('tenant_destroying', 'the tenant is being destroyed; its engine is not reconfigured');
      const existing = await deps.engine.readEngineConfig(r.tenant.id);
      if (!existing) {
        throw new JobFailure('engine_not_configured', `no engine config exists for ${r.tenant.id}; run fhir-tenant.create first. Nothing was changed.`);
      }
      const { partitions, ...patch } = ctx.input as EngineOverrides & { partitions?: string[] };
      const merged: EngineOverrides = { ...existing.overrides, ...patch };
      const cfg = render(deps, r, merged, mergePartitions(existing.partitions, partitions ?? []));
      await ensureRole(ctx, deps, cfg);
      await applyAndVerify(ctx, deps, cfg);
    },
  };
}

export function fhirTenantTeardownHandler(deps: FhirTenantJobDeps): JobHandler {
  return {
    kind: 'fhir-tenant.teardown',
    subjectType: 'tenant',
    inputSchema: z.strictObject({ confirmTenantId: z.string().min(1).max(60) }),
    async run(ctx) {
      if (ctx.input.confirmTenantId !== ctx.job.subjectId) {
        throw new JobFailure('confirmation_mismatch', 'confirmTenantId does not equal the tenant id; nothing was changed');
      }
      const tenant = await deps.tenants.get(ctx.job.subjectId);
      if (!tenant) throw new JobFailure('tenant_missing', 'the tenant record no longer exists');
      if (tenant.status !== 'destroying') {
        throw new JobFailure('tenant_not_destroying', `the tenant is ${tenant.status}; an engine is torn down only as part of tenant.destroy, which marks the tenant destroying first. Nothing was changed.`);
      }
      await deps.engine.removeEngine(tenant.id);
      const after = await deps.engine.readEngineConfig(tenant.id);
      await ctx.receipt('engine.removed', `tenant=${tenant.id} configPresent=${after !== undefined}`);
      if (after !== undefined) {
        throw new JobFailure('teardown_incomplete', 'the engine config is still present after removal; the tenant database was NOT touched and the role was kept. Retry the job.');
      }
      // The principal goes only after the engine that used it is gone. Its name comes from the tenant manifest; with no
      // fhirIdentity there (a tenant that never had an engine) nothing is established to remove, and that is said.
      const stamp = await deps.stamps.get(tenant.stampId);
      let identity: FhirIdentity | undefined;
      // The receipt names the cause that was actually observed, never a guess.
      let skipCause = 'the tenant references a stamp that is not registered';
      if (stamp) {
        try {
          const tm = await deps.arm.getTenantManifest(stampResourceGroup(stamp.id, stamp.region), tenant.id);
          if (tm.state === 'found') {
            identity = tm.value.fhirIdentity;
          } else {
            skipCause = tm.state === 'absent' ? `the tenant deployment lhds-tenant-${tenant.id} was not found` : `the tenant deployment lhds-tenant-${tenant.id} returned no usable outputs (a missing or malformed fhirIdentity reads this way)`;
          }
        } catch (e) {
          throw classifyArm(e);
        }
      }
      if (!identity) {
        await ctx.receipt('role.skipped', `${skipCause}; no database principal name was established, so none was removed`);
        return;
      }
      await deps.engine.removeDatabaseRole(tenant.id, identity.name);
      const role = await deps.engine.readDatabaseRole(tenant.id, identity.name);
      await ctx.receipt('role.removed', `role=${identity.name} exists=${role.exists}`);
      if (role.exists) {
        throw new JobFailure('teardown_incomplete', `the role ${identity.name} still exists after removal; retry the job before tenant.destroy drops the database`);
      }
    },
  };
}
