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
  type EstateComputeChild,
  type EstateScaleSnapshot,
  type EstateSkuSnapshot,
  type PausedResourceSnapshot,
} from './pause-state';
import { pausableTypeSpec, type PauseCandidate } from './pause-inventory';
import { containerAppPauseGuard } from './pause-guards';
import { ESTATE_READ_RETRY, isThrottleError, shortCircuitedError } from './pause-throttle';

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
  /**
   * True when the actuator established that stopping changes nothing and so sent
   * no mutation (already at the floor, or a plan that bills $0 at idle). The
   * orchestrator reports it as `no-op` and does not record it in the snapshot.
   */
  noop?: boolean;
}

/** An AUTHORITATIVE ARM read: power state + the SKU/replica facts resume needs. */
export interface PowerRead {
  /** null when the read did not establish a state. NEVER a default of Online. */
  reading: ArmPowerReading | null;
  error?: string;
  /**
   * True when the read failed because ARM throttled it (429). A throttle is a
   * statement about the control plane's rate limit, never about the resource,
   * so callers MUST NOT settle a state on it (see ./pause-throttle).
   */
  throttled?: boolean;
  sku?: EstateSkuSnapshot;
  replicaCount?: number;
  /** Container Apps: the template.scale range, so resume restores it exactly. */
  scale?: EstateScaleSnapshot;
  /** Databricks workspaces: the compute RUNNING right now (see PausedResourceSnapshot.children). */
  children?: EstateComputeChild[];
}

/** Whether the resource can actually SERVE, as opposed to reporting a state. */
export interface ServabilityProbe {
  /** 'servable' only when a real data-plane round-trip succeeded. */
  servable: boolean;
  detail: string;
  /** False when this type has no probe wired — reported, never assumed servable. */
  probed: boolean;
  /** True when the probe's ARM read was throttled: unknown, not a failure. */
  throttled?: boolean;
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
  pause(candidate: PauseCandidate, entry?: PausedResourceSnapshot): Promise<ActuatorResult>;
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
    case 'microsoft.compute/virtualmachines': {
      // instanceView status code, e.g. 'PowerState/running'. Learn: starting |
      // running | stopping | stopped | deallocating | deallocated | unknown.
      // 'stopped' is OS-stopped but STILL ALLOCATED (still billed); it is
      // reported as Stopped, not Deallocated, so it is never mistaken for savings.
      const v = s.startsWith('powerstate/') ? s.slice('powerstate/'.length) : s;
      if (v === 'running') return 'Online';
      if (v === 'deallocated') return 'Deallocated';
      if (v === 'stopped') return 'Stopped';
      if (v === 'starting') return 'Starting';
      if (v === 'stopping' || v === 'deallocating') return 'Pausing';
      return 'Unknown';
    }
    case 'microsoft.containerservice/managedclusters':
      // properties.powerState.code: Running | Stopped. The caller substitutes
      // provisioningState Starting/Stopping while an operation is in flight.
      if (s === 'running') return 'Online';
      if (s === 'stopped') return 'Stopped';
      if (s === 'starting') return 'Starting';
      if (s === 'stopping') return 'Pausing';
      return 'Unknown';
    case 'microsoft.app/containerapps':
      // Not an ARM field: the caller derives it from template.scale + the live
      // replica count (online = min > 0; paused = min 0 and 0 replicas;
      // scaling = min 0 but replicas still running).
      if (s === 'online') return 'Online';
      if (s === 'paused') return 'Paused';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    case 'microsoft.streamanalytics/streamingjobs':
      // Learn jobState: Created | Starting | Running | Stopping | Stopped |
      // Deleting | Failed | Degraded | Restarting | Scaling. Failed/Degraded are
      // deliberately Unknown: a job in trouble is left alone, not "paused".
      if (s === 'running') return 'Online';
      if (s === 'stopped' || s === 'created') return 'Stopped';
      if (s === 'starting' || s === 'restarting') return 'Starting';
      if (s === 'stopping') return 'Pausing';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    case 'microsoft.databricks/workspaces':
      // Not a Databricks field: the caller folds the states of the workspace's
      // warehouses and clusters into one word via `dbxWorkspacePowerWord`.
      if (s === 'online') return 'Online';
      if (s === 'paused') return 'Paused';
      if (s === 'starting') return 'Starting';
      if (s === 'stopping') return 'Pausing';
      return 'Unknown';
    case 'microsoft.web/sites':
      // properties.state: Running | Stopped (others, e.g. QuotaExceeded, Unknown).
      if (s === 'running') return 'Online';
      if (s === 'stopped') return 'Stopped';
      return 'Unknown';
    default:
      if (s === 'online' || s === 'running' || s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'stopped' || s === 'suspended') return 'Paused';
      if (s === 'deallocated') return 'Deallocated';
      return 'Unknown';
  }
}

