/**
 * ESTATE PAUSE / RESUME — the ARM actuator (PRP §10b W2).
 *
 * Extracted from `./pause-orchestrator` on 2026-08-23. Two reasons, both
 * load-bearing:
 *
 *  1. The orchestrator had grown to 1752 LOC and tripped this repository's
 *     monolith-creep guard (`scripts/ci/check-file-size.mjs`, 1500-LOC warn
 *     ceiling). Splitting by bounded context is the fix that guard names.
 *  2. `lib/estate/__tests__/pause-actuator.test.ts` already existed and
 *     already tested exactly this surface — it was reaching into the
 *     orchestrator to get it. The test now sits opposite the module it names.
 *
 * `./pause-orchestrator` re-exports every symbol below, so every existing
 * importer — and every `vi.mock('.../pause-orchestrator')` in the suite —
 * keeps working unchanged.
 *
 * ── THE ONE RULE THIS MODULE EXISTS TO HOLD ────────────────────────────────
 * EVERY verb — `pause`, `resume`, `readPower`, `readTags` AND `probeServable`
 * — addresses the `resourceId` whose ownership was verified. No verb
 * re-derives its target from `process.env`. `assertActuationTarget` records
 * the incident that made that non-negotiable for the mutating verbs; the
 * `probeServable` docblock records the second one, for the CONFIRM path.
 */

import {
  armPowerReading,
  type ArmPowerReading,
  type EstatePowerState,
  type EstateSkuSnapshot,
  type PausedResourceSnapshot,
} from './pause-state';
import { pausableTypeSpec, type PauseCandidate } from './pause-inventory';

// ---------------------------------------------------------------------------
// The injected actuator
// ---------------------------------------------------------------------------

/** The outcome of one ARM mutation. `ok:false` never throws away the reason. */
export interface ActuatorResult {
  ok: boolean;
  /** What was actually established, in the words shown to the operator. */
  detail: string;
  /** Raw failure text when `ok` is false. Classified by ./capacity-preflight. */
  error?: string;
}

/** An AUTHORITATIVE ARM read: power state + the SKU/replica facts resume needs. */
export interface PowerRead {
  /** null when the read did not establish a state. NEVER a default of Online. */
  reading: ArmPowerReading | null;
  error?: string;
  sku?: EstateSkuSnapshot;
  replicaCount?: number;
}

/** Whether the resource can actually SERVE, as opposed to reporting a state. */
export interface ServabilityProbe {
  /** 'servable' only when a real data-plane round-trip succeeded. */
  servable: boolean;
  detail: string;
  /** False when this type has no probe wired — reported, never assumed servable. */
  probed: boolean;
}

/**
 * Everything the orchestrator needs from the outside world.
 *
 * Deliberately five small methods rather than one `doPause(everything)`: each
 * one is a seam a test can make fail independently, which is how the fail-safe
 * branches get covered.
 */
export interface EstateActuator {
  /** R-SCOPE-3 — fresh tags for the re-verify, immediately before acting. */
  readTags(resourceId: string): Promise<Readonly<Record<string, string>> | null>;
  /** PRP §3c — authoritative ARM, never Resource Graph. */
  readPower(resource: {
    resourceId: string;
    resourceType: string;
    name: string;
  }): Promise<PowerRead>;
  /** The native pause/stop/suspend verb. Composes an existing lib/azure client. */
  pause(candidate: PauseCandidate): Promise<ActuatorResult>;
  /** The native resume/start verb. */
  resume(entry: PausedResourceSnapshot): Promise<ActuatorResult>;
  /** A REAL data-plane round-trip. `probed:false` when none is wired. */
  probeServable(entry: PausedResourceSnapshot): Promise<ServabilityProbe>;
}

