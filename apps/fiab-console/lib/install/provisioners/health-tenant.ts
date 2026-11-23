/**
 * Phase 2 - `health-tenant` provisioner (LHDS W1-7).
 *
 * Creating a Loom `health-tenant` item PROVISIONS AND BINDS its backing
 * resources (auto-bind-by-default.md section 1): a tenant record on a stamp in
 * the health control plane, then the control plane's `tenant.create` job, which
 * deploys the tenant's PostgreSQL database, Blob accounts, Event Hubs hub,
 * identity, capacity alert and Key Vault keys on that stamp and READS EACH ONE
 * BACK (apps/loom-health-cp/src/jobs/tenant-jobs.ts). The Console never calls
 * ARM for a tenant itself; the job receipts are the readback it renders.
 *
 *  - NAMES MATCH (section 2). The control-plane tenant carries the item's
 *    display name verbatim. Its id is a slug, because it appears in URLs and in
 *    resource names; the slug is deterministic and recorded on the item
 *    (`state.healthTenant.tenantId` + `tenantIdSanitized`), never guessed.
 *  - SELF-HEALING (section 3). Every ensure re-reads the tenant from the
 *    control plane. A tenant deleted out of band is re-registered and
 *    re-provisioned; a lost state write is re-derived and the existing tenant
 *    ADOPTED (same slug, same display name). A bound tenant is re-verified by
 *    an idempotent job once a day, so a resource deleted from Azure is rebuilt
 *    by the incremental ARM deployment and read back again.
 *  - NEVER A FORM (section 4). Provisioning can take minutes, so ensure returns
 *    `provisioning` with the job's receipts and the editor shows them as
 *    progress on the real Overview.
 *
 * Azure-native by construction (no-fabric-dependency.md): no Fabric or Power BI
 * host is reachable from this path.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { enforceHealthTenantAdmin } from '@/app/api/health/tenants/_lib/tenant-admin-gate';
import type { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  cp as realCp,
  CP_ENV,
  CpError,
  CpNotConfiguredError,
  readCpConfig,
  type CpJob,
  type CpStamp,
  type CpTenant,
} from '@/app/api/health/tenants/_lib/cp-client';
import { createHash } from 'node:crypto';
import type { Provisioner, ProvisionResult } from './types';

/** Gate ids this provisioner can return; each is a real registry gate (lib/gates/registry/health.ts). */
export const HEALTH_GATE = {
  controlPlane: 'health-control-plane',
  stampCapacity: 'health-stamp-capacity',
} as const;

/** A bound tenant is re-verified by an idempotent job when its last verification is older than this. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Quotas a new tenant starts with; editable later on the Quotas tab. */
export const DEFAULT_QUOTAS = { maxRequestsPerMinute: 6000, maxStorageGiB: 1024 } as const;

/**
 * Tenant slug cap. Resource names embed the slug (Key Vault keys, PostgreSQL database), and
 * tenant.bicep caps `tenantSlug` at 20 (@maxLength) - that is the binding limit, so the console
 * derives <=20 chars. A drift test lifts the bicep value and asserts equality.
 */
export const HEALTH_TENANT_SLUG_MAX = 20;
const SLUG_MAX = HEALTH_TENANT_SLUG_MAX;
/** Hash chars appended to a truncated slug so long names sharing a prefix stay distinct. */
const HASH_LEN = 6;

export interface HealthResource { kind: string; id: string; name: string }

/**
 * The tenant's FHIR engine (#5442). `ready` = the fhir-tenant.create job succeeded; `provisioning` / `failed` follow that job;
 * `unavailable` = the control plane has no engine host + PDP url configured (it answered "unknown job kind"), re-asked on every ensure.
 */
export interface HealthEngine { status: 'ready' | 'provisioning' | 'failed' | 'unavailable'; jobId?: string }

export interface HealthBinding {
  /** Control-plane tenant id (slug). */
  tenantId: string;
  /** The item's display name the tenant record carries. */
  sourceName: string;
  /** True when `tenantId` differs from a plain lowercase of the display name because the registry's slug rules forced it. */
  tenantIdSanitized: boolean;
  stampId: string;
  createJobId?: string;
  status: 'provisioning' | 'bound' | 'failed';
  boundAt?: string;
  verifiedAt?: string;
  resources: HealthResource[];
  engine?: HealthEngine;
  lastError?: { code: string; message: string };
}