/** Classify one Databricks warehouse/cluster state. Unrecognised => 'unknown' (fail safe). */
export function dbxStateClass(raw: string): 'running' | 'starting' | 'stopping' | 'stopped' | 'unknown' {
  const st = String(raw ?? '').trim().toUpperCase();
  if (st === 'RUNNING') return 'running';
  if (st === 'STARTING' || st === 'PENDING' || st === 'RESTARTING' || st === 'RESIZING') return 'starting';
  if (st === 'STOPPING' || st === 'TERMINATING') return 'stopping';
  // ERROR = failed to start: not running and not billed. DELETED = gone.
  if (st === 'STOPPED' || st === 'TERMINATED' || st === 'ERROR' || st === 'DELETED' || st === 'DELETING') return 'stopped';
  return 'unknown';
}

/**
 * Fold a workspace's compute states into one power word. Any unrecognised state
 * makes the whole workspace 'unknown' so it is never paused on a guess.
 */
export function dbxWorkspacePowerWord(states: readonly string[]): string {
  const classes = states.map(dbxStateClass);
  if (classes.includes('unknown')) return 'unknown';
  if (classes.includes('running')) return 'online';
  if (classes.includes('starting')) return 'starting';
  if (classes.includes('stopping')) return 'stopping';
  return 'paused';
}

/** Shape of the Container App fields the actuator reads and writes. */
interface AcaBody {
  properties?: {
    provisioningState?: string;
    template?: { scale?: { minReplicas?: number; maxReplicas?: number } };
  };
}