/** Normalise each provider's own power vocabulary onto `EstatePowerState`. */
export function normalizePowerState(resourceType: string, raw: unknown): EstatePowerState {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Unknown';
  switch (resourceType.toLowerCase()) {
    case 'microsoft.synapse/workspaces/sqlpools':
      // Learn: Online | Paused | Pausing | Resuming | Scaling.
      if (s === 'online') return 'Online';
      if (s === 'paused') return 'Paused';
      if (s === 'pausing') return 'Pausing';
      if (s === 'resuming') return 'Resuming';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    case 'microsoft.kusto/clusters':
      // Learn: Running | Stopped | Starting | Stopping | Unavailable | Deleting.
      if (s === 'running') return 'Online';
      if (s === 'stopped') return 'Stopped';
      if (s === 'starting') return 'Starting';
      if (s === 'stopping') return 'Pausing';
      return 'Unknown';
    case 'microsoft.analysisservices/servers':
      // Learn: Succeeded (running) | Paused | Suspended | Suspending | Resuming | Scaling.
      if (s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'suspended') return 'Paused';
      if (s === 'suspending') return 'Pausing';
      if (s === 'resuming' || s === 'preparing' || s === 'provisioning') return 'Resuming';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    default:
      if (s === 'online' || s === 'running' || s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'stopped' || s === 'suspended') return 'Paused';
      if (s === 'deallocated') return 'Deallocated';
      return 'Unknown';
  }
}

/**
 * The REAL actuator. Every verb addresses `resourceId` DIRECTLY through the
 * shared, cloud-aware ARM transport (`lib/azure/arm-client`):
 *
 *   Synapse pool  ->  POST {poolId}/pause      | {poolId}/resume
 *   ADX cluster   ->  POST {clusterId}/stop    | {clusterId}/start
 *   AAS server    ->  POST {serverId}/suspend  | {serverId}/resume
 *   SHIR VMSS     ->  PATCH {vmssId} sku.capacity
 *
 * ── WHY NOT THE TYPED CLIENTS FOR SYNAPSE AND ADX ─────────────────────────
 * `pausePool()`, `resumePool()`, `stopKustoCluster()` and `startKustoCluster()`
 * take NO ARGUMENTS: they re-derive their target from `process.env` at call
 * time. Composing them would mean the resource that gets mutated is not the
 * resource whose ownership `reverifyBeforeAct` just checked — the two coincide
 * today only because discovery is itself env-derived, and they diverge the
 * moment #3922 makes the `loom-estate-id` tag the discovery source. Worse,
 * `synapse-pool-arm.ts` self-heals across a sub/RG mismatch by re-discovering
 * coordinates through Resource Graph, so it can retarget even after a check.
 *
 * The ARM action paths above are byte-identical to the ones those clients build
 * internally, so nothing is reimplemented; the only thing removed is the
 * client's ability to pick a different target than the verified one. See
 * `assertActuationTarget`.
 *
 * ── CLOUD BOUNDARY ─────────────────────────────────────────────────────────
 * `arm-client` resolves its host via `armBase()`, so these calls are correct in
 * Commercial, GCC, GCC-High and DoD, and this path has no `api.github.com`
 * dependency. That makes the code cloud-agnostic — it does NOT make it
 * cloud-VERIFIED. Only Commercial has been exercised, and only against
 * fixtures; Gov is UNTESTED and is owned by PRP work item W7. The
 * `LOOM_ESTATE_PAUSE_ENABLED` opt-in below is unset in every boundary,
 * including Gov, so a sovereign console renders the surface inert until an
 * operator there deliberately arms it.
 *
 * The imports are lazy so the pure half of this module stays importable in a
 * unit test without constructing an Azure credential chain.
 */