export type EnsureOutcome =
  | { phase: 'unconfigured'; gateId: typeof HEALTH_GATE.controlPlane; missing: string[]; message: string; steps: string[] }
  | { phase: 'no-stamp'; gateId: typeof HEALTH_GATE.stampCapacity; message: string; steps: string[] }
  | { phase: 'cp-error'; code: string; message: string; steps: string[] }
  | { phase: 'provisioning'; binding: HealthBinding; job: CpJob; steps: string[] }
  | { phase: 'bound'; binding: HealthBinding; tenant: CpTenant; steps: string[]; created: boolean }
  | { phase: 'failed'; binding: HealthBinding; job?: CpJob; code: string; message: string; steps: string[] };

/**
 * Registry slug for a display name: lowercase a-z0-9 and hyphen, 2 to 20 chars, no leading or trailing hyphen.
 * A name whose slug would exceed 20 is cut to 13 chars + '-' + a 6-hex sha256 of the full lowercased name
 * (deterministic; the mapping is recorded via `sanitized`).
 */
export function healthTenantSlugFor(displayName: string): { slug: string; sanitized: boolean } {
  const lowered = displayName.trim().toLowerCase();
  let slug = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX) {
    const hash = createHash('sha256').update(lowered).digest('hex').slice(0, HASH_LEN);
    slug = `${slug.slice(0, SLUG_MAX - HASH_LEN - 1).replace(/-+$/g, '')}-${hash}`;
  }
  if (slug.length < 2) slug = slug ? `${slug}-tenant` : 'health-tenant';
  return { slug, sanitized: slug !== lowered };
}

/** Slug used when the plain one is taken by a DIFFERENT tenant: suffixed with the item's own id so it is stable per item. */
export function healthTenantCollisionSlug(base: string, itemId: string): string {
  const suffix = itemId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6) || 'item';
  return `${base.slice(0, SLUG_MAX - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`;
}

/** Healthy stamp to place a new tenant on: the preferred id when given, else the first healthy stamp by id. */
export function pickStamp(
  stamps: CpStamp[],
  preferredId: string | undefined,
): { stamp: CpStamp } | { reason: string } {
  if (preferredId) {
    const s = stamps.find((x) => x.id === preferredId);
    if (!s) return { reason: `The configured default stamp '${preferredId}' is not registered in the health control plane.` };
    if (s.status !== 'healthy') return { reason: `The configured default stamp '${preferredId}' is ${s.status}${s.pauseReason ? ` (${s.pauseReason})` : ''}; a tenant is created only on a healthy stamp.` };
    return { stamp: s };
  }
  const healthy = stamps.filter((x) => x.status === 'healthy').sort((a, b) => a.id.localeCompare(b.id));
  if (healthy.length === 0) {
    return { reason: stamps.length === 0 ? 'No stamp is registered in the health control plane.' : `None of the ${stamps.length} registered stamp(s) is healthy (${[...new Set(stamps.map((s) => s.status))].join(', ')}).` };
  }
  return { stamp: healthy[0]! };
}

const READBACK = /^(\S+) exists=(true|false) id=(\S+)$/;

/** Resources the tenant.create job read back as existing, from its receipts (ids only, never data). */
export function resourcesFromReceipts(job: Pick<CpJob, 'receipts'>): HealthResource[] {
  const out: HealthResource[] = [];
  for (const r of job.receipts) {
    if (r.step !== 'readback') continue;
    const m = READBACK.exec(r.detail);
    if (!m || m[2] !== 'true') continue;
    out.push({ kind: m[1]!, id: m[3]!, name: m[3]!.split('/').pop() ?? m[3]! });
  }
  return out;
}

export function readBinding(state: Record<string, unknown> | undefined): HealthBinding | undefined {
  const b = state?.healthTenant as Partial<HealthBinding> | undefined;
  if (!b || typeof b.tenantId !== 'string' || typeof b.stampId !== 'string') return undefined;
  return { ...b, resources: Array.isArray(b.resources) ? b.resources : [] } as HealthBinding;
}

export interface EnsureDeps {
  cp: typeof realCp;
  readConfig: typeof readCpConfig;
  now: () => Date;
  /** Preferred stamp id (LOOM_HEALTH_DEFAULT_STAMP_ID). */
  defaultStampId: string | undefined;
  /** Persist `state.healthTenant`; false when the write did not land. */
  persist: (binding: HealthBinding) => Promise<boolean>;
}