/** Compute the Container App power vocabulary from min replicas + live replicas. */
function acaPowerWord(minReplicas: number | undefined, liveReplicas: number): string {
  if (typeof minReplicas !== 'number') return '';
  if (minReplicas > 0) return 'online';
  return liveReplicas === 0 ? 'paused' : 'scaling';
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
  const { armGet, armGetWithRetry, armPost, armPatch } = await import('@/lib/azure/arm-client');

  /**
   * Every STATE-path ARM read (readPower, the probes, the Databricks host
   * lookup) goes through the 429-aware GET with a bounded budget, plus a
   * per-actuator breaker: once one read stays throttled, later reads in the
   * same request are not sent (the read quota is shared by the whole
   * subscription, so sending N more would deepen the throttle and multiply the
   * latency by N). They fail with the same ArmThrottledError-named, honest
   * message. `readTags` and the act-time reads stay single-shot on purpose: at
   * the moment of acting, any doubt must skip the mutation rather than wait.
   */
  let firstThrottle: string | null = null;
  const stateGet = async <T = any>(path: string): Promise<T> => {
    if (firstThrottle !== null) throw shortCircuitedError(path, firstThrottle);
    try {
      return await armGetWithRetry<T>(path, ESTATE_READ_RETRY);
    } catch (err) {
      if (isThrottleError(err)) firstThrottle = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

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
    const type = resource.resourceType.toLowerCase();
    try {
      if (type === 'microsoft.app/containerapps') {
        return await readContainerAppPower(resource.resourceId, version);
      }
      if (type === 'microsoft.databricks/workspaces') {
        return await readDatabricksPower(resource.resourceId, version);
      }
      // A VM's power state lives in instanceView, which GET only returns on request.
      const expand = type === 'microsoft.compute/virtualmachines' ? '&$expand=instanceView' : '';
      const body = await stateGet<{
        sku?: { name?: string; tier?: string; family?: string; capacity?: number };
        properties?: {
          status?: string;
          state?: string;
          jobState?: string;
          provisioningState?: string;
          powerState?: { code?: string };
          hardwareProfile?: { vmSize?: string };
          instanceView?: { statuses?: Array<{ code?: string }> };
        };
      }>(`${resource.resourceId}?api-version=${version}${expand}`);
      let raw: unknown = body?.properties?.status ?? body?.properties?.state;
      let sku = body?.sku;
      if (type === 'microsoft.compute/virtualmachines') {
        raw = (body?.properties?.instanceView?.statuses ?? [])
          .map((st) => String(st?.code ?? ''))
          .find((c) => c.toLowerCase().startsWith('powerstate/'));
        // Record the size so resume can prove it restored the SAME VM size.
        if (body?.properties?.hardwareProfile?.vmSize) sku = { name: body.properties.hardwareProfile.vmSize };
      } else if (type === 'microsoft.containerservice/managedclusters') {
        const prov = String(body?.properties?.provisioningState ?? '').toLowerCase();
        raw = prov === 'starting' || prov === 'stopping' ? prov : body?.properties?.powerState?.code;
      } else if (type === 'microsoft.streamanalytics/streamingjobs') {
        raw = body?.properties?.jobState;
      }
      return {
        reading: armPowerReading({
          resourceId: resource.resourceId,
          powerState: normalizePowerState(resource.resourceType, raw),
          armApiVersion: version,
        }),
        ...(sku ? { sku } : {}),
        ...(typeof sku?.capacity === 'number' ? { replicaCount: sku.capacity } : {}),
      };
    } catch (err) {
      // R7 — say what happened, do not convert a failed read into a state.
      return {
        reading: null,
        error: err instanceof Error ? err.message : String(err),
        ...(isThrottleError(err) ? { throttled: true } : {}),
      };
    }
  };

  /**
   * The data-plane host of the VERIFIED workspace, from ARM
   * (`properties.workspaceUrl`) - never from LOOM_DATABRICKS_HOSTNAME. The host
   * is validated against the known Azure Databricks domains before any token is
   * sent to it.
   */
  const dbxHostFor = async (resourceId: string, version: string): Promise<string> => {
    const { assertDatabricksHost } = await import('@/lib/azure/databricks-estate-client');
    const ws = await stateGet<{ properties?: { workspaceUrl?: string; provisioningState?: string } }>(
      `${resourceId}?api-version=${version}`,
    );
    const prov = String(ws?.properties?.provisioningState ?? '');
    if (prov && prov.toLowerCase() !== 'succeeded') {
      throw new Error(`The Databricks workspace is in provisioningState '${prov}', so its compute cannot be addressed yet.`);
    }
    return assertDatabricksHost(ws?.properties?.workspaceUrl);
  };

  const readDatabricksPower = async (resourceId: string, version: string): Promise<PowerRead> => {
    const dbx = await import('@/lib/azure/databricks-estate-client');
    const host = await dbxHostFor(resourceId, version);
    const [warehouses, clusters] = await Promise.all([dbx.listWarehouses(host), dbx.listUserClusters(host)]);
    const all = [...warehouses, ...clusters];
    const children: EstateComputeChild[] = all
      .filter((c) => dbxStateClass(c.state) === 'running')
      .map((c) => ({
        kind: c.kind,
        id: c.id,
        name: c.name,
        priorState: c.state,
        ...(typeof c.autoStopMins === 'number' ? { autoStopMins: c.autoStopMins } : {}),
      }));
    return {
      reading: armPowerReading({
        resourceId,
        powerState: normalizePowerState(
          'microsoft.databricks/workspaces',
          dbxWorkspacePowerWord(all.map((c) => c.state)),
        ),
        armApiVersion: version,
      }),
      children,
    };
  };

  const getChild = async (host: string, c: EstateComputeChild) => {
    const dbx = await import('@/lib/azure/databricks-estate-client');
    return c.kind === 'sql-warehouse' ? dbx.getWarehouse(host, c.id) : dbx.getCluster(host, c.id);
  };

  /** Stop the recorded children; read each back. Never touches compute that is not in `entry.children`. */
  const pauseDatabricks = async (resource: { resourceId: string; name: string }, entry?: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const version = apiVersion('microsoft.databricks/workspaces');
    const children = entry?.children;
    if (!children) {
      return {
        ok: false,
        detail: `No pre-pause compute list was recorded for workspace ${resource.name}, so Loom will not guess what to stop. Left RUNNING.`,
        error: 'dbx-no-recorded-children',
      };
    }
    if (children.length === 0) {
      return { ok: true, noop: true, detail: `Workspace ${resource.name} had no running warehouses or clusters; nothing to stop.` };
    }
    const dbx = await import('@/lib/azure/databricks-estate-client');
    const host = await dbxHostFor(resource.resourceId, version);
    const failed: string[] = [];
    const stopped: string[] = [];
    for (const c of children) {
      try {
        const cls = dbxStateClass((await getChild(host, c)).state);
        if (cls === 'running' || cls === 'starting') {
          if (c.kind === 'sql-warehouse') await dbx.stopWarehouse(host, c.id);
          else await dbx.terminateCluster(host, c.id);
        }
        const after = dbxStateClass((await getChild(host, c)).state);
        if (after === 'stopped' || after === 'stopping') stopped.push(c.name);
        else failed.push(`${c.kind} ${c.name}: read-back reports '${after}' after the stop`);
      } catch (err) {
        failed.push(`${c.kind} ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length > 0) {
      return {
        ok: false,
        detail:
          `The pause of workspace ${resource.name} was only partly applied (${stopped.length} stopped, ${failed.length} not): `
          + `${failed.join('; ')}. Stopped compute is recorded and Resume will restart it; the rest is still running.`,
        error: failed.join('; '),
      };
    }
    return { ok: true, detail: `Stopped ${stopped.length} compute resource(s) in workspace ${resource.name} (${stopped.join(', ')}); read-back confirmed.` };
  };

  const resumeDatabricks = async (entry: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const version = apiVersion('microsoft.databricks/workspaces');
    const children = entry.children;
    if (!children || children.length === 0) {
      return {
        ok: false,
        detail: `The snapshot records no running compute for workspace ${entry.name}, so there is nothing Loom can restore. Start the warehouses/clusters you need by hand.`,
        error: 'dbx-no-recorded-children',
      };
    }
    const dbx = await import('@/lib/azure/databricks-estate-client');
    const host = await dbxHostFor(entry.resourceId, version);
    const failed: string[] = [];
    const started: string[] = [];
    for (const c of children) {
      try {
        const cls = dbxStateClass((await getChild(host, c)).state);
        if (cls !== 'running' && cls !== 'starting') {
          if (c.kind === 'sql-warehouse') await dbx.startWarehouse(host, c.id);
          else await dbx.startCluster(host, c.id);
        }
        const after = dbxStateClass((await getChild(host, c)).state);
        if (after === 'running' || after === 'starting') started.push(c.name);
        else failed.push(`${c.kind} ${c.name}: read-back reports '${after}' after the start`);
      } catch (err) {
        failed.push(`${c.kind} ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length > 0) {
      return {
        ok: false,
        detail: `Resume of workspace ${entry.name} was only partly applied (${started.length} started, ${failed.length} not): ${failed.join('; ')}.`,
        error: failed.join('; '),
      };
    }
    return { ok: true, detail: `Started ${started.length} compute resource(s) in workspace ${entry.name} (${started.join(', ')}); read-back confirmed.` };
  };

  /**
   * Read a Container App's replica range AND its live replica count. The count
   * comes from the revisions list; if that cannot be read, the whole read fails
   * (reading: null, via the caller's catch) rather than guessing 0 replicas and
   * calling a busy app Paused.
   */
  const readContainerAppPower = async (resourceId: string, version: string): Promise<PowerRead> => {
    const app = await stateGet<AcaBody>(`${resourceId}?api-version=${version}`);
    const revs = await stateGet<{ value?: Array<{ properties?: { active?: boolean; replicas?: number } }> }>(
      `${resourceId}/revisions?api-version=${version}`,
    );
    const live = (revs?.value ?? []).reduce(
      (n, r) => n + (typeof r?.properties?.replicas === 'number' ? r.properties.replicas : 0),
      0,
    );
    const min = app?.properties?.template?.scale?.minReplicas;
    const max = app?.properties?.template?.scale?.maxReplicas;
    return {
      reading: armPowerReading({
        resourceId,
        powerState: normalizePowerState('microsoft.app/containerapps', acaPowerWord(min, live)),
        armApiVersion: version,
      }),
      scale: {
        ...(typeof min === 'number' ? { minReplicas: min } : {}),
        ...(typeof max === 'number' ? { maxReplicas: max } : {}),
      },
      replicaCount: live,
    };
  };

  /** PATCH template.scale on the VERIFIED id only; both bounds are always sent. */
  const patchAcaScale = (resourceId: string, version: string, minReplicas: number, maxReplicas: number) =>
    armPatch(`${resourceId}?api-version=${version}`, {
      properties: { template: { scale: { minReplicas, maxReplicas } } },
    });

  const readAcaScale = async (resourceId: string, version: string) => {
    const app = await armGet<AcaBody>(`${resourceId}?api-version=${version}`);
    return app?.properties?.template?.scale ?? {};
  };

  /** Container App pause: record-free here (the snapshot already holds the range). */
  const pauseContainerApp = async (resource: { resourceId: string; name: string }): Promise<ActuatorResult> => {
    const version = apiVersion('microsoft.app/containerapps');
    // Defence in depth: the orchestrator already guarded this app, but the
    // actuator is the last line before the mutation, so it re-checks with a
    // fresh tag read and its own process identity. Unknown => refuse.
    const guard = containerAppPauseGuard(
      { name: resource.name, tags: await readTags(resource.resourceId) },
      process.env.CONTAINER_APP_NAME,
    );
    if (!guard.eligible) {
      return { ok: false, detail: guard.reason, error: 'aca-console-guard' };
    }
    const current = await readAcaScale(resource.resourceId, version);
    const max = current.maxReplicas;
    if (current.minReplicas === 0) {
      // Already 0: nothing to change and nothing to invent. Resume will not touch it
      // because its recorded pre-pause state is not Online.
      return {
        ok: true,
        noop: true,
        detail: `Container App ${resource.name} already has minReplicas 0; nothing was changed and no saving is claimed.`,
      };
    }
    if (typeof current.minReplicas !== 'number' || typeof max !== 'number') {
      return {
        ok: false,
        detail: `Container App ${resource.name} did not report both minReplicas and maxReplicas, so its range could not be preserved. Left RUNNING.`,
        error: 'aca-scale-unreadable',
      };
    }
    await patchAcaScale(resource.resourceId, version, 0, max);
    const after = await readAcaScale(resource.resourceId, version);
    if (after.minReplicas !== 0) {
      return {
        ok: false,
        detail: `ARM accepted the scale-to-zero of ${resource.name} but a read-back reports minReplicas ${String(after.minReplicas)}, not 0.`,
        error: `aca-readback-mismatch:min=${String(after.minReplicas)}`,
      };
    }
    return { ok: true, detail: `Container App ${resource.name} scaled to minReplicas 0 (was ${current.minReplicas}/${max}); read-back confirmed.` };
  };

  const resumeContainerApp = async (entry: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const version = apiVersion('microsoft.app/containerapps');
    const min = entry.scale?.minReplicas;
    const max = entry.scale?.maxReplicas;
    if (typeof min !== 'number' || typeof max !== 'number') {
      return {
        ok: false,
        detail:
          `The snapshot has no recorded replica range for Container App ${entry.name}, so Loom will not invent one. `
          + 'Set minReplicas/maxReplicas on the app by hand (Container Apps > Scale and replicas).',
        error: 'aca-no-recorded-scale',
      };
    }
    const current = await readAcaScale(entry.resourceId, version);
    if (current.minReplicas !== min || current.maxReplicas !== max) {
      await patchAcaScale(entry.resourceId, version, min, max);
    }
    const after = await readAcaScale(entry.resourceId, version);
    if (after.minReplicas !== min || after.maxReplicas !== max) {
      return {
        ok: false,
        detail:
          `A read-back of ${entry.name} reports ${String(after.minReplicas)}/${String(after.maxReplicas)} but the recorded `
          + `range is ${min}/${max}. It was NOT restored.`,
        error: `aca-readback-mismatch:${String(after.minReplicas)}/${String(after.maxReplicas)}`,
      };
    }
    return { ok: true, detail: `Container App ${entry.name} restored to minReplicas ${min} / maxReplicas ${max}; read-back confirmed.` };
  };

  const pause = async (candidate: PauseCandidate, entry?: PausedResourceSnapshot): Promise<ActuatorResult> => {
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
        case 'microsoft.compute/virtualmachines': {
          // Deallocate (not power-off): releases compute billing. Idempotent in ARM.
          await armPost(`${resource.resourceId}/deallocate?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the deallocation of VM ${resource.name}.` };
        }
        case 'microsoft.containerservice/managedclusters': {
          await armPost(`${resource.resourceId}/stop?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the stop of AKS cluster ${resource.name}.` };
        }
        case 'microsoft.app/containerapps':
          return await pauseContainerApp(resource);
        case 'microsoft.databricks/workspaces':
          return await pauseDatabricks(resource, entry);
        case 'microsoft.streamanalytics/streamingjobs': {
          await armPost(`${resource.resourceId}/stop?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the stop of Stream Analytics job ${resource.name}.` };
        }
        case 'microsoft.web/sites': {
          // A site on a Consumption (Dynamic, e.g. Y1) plan bills $0 at idle, so
          // stopping it saves nothing and only disables its triggers. That is a
          // disclosed no-op, never a fabricated saving. If the plan cannot be
          // read, fail SAFE: refuse rather than guess.
          const site = await armGet<{ properties?: { serverFarmId?: string } }>(
            `${resource.resourceId}?api-version=${apiVersion(type)}`,
          );
          const farmId = String(site?.properties?.serverFarmId ?? '');
          if (!farmId.startsWith('/subscriptions/')) {
            return {
              ok: false,
              detail: `The hosting plan of ${resource.name} could not be established, so whether stopping it saves anything is unknown. Left RUNNING.`,
              error: 'web-plan-unreadable',
            };
          }
          const plan = await armGet<{ sku?: { name?: string; tier?: string } }>(
            `${farmId}?api-version=${apiVersion(type)}`,
          );
          const tier = String(plan?.sku?.tier ?? '').toLowerCase();
          const skuName = String(plan?.sku?.name ?? '').toLowerCase();
          if (tier === 'dynamic' || skuName === 'y1') {
            return {
              ok: true,
              noop: true,
              detail: `${resource.name} runs on a Consumption plan (${plan?.sku?.name ?? 'Dynamic'}) that bills $0 at idle; it was NOT stopped and no saving is claimed.`,
            };
          }
          await armPost(`${resource.resourceId}/stop?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the stop of web app ${resource.name}.` };
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
        case 'microsoft.compute/virtualmachines': {
          await armPost(`${entry.resourceId}/start?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the start of VM ${entry.name}.` };
        }
        case 'microsoft.containerservice/managedclusters': {
          await armPost(`${entry.resourceId}/start?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the start of AKS cluster ${entry.name}.` };
        }
        case 'microsoft.app/containerapps':
          return await resumeContainerApp(entry);
        case 'microsoft.databricks/workspaces':
          return await resumeDatabricks(entry);
        case 'microsoft.streamanalytics/streamingjobs': {
          // Resume where the job left off rather than re-reading from JobStartTime.
          await armPost(`${entry.resourceId}/start?api-version=${apiVersion(type)}`, {
            outputStartMode: 'LastOutputEventTime',
          });
          return { ok: true, detail: `ARM accepted the start of Stream Analytics job ${entry.name} (LastOutputEventTime).` };
        }
        case 'microsoft.web/sites': {
          await armPost(`${entry.resourceId}/start?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the start of web app ${entry.name}.` };
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
          const cluster = await stateGet<{ properties?: { uri?: string } }>(
            `${entry.resourceId}?api-version=${version}`,
          );
          const clusterUri = String(cluster?.properties?.uri ?? '').trim();
          if (!clusterUri) {
            return unprobed(entry, 'ARM did not report a query endpoint (properties.uri) for it');
          }
          // A database to run `print` in, derived from the cluster we verified.
          // ARM names a child database `{clusterName}/{databaseName}`.
          const dbs = await stateGet<{ value?: Array<{ name?: string }> }>(
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
          // ARM has no documented databases-list child for AAS. Resolve the
          // connection URI from this exact server, then ask the supported XMLA
          // client for catalog discovery (not a model query or refresh).
          const serverName = armIdSegment(entry.resourceId, 'servers');
          if (!serverName) return unprobed(entry, 'its resource id does not name an AAS server');
          let server;
          try {
            server = await stateGet<{ properties?: { serverFullName?: string } }>(
              `${entry.resourceId}?api-version=${apiVersion(type)}`,
            );
          } catch (metaErr) {
            // A throttle is rethrown so the outer catch flags it `throttled`:
            // the AAS metadata read is exactly the read the 2026-10-20 429 hit.
            if (isThrottleError(metaErr)) throw metaErr;
            return unprobed(entry, 'AAS readiness is unverified: its ARM connection metadata could not be read');
          }
          const serverUri = server.properties?.serverFullName;
          if (!serverUri) return unprobed(entry, 'AAS readiness is unverified: ARM returned no serverFullName');
          const { probeAasServer } = await import('@/lib/azure/aas-readiness');
          return probeAasServer(serverUri, serverName);
        }
        case 'microsoft.compute/virtualmachines': {
          // Running per instanceView AND, when the guest agent reports, Ready.
          const vm = await stateGet<{
            properties?: { instanceView?: { statuses?: Array<{ code?: string }>; vmAgent?: { statuses?: Array<{ displayStatus?: string }> } } };
          }>(`${entry.resourceId}?api-version=${apiVersion(type)}&$expand=instanceView`);
          const view = vm?.properties?.instanceView;
          const code = (view?.statuses ?? []).map((st) => String(st?.code ?? '')).find((c) => c.toLowerCase().startsWith('powerstate/'));
          if (normalizePowerState(type, code) !== 'Online') {
            return { servable: false, probed: true, detail: `${entry.name} reports power state ${code ?? 'unreported'}, not running.` };
          }
          const agent = view?.vmAgent?.statuses?.[0]?.displayStatus;
          if (agent && agent.toLowerCase() !== 'ready') {
            return { servable: false, probed: true, detail: `${entry.name} is running but its guest agent reports '${agent}', not Ready.` };
          }
          return {
            servable: true,
            probed: true,
            detail: agent
              ? `${entry.name} is running and its guest agent reports Ready.`
              : `${entry.name} is running; no guest agent status was reported, so this is control-plane evidence only.`,
          };
        }
        case 'microsoft.containerservice/managedclusters': {
          const aks = await stateGet<{ properties?: { provisioningState?: string; powerState?: { code?: string } } }>(
            `${entry.resourceId}?api-version=${apiVersion(type)}`,
          );
          const prov = String(aks?.properties?.provisioningState ?? '');
          const ok = prov.toLowerCase() === 'succeeded' && normalizePowerState(type, aks?.properties?.powerState?.code) === 'Online';
          return {
            servable: ok,
            probed: true,
            detail: ok
              ? `${entry.name} reports provisioningState Succeeded and powerState Running (control-plane evidence; no kubeconfig round-trip was made).`
              : `${entry.name} reports provisioningState '${prov}' and powerState '${String(aks?.properties?.powerState?.code ?? '')}'.`,
          };
        }
        case 'microsoft.app/containerapps': {
          const read = await readContainerAppPower(entry.resourceId, apiVersion(type));
          const app = await stateGet<AcaBody>(`${entry.resourceId}?api-version=${apiVersion(type)}`);
          const prov = String(app?.properties?.provisioningState ?? '');
          const restored =
            read.scale?.minReplicas === entry.scale?.minReplicas && read.scale?.maxReplicas === entry.scale?.maxReplicas;
          const ok = prov.toLowerCase() === 'succeeded' && restored && read.reading?.powerState === 'Online';
          return {
            servable: ok,
            probed: true,
            detail: ok
              ? `${entry.name} is Succeeded with its recorded replica range restored (control-plane evidence).`
              : `${entry.name} reports provisioningState '${prov}', range ${String(read.scale?.minReplicas)}/${String(read.scale?.maxReplicas)} vs recorded ${String(entry.scale?.minReplicas)}/${String(entry.scale?.maxReplicas)}.`,
          };
        }
        case 'microsoft.databricks/workspaces': {
          const children = entry.children ?? [];
          if (children.length === 0) return unprobed(entry, 'the snapshot records no compute to check');
          const host = await dbxHostFor(entry.resourceId, apiVersion(type));
          const notRunning: string[] = [];
          const drift: string[] = [];
          for (const c of children) {
            const now = await getChild(host, c);
            if (dbxStateClass(now.state) !== 'running') notRunning.push(`${c.name} (${now.state || 'unreported'})`);
            else if (typeof c.autoStopMins === 'number' && now.autoStopMins !== c.autoStopMins) {
              drift.push(`${c.name} auto-stop ${String(now.autoStopMins)} vs recorded ${c.autoStopMins}`);
            }
          }
          const ok = notRunning.length === 0;
          return {
            servable: ok,
            probed: true,
            detail: ok
              ? `All ${children.length} recorded compute resource(s) in ${entry.name} are RUNNING`
                + (drift.length ? `; configuration drift noticed (not caused by Loom): ${drift.join('; ')}.` : '.')
              : `Not yet RUNNING in ${entry.name}: ${notRunning.join(', ')}.`,
          };
        }
        case 'microsoft.streamanalytics/streamingjobs': {
          const job = await stateGet<{ properties?: { jobState?: string } }>(`${entry.resourceId}?api-version=${apiVersion(type)}`);
          const ok = normalizePowerState(type, job?.properties?.jobState) === 'Online';
          return {
            servable: ok,
            probed: true,
            detail: `${entry.name} jobState is '${String(job?.properties?.jobState ?? '')}' (control-plane evidence; output flow was not measured).`,
          };
        }
        case 'microsoft.web/sites': {
          const site = await stateGet<{ properties?: { state?: string; availabilityState?: string } }>(
            `${entry.resourceId}?api-version=${apiVersion(type)}`,
          );
          const availability = String(site?.properties?.availabilityState ?? '');
          const ok = normalizePowerState(type, site?.properties?.state) === 'Online' && availability.toLowerCase() !== 'limited';
          return {
            servable: ok,
            probed: true,
            detail: `${entry.name} state '${String(site?.properties?.state ?? '')}', availabilityState '${availability || 'unreported'}' (control-plane evidence; no HTTP request was made).`,
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
      return {
        servable: false,
        probed: true,
        detail: `${entry.name} did not answer a probe request: ${message}`,
        ...(isThrottleError(err) ? { throttled: true } : {}),
      };
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