export async function createArmActuator(): Promise<EstateActuator> {
  const { armGet, armPost, armPatch } = await import('@/lib/azure/arm-client');

  const apiVersion = (resourceType: string): string =>
    pausableTypeSpec(resourceType)?.armApiVersion ?? '2021-04-01';

  const readTags = async (resourceId: string) => {
    // The api-version is per-provider, so derive it from the id's own type.
    const type = armTypeFromId(resourceId);
    const body = await armGet<{ tags?: Record<string, string> }>(
      `${resourceId}?api-version=${apiVersion(type)}`,
    );
    // ARM omits `tags` entirely when a resource has none. That is a SUCCESSFUL
    // read establishing "no tags", which is different from a failed read — so
    // return {} here and let a thrown error be the only `null`.
    return body?.tags ?? {};
  };

  const readPower = async (resource: {
    resourceId: string;
    resourceType: string;
    name: string;
  }): Promise<PowerRead> => {
    const version = apiVersion(resource.resourceType);
    try {
      const body = await armGet<{
        sku?: { name?: string; tier?: string; family?: string; capacity?: number };
        properties?: { status?: string; state?: string };
      }>(`${resource.resourceId}?api-version=${version}`);
      const raw = body?.properties?.status ?? body?.properties?.state;
      return {
        reading: armPowerReading({
          resourceId: resource.resourceId,
          powerState: normalizePowerState(resource.resourceType, raw),
          armApiVersion: version,
        }),
        ...(body?.sku ? { sku: body.sku } : {}),
        ...(typeof body?.sku?.capacity === 'number' ? { replicaCount: body.sku.capacity } : {}),
      };
    } catch (err) {
      // R7 — say what happened, do not convert a failed read into a state.
      return { reading: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const pause = async (candidate: PauseCandidate): Promise<ActuatorResult> => {
    const { resource } = candidate;
    const type = resource.resourceType.toLowerCase();
    try {
      // The mutation must land on the id whose ownership was re-verified. See
      // `assertActuationTarget` for why this is not negotiable.
      assertActuationTarget(resource);
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          // POST {poolId}/pause — the same path synapse-pool-arm builds in
          // `actionUrlFor`, but addressed at OUR id rather than re-derived from
          // process.env (and immune to that client's Resource-Graph self-heal).
          await armPost(`${resource.resourceId}/pause?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the pause of dedicated SQL pool ${resource.name}.` };
        }
        case 'microsoft.kusto/clusters': {
          // POST {clusterId}/stop — the same path kusto-arm-client builds in
          // `stopKustoCluster`, addressed at OUR id.
          await armPost(`${resource.resourceId}/stop?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the stop of ADX cluster ${resource.name}.` };
        }
        case 'microsoft.analysisservices/servers': {
          await armPost(`${resource.resourceId}/suspend?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the suspend of Analysis Services server ${resource.name}.` };
        }
        case 'microsoft.compute/virtualmachinescalesets': {
          await armPatch(`${resource.resourceId}?api-version=${apiVersion(type)}`, { sku: { capacity: 0 } });
          return { ok: true, detail: `ARM accepted scaling ${resource.name} to 0 instances.` };
        }
        default:
          return {
            ok: false,
            detail: `${resource.name} is type ${type}, which this PAUSE tier does not actuate.`,
            error: `unsupported-type:${type}`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `The pause of ${resource.name} was REJECTED by ARM.`, error: message };
    }
  };

  const resume = async (entry: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const type = entry.resourceType.toLowerCase();
    try {
      assertActuationTarget(entry);
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          await armPost(`${entry.resourceId}/resume?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the resume of dedicated SQL pool ${entry.name}.` };
        }
        case 'microsoft.kusto/clusters': {
          await armPost(`${entry.resourceId}/start?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the start of ADX cluster ${entry.name}.` };
        }
        case 'microsoft.analysisservices/servers': {
          await armPost(`${entry.resourceId}/resume?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the resume of Analysis Services server ${entry.name}.` };
        }
        case 'microsoft.compute/virtualmachinescalesets': {
          const capacity = entry.replicaCount ?? entry.sku?.capacity ?? 1;
          await armPatch(`${entry.resourceId}?api-version=${apiVersion(type)}`, { sku: { capacity } });
          return { ok: true, detail: `ARM accepted restoring ${entry.name} to ${capacity} instance(s).` };
        }
        default:
          return {
            ok: false,
            detail: `${entry.name} is type ${type}, which this PAUSE tier does not actuate.`,
            error: `unsupported-type:${type}`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `The resume of ${entry.name} was REJECTED by ARM.`, error: message };
    }
  };

  /** No request was issued — say so, and never let that read as "not servable". */
  const unprobed = (entry: PausedResourceSnapshot, why: string): ServabilityProbe => ({
    servable: false,
    probed: false,
    detail:
      `No probe could be issued for ${entry.name} because ${why}. Whether it can serve was NOT `
      + 'established — only that ARM reports it running.',
  });

  /**
   * A REAL round-trip to the resource — the answer to "can it serve?", which the
   * ARM status field does not give. A resumed Synapse pool reports ONLINE 2-3
   * minutes before it will accept a query, which is why `pollResume` will not
   * call a resource RUNNING on the status field alone.
   *
   * ── WHY EVERY BRANCH ADDRESSES `entry.resourceId` (review, 2026-08-23) ─────
   * The first version of this function used its `entry` argument ONLY to build
   * the message string — the exact defect `assertActuationTarget` was written to
   * stop, reintroduced on the CONFIRM path:
   *
   *   Synapse -> dedicatedTarget()  -> required('LOOM_SYNAPSE_WORKSPACE')
   *                                  + required('LOOM_SYNAPSE_DEDICATED_POOL')
   *   ADX     -> the LOOM_KUSTO_DATABASE env var, issued against kusto-client's
   *              module-level CLUSTER_URI whose fallback is a HARD-CODED cluster
   *              name and region
   *   AAS     -> listDatabases(), zero-arg, against the env-pinned server
   *
   * So the estate could confirm that resource A had resumed by successfully
   * querying resource B. Both failure modes are live: a FALSE RUNNING (the env
   * resource is healthy, the resumed one is not) and a permanently stuck
   * RESUME_FAILED. That is the same recency-vs-serving class as #3676. The two
   * coincide today only because discovery is itself env-derived, and they
   * diverge the moment #3922 makes the `loom-estate-id` tag the discovery
   * source — which is what this feature's own empty state tells operators to go
   * and do.
   *
   * `LOOM_KUSTO_DATABASE` is gone with it. It was read here but emitted by NO
   * bicep module and absent from the live console's env, so the no-database
   * branch was the DEFAULT on the real estate: `servable:false` -> `pollResume`
   * -> `confirmation:'unknown'` -> **RESUME_FAILED reported for an ADX cluster
   * that had resumed perfectly.** The cluster's query endpoint and its database
   * now both come from ARM, addressed at the verified id, so there is no env var
   * left for an operator to set (`auto-bind-by-default.md` §5).
   */
  const probeServable = async (entry: PausedResourceSnapshot): Promise<ServabilityProbe> => {
    const type = entry.resourceType.toLowerCase();
    // A probe is a real request to a real resource, so it is held to the same
    // targeting rule as the mutating verbs. Fails CLOSED and reports honestly:
    // nothing was asked, so nothing was established.
    try {
      assertActuationTarget(entry);
    } catch (err) {
      return unprobed(entry, err instanceof Error ? err.message : String(err));
    }
    try {
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          // .../workspaces/{workspace}/sqlPools/{pool} — both coordinates come
          // out of the id we verified, never out of process.env.
          const workspace = armIdSegment(entry.resourceId, 'workspaces');
          const pool = armIdSegment(entry.resourceId, 'sqlPools');
          if (!workspace || !pool) {
            return unprobed(entry, 'its resource id does not name both a workspace and a sqlPools child');
          }
          const { executeQuery, getSynapseSqlSuffix } = await import('@/lib/azure/synapse-sql-client');
          await executeQuery(
            {
              server: `${workspace}.${getSynapseSqlSuffix()}`,
              database: pool,
              cacheKey: `dedicated:${workspace}:${pool}`,
            },
            'SELECT 1 AS loom_pause_probe',
            20_000,
          );
          return { servable: true, probed: true, detail: `${entry.name} answered SELECT 1 over TDS.` };
        }
        case 'microsoft.kusto/clusters': {
          const version = apiVersion(type);
          // The cluster's OWN query endpoint, not kusto-client's module default.
          const cluster = await armGet<{ properties?: { uri?: string } }>(
            `${entry.resourceId}?api-version=${version}`,
          );
          const clusterUri = String(cluster?.properties?.uri ?? '').trim();
          if (!clusterUri) {
            return unprobed(entry, 'ARM did not report a query endpoint (properties.uri) for it');
          }
          // A database to run `print` in, derived from the cluster we verified.
          // ARM names a child database `{clusterName}/{databaseName}`.
          const dbs = await armGet<{ value?: Array<{ name?: string }> }>(
            `${entry.resourceId}/databases?api-version=${version}`,
          );
          const first = (dbs?.value ?? []).map((d) => String(d?.name ?? '').trim()).filter(Boolean)[0] ?? '';
          const database = first.includes('/') ? first.slice(first.indexOf('/') + 1) : first;
          if (!database) {
            return unprobed(entry, 'it has no databases, so there is nothing to issue a KQL probe against');
          }
          const { executeQuery } = await import('@/lib/azure/kusto-client');
          await executeQuery(database, 'print loom_pause_probe = 1', { clusterUri });
          return {
            servable: true,
            probed: true,
            detail: `${entry.name} answered a KQL print on database ${database}.`,
          };
        }
        case 'microsoft.analysisservices/servers': {
          // HONEST SCOPE: this is an ARM CONTROL-PLANE read, addressed at the
          // verified id. It establishes that this server is addressable and
          // enumerable — NOT that a model will answer a query. The previous
          // implementation called the env-pinned `listDatabases()` and described
          // the result as "answered a model list over XMLA", which was untrue on
          // both counts (R7): it is neither XMLA nor necessarily this server.
          //
          // A genuine AAS data-plane probe needs a different credential scope and
          // host shape that nothing in this feature has ever exercised against
          // live Azure. An unverified probe that errors would report
          // RESUME_FAILED for a HEALTHY server, which is strictly worse than the
          // weaker guarantee. Wiring the real XMLA probe is a tracked follow-up.
          await armGet(`${entry.resourceId}/databases?api-version=${apiVersion(type)}`);
          return {
            servable: true,
            probed: true,
            detail:
              `${entry.name} answered an ARM model-list request against its own resource id `
              + '(control plane — this is not a data-plane query).',
          };
        }
        default:
          return {
            servable: false,
            probed: false,
            detail:
              `No data-plane probe is wired for ${type}. Whether ${entry.name} can serve was NOT `
              + 'established — only that ARM reports it running.',
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { servable: false, probed: true, detail: `${entry.name} did not answer a probe request: ${message}` };
    }
  };

  return { readTags, readPower, pause, resume, probeServable };
}

/**
 * Assert the id we are about to mutate is the one whose ownership was verified,
 * and that it addresses the TYPE we think it does.
 *
 * ── WHY THIS EXISTS (independent review, 2026-08-23) ───────────────────────
 * The first version of this actuator called the typed clients for Synapse and
 * ADX with ZERO arguments:
 *
 *     const { pausePool } = await import('@/lib/azure/synapse-pool-arm');
 *     await pausePool();
 *
 * `pausePool()` re-derives its target from `process.env`
 * (`synapse-pool-arm.ts` `configuredCoords()` + `required('LOOM_SYNAPSE_
 * DEDICATED_POOL')`), and `stopKustoCluster()` does the same via
 * `readKustoArmConfig()`. The `candidate` was used only to build the message
 * string. So **the resource that got paused was not the resource whose
 * ownership had just been re-verified** — R-SCOPE-3 checked
 * `candidate.resource.resourceId` and the mutation landed on whatever the env
 * named. AAS and VMSS in the same switch already used the id correctly, and
 * that inconsistency was the tell.
 *
 * Today those two coincide, because discovery is itself env-derived. **They
 * stop coinciding the moment #3922 lands** and the `loom-estate-id` tag becomes
 * the discovery source — which is exactly what this feature's empty state tells
 * the operator to go and do. A tag-discovered pool would be ownership-verified
 * against its own id and then paused via the env's pool, bypassing every scope
 * guard in the design.
 *
 * Worse, `synapse-pool-arm.ts` `fetchPool()` SELF-HEALS across a sub/RG
 * mismatch by discovering the workspace's real coordinates through Resource
 * Graph and caching them — so even asserting "candidate id === env id" would not
 * have been sufficient; the client can silently retarget after the assertion.
 *
 * The fix is therefore not an assertion bolted onto the env path. Every verb
 * below addresses `resourceId` DIRECTLY through the shared, cloud-aware ARM
 * transport, exactly as AAS and VMSS already did. The ARM action paths are
 * byte-identical to what the typed clients build internally
 * (`{clusterUrl}/stop`, `{poolUrl}/pause`), so nothing is reimplemented — the
 * only thing removed is the client's ability to choose a different target than
 * the one we verified.
 */
export function assertActuationTarget(
  target: { resourceId: string; resourceType: string; name: string },
): void {
  if (!target.resourceId || !target.resourceId.startsWith('/subscriptions/')) {
    throw new Error(
      `Refusing to actuate ${target.name}: '${target.resourceId}' is not a fully-qualified ARM `
        + 'resource id. A mutation must address the exact resource whose ownership was verified.',
    );
  }
  const derived = armTypeFromId(target.resourceId);
  const declared = target.resourceType.toLowerCase();
  if (derived !== declared) {
    throw new Error(
      `Refusing to actuate ${target.name}: its recorded type is '${declared}' but its resource id `
        + `addresses '${derived}'. The two disagree, so which resource would be mutated was NOT `
        + 'established.',
    );
  }
}

/** `/subscriptions/x/resourceGroups/y/providers/A/b/n[/c/m]` -> `a/b[/c]`. */
export function armTypeFromId(resourceId: string): string {
  const i = resourceId.toLowerCase().indexOf('/providers/');
  if (i < 0) return '';
  const parts = resourceId.slice(i + '/providers/'.length).split('/').filter(Boolean);
  if (parts.length < 2) return '';
  // provider, type, name [, subtype, name]…  -> provider/type[/subtype]
  const segments = [parts[0], parts[1]];
  for (let p = 3; p < parts.length; p += 2) segments.push(parts[p]);
  return segments.join('/').toLowerCase();
}

/**
 * Pull ONE named coordinate out of an ARM id — `armIdSegment(poolId,
 * 'sqlPools')` -> the pool name, `(poolId, 'workspaces')` -> the workspace.
 *
 * This exists so a data-plane probe can derive its target from the id whose
 * ownership was VERIFIED instead of from `process.env`. Matching is
 * case-insensitive because ARM ids are not case-stable (`sqlPools` vs
 * `sqlpools`), and it returns '' rather than guessing when the segment is
 * absent — the caller turns that into an honest "not probed", never into a
 * fallback target.
 */
export function armIdSegment(resourceId: string, segment: string): string {
  const i = resourceId.toLowerCase().indexOf('/providers/');
  if (i < 0) return '';
  const parts = resourceId.slice(i + '/providers/'.length).split('/').filter(Boolean);
  const want = segment.toLowerCase();
  // parts: provider, type, name [, subtype, name]… — so type/name pairs start at 1.
  for (let p = 1; p + 1 < parts.length; p += 2) {
    if (parts[p].toLowerCase() === want) return parts[p + 1];
  }
  return '';
}