export interface EnsureInput {
  itemId: string;
  displayName: string;
  state: Record<string, unknown> | undefined;
  /** Retry a failed create job instead of reporting it. */
  retry?: boolean;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** The tenant-incarnation key: a tenant destroyed and re-created under the same slug gets a NEW job, not the old succeeded one. */
function createKey(t: CpTenant): string {
  const stamp = (t.createdAt ?? '').replace(/\D/g, '').slice(0, 14);
  return `create-${stamp || '0'}`;
}

/**
 * Ensure the item's tenant exists, is provisioned and reads back. Idempotent: N calls
 * create ONE tenant and ONE create job. Never throws; every failure is a typed outcome.
 */
export async function ensureHealthTenant(input: EnsureInput, deps: EnsureDeps): Promise<EnsureOutcome> {
  const steps: string[] = [];
  try {
    deps.readConfig();
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return {
        phase: 'unconfigured',
        gateId: HEALTH_GATE.controlPlane,
        missing: e.missing,
        message: `The health control plane is not configured (${e.missing.join(', ')} unset).`,
        steps,
      };
    }
    throw e;
  }

  try {
    const prior = readBinding(input.state);
    const base = healthTenantSlugFor(input.displayName);
    let tenantId = prior?.tenantId ?? base.slug;
    let tenant = await deps.cp.getTenant(tenantId);

    if (tenant && !prior && tenant.displayName !== input.displayName) {
      // The plain slug belongs to a different tenant: take the item-suffixed one (deterministic per item).
      tenantId = healthTenantCollisionSlug(base.slug, input.itemId);
      steps.push(`Tenant id '${base.slug}' is taken by '${tenant.displayName}'; using '${tenantId}'.`);
      tenant = await deps.cp.getTenant(tenantId);
      if (tenant && tenant.displayName !== input.displayName) {
        return failed(prior, { tenantId, sourceName: input.displayName, sanitized: tenantId !== input.displayName.toLowerCase(), stampId: tenant.stampId }, 'slug_conflict',
          `Tenant id '${tenantId}' is held by a different tenant ('${tenant.displayName}'); rename this item.`, steps);
      }
    }
    if (tenant && !prior) steps.push(`Adopted existing tenant '${tenantId}' (display name matches this item).`);
    if (!tenant && prior) steps.push(`Tenant '${tenantId}' was removed from the control plane; re-registering it.`);

    if (!tenant) {
      const stamps = await deps.cp.listStamps();
      const pick = pickStamp(stamps, deps.defaultStampId);
      if ('reason' in pick) {
        return {
          phase: 'no-stamp',
          gateId: HEALTH_GATE.stampCapacity,
          message: pick.reason,
          steps,
        };
      }
      tenant = await deps.cp.createTenant({ id: tenantId, displayName: input.displayName, stampId: pick.stamp.id, quotas: { ...DEFAULT_QUOTAS } });
      steps.push(`Registered tenant '${tenantId}' on stamp '${pick.stamp.id}'.`);
    }

    const sanitized = tenantId !== input.displayName.trim().toLowerCase();
    const seed: HealthBinding = {
      tenantId,
      sourceName: input.displayName,
      tenantIdSanitized: sanitized,
      stampId: tenant.stampId,
      status: prior?.status ?? 'provisioning',
      createJobId: prior?.createJobId,
      boundAt: prior?.boundAt,
      verifiedAt: prior?.verifiedAt,
      resources: prior?.resources ?? [],
      engine: prior?.engine,
    };

    // Decide whether a job is needed. A fresh tenant, an unverified one, or one past the TTL needs the
    // (idempotent, incremental) create job; a verified-recently active tenant is just read back.
    const fresh = tenant.status === 'creating' || !prior?.verifiedAt || prior.status !== 'bound';
    const verifiedMs = prior?.verifiedAt ? Date.parse(prior.verifiedAt) : NaN;
    const stale = !Number.isFinite(verifiedMs) || deps.now().getTime() - verifiedMs > VERIFY_TTL_MS;
    if (!fresh && !stale && tenant.status === 'active') {
      // Self-healing (#5442): a verified tenant whose engine is not known to be ready (created before the engine was
      // chained, a failed engine job, or an engine host configured since) gets fhir-tenant.create re-submitted.
      if (prior?.engine?.status === 'ready') return { phase: 'bound', binding: seed, tenant, steps, created: false };
      return await settleEngine(deps, seed, tenant, createKey(tenant), input.retry === true, steps, false);
    }

    const key = fresh ? createKey(tenant) : `verify-${dayKey(deps.now())}`;
    let job = await deps.cp.submitJob({ kind: 'tenant.create', subjectType: 'tenant', subjectId: tenantId, idempotencyKey: key });
    if (job.state === 'failed' && input.retry) {
      job = await deps.cp.retryJob(job.id);
      steps.push(`Retried failed job ${job.id}.`);
    }
    seed.createJobId = job.id;

    if (job.state === 'queued' || job.state === 'running') {
      seed.status = prior?.status === 'bound' ? 'bound' : 'provisioning';
      await persist(deps, seed, steps);
      return { phase: 'provisioning', binding: seed, job, steps };
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      const code = job.error?.code ?? job.state;
      const message = job.error?.message ?? `the tenant.create job was ${job.state}`;
      return failed(prior, seed, code, message, steps, job);
    }

    // Succeeded: the job's readback receipts are the evidence. Re-read the tenant for its final status.
    const finalTenant = (await deps.cp.getTenant(tenantId)) ?? tenant;
    const resources = resourcesFromReceipts(job);
    if (finalTenant.status !== 'active' || resources.length === 0) {
      return failed(prior, seed, 'readback_missing',
        finalTenant.status !== 'active'
          ? `The create job succeeded but the tenant is '${finalTenant.status}', not 'active'.`
          : 'The create job succeeded but recorded no resource readback receipts.', steps, job);
    }
    const nowIso = deps.now().toISOString();
    const bound: HealthBinding = { ...seed, status: 'bound', resources, verifiedAt: job.finishedAt ?? nowIso, boundAt: prior?.boundAt ?? nowIso, lastError: undefined };
    // tenant.create chains the engine itself with key `engine-<this key>`; submitting the same key here is the
    // runner's dedup (same job), and the re-submit that heals a chain that was lost.
    return await settleEngine(deps, bound, finalTenant, key, input.retry === true, steps, !prior);
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return { phase: 'unconfigured', gateId: HEALTH_GATE.controlPlane, missing: e.missing, message: e.message, steps };
    }
    if (e instanceof CpError) {
      return { phase: 'cp-error', code: e.code, message: e.message, steps };
    }
    return { phase: 'cp-error', code: 'unexpected', message: (e as Error)?.message ?? String(e), steps };
  }
}

/** An unregistered job kind is the control plane saying it has no engine host / PDP url (jobs/runner.ts submit). */
function isUnknownKind(e: unknown): boolean {
  return e instanceof CpError && e.status === 400 && /unknown job kind/i.test(e.message);
}

/**
 * Bind the tenant's FHIR engine after the tenant itself is bound: submit fhir-tenant.create under `engine-<parentKey>` (the key
 * tenant.create chains with, so the control plane answers with the SAME job), then report where it stands. A running engine job is
 * `provisioning` with THAT job, so the editor shows its receipts on the real surface (rule section 4). Persists the binding.
 */
async function settleEngine(
  deps: EnsureDeps, bound: HealthBinding, tenant: CpTenant, parentKey: string, retry: boolean, steps: string[], created: boolean,
): Promise<EnsureOutcome> {
  let job: CpJob | undefined;
  try {
    job = await deps.cp.submitJob({ kind: 'fhir-tenant.create', subjectType: 'tenant', subjectId: bound.tenantId, idempotencyKey: `engine-${parentKey}` });
    if (job.state === 'failed' && retry) {
      job = await deps.cp.retryJob(job.id);
      steps.push(`Retried failed engine job ${job.id}.`);
    }
  } catch (e) {
    if (!isUnknownKind(e)) throw e;
    job = undefined;
  }
  if (!job) {
    steps.push('The control plane has no FHIR engine host and PDP url configured, so no engine was created for this tenant.');
    const next = { ...bound, engine: { status: 'unavailable' as const } };
    await persist(deps, next, steps);
    return { phase: 'bound', binding: next, tenant, steps, created };
  }
  if (job.state === 'queued' || job.state === 'running') {
    const next = { ...bound, engine: { status: 'provisioning' as const, jobId: job.id } };
    await persist(deps, next, steps);
    return { phase: 'provisioning', binding: next, job, steps };
  }
  if (job.state === 'failed' || job.state === 'cancelled') {
    const code = job.error?.code ?? job.state;
    const message = `FHIR engine: ${job.error?.message ?? `the fhir-tenant.create job was ${job.state}`}`;
    const next = { ...bound, engine: { status: 'failed' as const, jobId: job.id } };
    await persist(deps, next, steps);
    return { phase: 'failed', binding: { ...next, status: 'failed', lastError: { code, message } }, job, code, message, steps };
  }
  const next = { ...bound, engine: { status: 'ready' as const, jobId: job.id } };
  await persist(deps, next, steps);
  return { phase: 'bound', binding: next, tenant, steps, created };
}

async function persist(deps: EnsureDeps, binding: HealthBinding, steps: string[]): Promise<void> {
  const ok = await deps.persist(binding).catch(() => false);
  steps.push(ok
    ? `Recorded tenant '${binding.tenantId}' on the item.`
    : 'The binding write did not land; the next open re-derives it from the control plane (idempotent).');
}

function failed(
  prior: HealthBinding | undefined,
  seedLike: Pick<HealthBinding, 'tenantId' | 'sourceName' | 'stampId'> & { sanitized?: boolean; tenantIdSanitized?: boolean } & Partial<HealthBinding>,
  code: string,
  message: string,
  steps: string[],
  job?: CpJob,
): EnsureOutcome {
  const binding: HealthBinding = {
    tenantId: seedLike.tenantId,
    sourceName: seedLike.sourceName,
    tenantIdSanitized: seedLike.tenantIdSanitized ?? seedLike.sanitized ?? false,
    stampId: seedLike.stampId,
    createJobId: job?.id ?? seedLike.createJobId ?? prior?.createJobId,
    status: 'failed',
    boundAt: prior?.boundAt,
    verifiedAt: prior?.verifiedAt,
    resources: prior?.resources ?? [],
    lastError: { code, message },
  };
  return { phase: 'failed', binding, job, code, message, steps };
}

/**
 * The phase a read reports (#5388). The binding records `provisioning` until an ensure (POST) sees the
 * create job finish, so a reader that only GETs would be told `provisioning` long after the live job
 * it just fetched had ended `failed` or `cancelled`. That reader is told `failed`, the phase the next
 * ensure records (`failed()` above). Read-only: nothing is persisted here. A `bound` record is left
 * as recorded: its job is a re-verification, and only an ensure may move a bound tenant.
 */
export function livePhase(recorded: HealthBinding['status'], jobState: CpJob['state'] | undefined): HealthBinding['status'] {
  if (recorded === 'provisioning' && (jobState === 'failed' || jobState === 'cancelled')) return 'failed';
  return recorded;
}

// ── real dependencies ────────────────────────────────────────────────────────

/** Persist `state.healthTenant` on the Cosmos item (read-modify-replace on id + workspaceId). */
export function cosmosPersist(itemId: string, workspaceId: string): EnsureDeps['persist'] {
  return async (binding) => {
    const items = await itemsContainer();
    const { resource: cur } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
    if (!cur) return false;
    const next: WorkspaceItem = { ...cur, state: { ...(cur.state || {}), healthTenant: binding }, updatedAt: new Date().toISOString() };
    await items.item(cur.id, cur.workspaceId).replace(next);
    return true;
  };
}

export function realDeps(itemId: string, workspaceId: string): EnsureDeps {
  return {
    cp: realCp,
    readConfig: readCpConfig,
    now: () => new Date(),
    defaultStampId: process.env.LOOM_HEALTH_DEFAULT_STAMP_ID?.trim() || undefined,
    persist: cosmosPersist(itemId, workspaceId),
  };
}

/** Map an ensure outcome onto the install engine's result shape. */
export function toProvisionResult(o: EnsureOutcome): ProvisionResult {
  switch (o.phase) {
    case 'unconfigured':
      return {
        status: 'remediation',
        gate: {
          reason: o.message,
          remediation: `Set ${o.missing.join(' and ')} on the Console. loom-health-cp is deployed by platform/fiab/bicep/health.bicep via .github/workflows/deploy-health.yml; ${CP_ENV.url} is its HTTPS base URL and ${CP_ENV.audience} its token audience.`,
          gateId: o.gateId,
        },
        steps: o.steps,
      };
    case 'no-stamp':
      return {
        status: 'remediation',
        gate: {
          reason: o.message,
          remediation: 'Deploy a stamp with .github/workflows/deploy-health.yml (run_mode=full), then register it healthy in the control plane. A tenant is created only on a healthy stamp.',
          gateId: o.gateId,
        },
        steps: o.steps,
      };
    case 'cp-error':
      return { status: 'failed', error: `${o.code}: ${o.message}`, steps: o.steps };
    case 'failed':
      return { status: 'failed', error: `${o.code}: ${o.message}`, secondaryIds: { tenantId: o.binding.tenantId }, steps: o.steps };
    case 'provisioning':
      return {
        status: 'created',
        resourceId: o.binding.tenantId,
        secondaryIds: { tenantId: o.binding.tenantId, stampId: o.binding.stampId, jobId: o.job.id },
        steps: [...o.steps, `${o.job.kind} job ${o.job.id} is ${o.job.state}; the editor shows its progress.`],
      };
    case 'bound':
      return {
        status: o.created ? 'created' : 'exists',
        resourceId: o.binding.tenantId,
        secondaryIds: { tenantId: o.binding.tenantId, stampId: o.binding.stampId },
        steps: [...o.steps, `${o.binding.resources.length} resource(s) read back.`],
      };
  }
}

export const healthTenantProvisioner: Provisioner = async (input) => {
  // FAIL CLOSED before any control-plane call. PROVISIONERS entries are run by the
  // app installer and by deployment-pipeline promotion with no capability gate of
  // their own, and this one creates real tenant resources on a stamp (D12).
  const denied = await enforceHealthTenantAdmin(input.session, 'Contributor');
  if (denied) {
    const body = (await denied.json().catch(() => ({}))) as { error?: string; reason?: string };
    return {
      status: 'failed',
      error: `Not provisioned: ${body.error ?? 'forbidden'} - the Health Tenant Admin capability (health.tenant-admin) is required. ${body.reason ?? ''}`.trim(),
      steps: ['Capability check failed; the health control plane was not contacted.'],
    };
  }
  const items = await itemsContainer();
  const { resource: cur } = await items.item(input.cosmosItemId, input.workspaceId).read<WorkspaceItem>();
  const outcome = await ensureHealthTenant(
    { itemId: input.cosmosItemId, displayName: input.displayName, state: cur?.state },
    realDeps(input.cosmosItemId, input.workspaceId),
  );
  return toProvisionResult(outcome);
};

/** Result of the delete-time teardown: proceed with the Cosmos delete, or refuse and say why. */
export type DestroyOutcome =
  | { ok: true; destroyJobId?: string }
  | { ok: false; status: 502 | 503; code: string; message: string }
  /** The caller lacks health.tenant-admin: return this 403 as-is, keep the item. */
  | { ok: false; denied: NextResponse };

/**
 * Submit the control-plane `tenant.destroy` job for a `health-tenant` item that
 * is being deleted. Without it the tenant's Event Hub, storage, identity and Key
 * Vault keys outlive the item and keep billing. FAILS CLOSED: if the control
 * plane cannot be asked, the item must not be deleted (a deleted item with a live
 * tenant is the defect). The idempotency key is derived from the item id, so a
 * retried DELETE re-reads the same job instead of submitting a second one.
 * An item with no binding was never provisioned: nothing to destroy.
 */
export async function destroyHealthTenantForItem(
  item: Pick<WorkspaceItem, 'id' | 'itemType' | 'state'>,
  session: SessionPayload,
  submitJob: typeof realCp.submitJob = realCp.submitJob,
): Promise<DestroyOutcome> {
  if (item.itemType !== 'health-tenant') return { ok: true };
  const binding = readBinding(item.state as Record<string, unknown> | undefined);
  if (!binding?.tenantId) return { ok: true };
  // Destroying a tenant is irreversible: same strict, non-inherited capability as
  // create/PATCH (D12). Workspace ownership alone is not enough.
  const denied = await enforceHealthTenantAdmin(session, 'Contributor');
  if (denied) return { ok: false, denied };
  try {
    const job = await submitJob({
      kind: 'tenant.destroy',
      subjectType: 'tenant',
      subjectId: binding.tenantId,
      idempotencyKey: `destroy-${item.id}`,
      input: { confirmTenantId: binding.tenantId },
    });
    return { ok: true, destroyJobId: job.id };
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return {
        ok: false, status: 503, code: 'health_cp_not_configured',
        message: `The item was NOT deleted: its health tenant "${binding.tenantId}" could not be destroyed because the health control plane is not configured (missing env: ${e.missing.join(', ')}).`,
      };
    }
    if (e instanceof CpError) {
      return {
        ok: false, status: 502, code: e.code,
        message: `The item was NOT deleted: the control plane did not accept the destroy job for tenant "${binding.tenantId}" (${e.code}: ${e.message}).`,
      };
    }
    throw e;
  }
}
