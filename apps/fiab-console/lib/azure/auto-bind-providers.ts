/**
 * AUTO-BIND PROVIDERS — the concrete Azure backings, one per Loom item family.
 *
 * Each provider teaches the engine (`./auto-bind`) four service-specific things
 * and nothing else:
 *
 *   backingNameFor  the deterministic name (delegated to `./backing-name`)
 *   preflight       can we reach the service, and at what coordinates
 *   probe           does an object of this name exist  (MUST NOT create)
 *   create          make it                            (only when probe said no)
 *
 * Idempotency, self-heal, drift detection and outcome classification are the
 * ENGINE's job. A provider that implements the four hooks correctly gets all of
 * those for free and cannot get them wrong — which is the whole point of the
 * seam, given that the five pre-existing per-item provisioners each re-derived
 * this logic (and its naming) independently.
 *
 * PREFLIGHT DISCIPLINE (auto-bind-by-default §5 — "Infra prerequisites are
 * DEPLOYED, not requested"). A provider must NOT report `unavailable` for a
 * value the platform could have discovered. The ADF provider is the worked
 * example: when `LOOM_ADF_NAME` is unset it does NOT gate — it queries Azure
 * Resource Graph for a factory the identity can already see (bicep deploys one
 * in every real estate; only the env plumbing was missing). `unavailable` is
 * reserved for facts a retry and a lookup genuinely cannot change: no resource
 * of that kind exists anywhere the identity can read, or the identity is denied.
 *
 * ---------------------------------------------------------------------------
 * COVERAGE — the honest table
 * ---------------------------------------------------------------------------
 * COVERED here:
 *   data-pipeline / adf-pipeline     → ADF pipeline           (adf-client)
 *   data-pipeline / synapse-pipeline → Synapse pipeline       (synapse-dev-client)
 *   eventstream                      → Event Hubs entity      (eventhubs-client)
 *   eventhouse / kql-database        → ADX database           (kusto-client)
 *   lakehouse                        → ADLS Delta root        (adls-client)
 *
 * NOT covered, deliberately, with the reason:
 *   warehouse  — the Azure-native backing is a Synapse DEDICATED SQL pool.
 *                Creating one is a multi-minute ARM provision that bills from
 *                the moment it exists, so it falls squarely in the rule's
 *                "cost-material opt-in" carve-out. Today every warehouse item
 *                shares the one pool named by `LOOM_SYNAPSE_DEDICATED_POOL`,
 *                and the warehouse provisioner creates no per-item object at
 *                all — so there is no name to bind. Binding a warehouse to a
 *                per-item SCHEMA in the shared pool is the right design and is
 *                a separate change.
 *   notebook   — the backing is a Synapse/Databricks notebook ARTIFACT whose
 *                creation requires the notebook CONTENT (cells, language,
 *                attached pool). An empty artifact created at item-create time
 *                would be overwritten by the first save, so the binding is
 *                correctly established at save, not at open. Its editor already
 *                opens on the real surface, so it is not a #2942-class dead end.
 *
 * Server-only.
 */
import {
  EVENT_HUB_NAME_RULES,
  sanitizeBackingName,
  safePipelineName,
  safeAdxDatabaseName,
  safeAdlsRelPath,
  lakehouseRootPath,
} from './backing-name';
import { DEFAULT_PIPELINE_RUNTIME } from '@/lib/components/pipeline/types';
import type { AutoBindContext, AutoBindPreflight, AutoBindProvider } from './auto-bind';

/** Read a string off the item's state bag. */
function stateString(ctx: AutoBindContext, key: string): string | null {
  const v = ctx.state?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Attach an HTTP status to a thrown error so the engine can classify it. */
function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** True when an ARM/data-plane throw means "no such object" rather than a fault. */
function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number; statusCode?: number })?.status
    ?? (e as { statusCode?: number })?.statusCode;
  if (status === 404) return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes(' 404') || msg.includes('notfound') || msg.includes('not found');
}

// ===========================================================================
// data-pipeline → Azure Data Factory pipeline   (the #2942 headline)
// ===========================================================================

/**
 * Which pipeline backend a `data-pipeline` item uses.
 *
 * The route slug decides when there is one: an item opened through
 * `/api/items/adf-pipeline/…` is on ADF, through `/api/items/synapse-pipeline/…`
 * on Synapse. That is the OPEN path.
 *
 * The CREATE path has no slug, and getting its default wrong is not cosmetic —
 * it creates the backing object in a service the editor never calls, leaving the
 * user on an empty canvas while a stray pipeline sits in the other backend. A
 * `data-pipeline` item opens `DataPipelineEditor`, which starts on
 * `DEFAULT_PIPELINE_RUNTIME` and delegates to `AdfPipelineEditor` /
 * `SynapsePipelineEditor` accordingly — so the create-time default is READ FROM
 * THAT CONSTANT rather than restated here, and the two cannot drift.
 *
 * `LOOM_PIPELINE_BACKEND` still overrides, with one exception: the value
 * `'fabric'` (legal for the INSTALL path, `provisioning-engine.resolveTarget`)
 * never selects a Fabric backing here. Per `no-fabric-dependency.md` the
 * Azure-native path is the default and Fabric is opt-in per item, so a
 * tenant-wide `fabric` setting falls through to the Azure-native default.
 */
function pipelineBackend(ctx: AutoBindContext): 'adf' | 'synapse' {
  if (ctx.slugHint === 'adf-pipeline' || ctx.itemType === 'adf-pipeline') return 'adf';
  if (ctx.slugHint === 'synapse-pipeline' || ctx.itemType === 'synapse-pipeline') return 'synapse';
  const env = process.env.LOOM_PIPELINE_BACKEND;
  if (env === 'adf' || env === 'synapse') return env;
  return DEFAULT_PIPELINE_RUNTIME === 'synapse' ? 'synapse' : 'adf';
}

export const adfPipelineAutoBind: AutoBindProvider = {
  provider: 'adf-pipeline',
  itemTypes: ['data-pipeline', 'adf-pipeline'],

  claims: (ctx) => pipelineBackend(ctx) === 'adf',

  // EXACTLY the call `lib/install/provisioners/adf-pipeline.ts` makes —
  // fallback string included — so attach-if-exists finds the installer's
  // pipeline instead of creating a duplicate.
  backingNameFor: (ctx) => {
    const name = safePipelineName(ctx.displayName, 'loom-adf-pipeline');
    return { name, sanitized: name !== ctx.displayName };
  },

  /**
   * Resolve the factory to bind against, in the order that avoids ever asking
   * the user for something the platform can find:
   *
   *   1. A factory the item is ALREADY pinned to (`state.factory*`) — a
   *      previously bound item keeps its factory across renames and redeploys.
   *   2. The env-pinned default (`LOOM_ADF_NAME` + sub + rg) when configured.
   *   3. DISCOVERY — the first factory Resource Graph can see for this
   *      identity. Bicep deploys one; this finds it when the env plumbing is
   *      missing, instead of gating on `LOOM_ADF_NAME`.
   *
   * Only when all three come up empty is this genuinely `unavailable`, and then
   * the reason names the real remediation (deploy/grant), not an env var the
   * deploy should have set.
   */
  preflight: async (ctx): Promise<AutoBindPreflight> => {
    const pinnedName = stateString(ctx, 'factory');
    const pinnedSub = stateString(ctx, 'factorySubscriptionId');
    const pinnedRg = stateString(ctx, 'factoryResourceGroup');
    if (pinnedName && pinnedSub && pinnedRg) {
      return { ok: true, coords: { factoryName: pinnedName, subscriptionId: pinnedSub, resourceGroup: pinnedRg } };
    }

    const { adfConfigGate, resolveFactoryCoords } = await import('./adf-client');
    if (!adfConfigGate()) {
      const c = resolveFactoryCoords();
      return {
        ok: true,
        coords: { factoryName: c.factoryName, subscriptionId: c.subscriptionId, resourceGroup: c.resourceGroup },
      };
    }

    const { discoverFirstResourceOfType } = await import('./resource-graph-coords');
    const found = await discoverFirstResourceOfType({ resourceType: 'Microsoft.DataFactory/factories' });
    if (found) {
      return {
        ok: true,
        coords: { factoryName: found.name, subscriptionId: found.subscriptionId, resourceGroup: found.resourceGroup },
      };
    }
    return {
      ok: false,
      kind: 'unavailable',
      reason:
        'No Azure Data Factory is visible to the Loom identity in any subscription it can read. '
        + 'Deploy one with platform/fiab/bicep/modules/landing-zone/adf.bicep, or grant the Console '
        + 'managed identity Reader on the subscription that already holds one.',
      missing: 'Microsoft.DataFactory/factories',
    };
  },

  probe: async (name, coords) => {
    const { getPipeline } = await import('./adf-client');
    const { withFactoryOverride } = await import('./adf-factory-context');
    try {
      await withFactoryOverride(
        { factoryName: coords.factoryName, subscriptionId: coords.subscriptionId, resourceGroup: coords.resourceGroup },
        () => getPipeline(name),
      );
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  },

  create: async (name, coords) => {
    const { upsertPipeline } = await import('./adf-client');
    const { withFactoryOverride } = await import('./adf-factory-context');
    await withFactoryOverride(
      { factoryName: coords.factoryName, subscriptionId: coords.subscriptionId, resourceGroup: coords.resourceGroup },
      // An EMPTY pipeline: the canvas opens on it immediately and the user
      // authors activities there. Seeding activities would fight the editor.
      () => upsertPipeline(name, { name, properties: { activities: [] } }),
    );
  },

  /**
   * The keys `resolveBinding` (lib/azure/pipeline-binding.ts) already reads, so
   * every existing per-item route — GET/PUT/run/runs/debug/validate/triggers/
   * copilot — resolves an auto-bound item with no change whatsoever.
   */
  stateKeys: (name, coords) => ({
    pipelineName: name,
    factory: coords.factoryName,
    factorySubscriptionId: coords.subscriptionId,
    factoryResourceGroup: coords.resourceGroup,
  }),

  /** Adopt a pre-existing hand-bound / installer-provisioned pipeline. */
  existingBinding: (ctx) => stateString(ctx, 'pipelineName') || stateString(ctx, 'adfPipelineName'),
};

// ===========================================================================
// data-pipeline → Synapse pipeline (the no-fabric-dependency DEFAULT backend)
// ===========================================================================

export const synapsePipelineAutoBind: AutoBindProvider = {
  provider: 'synapse-pipeline',
  itemTypes: ['data-pipeline', 'synapse-pipeline'],

  claims: (ctx) => pipelineBackend(ctx) === 'synapse',

  // EXACTLY the call `lib/install/provisioners/synapse-pipeline.ts` makes.
  backingNameFor: (ctx) => {
    const name = safePipelineName(ctx.displayName, 'loom-synapse-pipeline');
    return { name, sanitized: name !== ctx.displayName };
  },

  /**
   * Synapse has no discovery fallback equivalent to ADF's: the dev-plane host
   * is derived from the workspace NAME, and picking an arbitrary workspace out
   * of the estate would silently write pipelines into someone else's analytics
   * workspace. So an unset `LOOM_SYNAPSE_WORKSPACE` is a real gate — but note
   * it is only reachable when the item is explicitly on the Synapse backend;
   * the ADF path above never needs it.
   */
  preflight: async (): Promise<AutoBindPreflight> => {
    const { synapseConfigGate } = await import('./synapse-dev-client');
    const gate = synapseConfigGate();
    if (gate) {
      return {
        ok: false,
        kind: 'unavailable',
        reason:
          `The Synapse workspace this pipeline backend targets is not wired into the Console (${gate.missing}). `
          + 'Deploy it with platform/fiab/bicep/modules/data/synapse.bicep, or switch this item to the '
          + 'Azure Data Factory backend, which the platform can discover automatically.',
        missing: gate.missing,
      };
    }
    return { ok: true, coords: { workspace: process.env.LOOM_SYNAPSE_WORKSPACE || '' } };
  },

  probe: async (name) => {
    const { getPipeline } = await import('./synapse-dev-client');
    try {
      await getPipeline(name);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  },

  create: async (name) => {
    const { upsertPipeline } = await import('./synapse-dev-client');
    await upsertPipeline(name, { name, properties: { activities: [] } } as never);
  },

  stateKeys: (name, coords) => ({
    pipelineName: name,
    ...(coords.workspace ? { workspace: coords.workspace } : {}),
  }),

  existingBinding: (ctx) => stateString(ctx, 'pipelineName'),
};

// ===========================================================================
// eventstream → Event Hubs entity
// ===========================================================================

export const eventstreamAutoBind: AutoBindProvider = {
  provider: 'eventstream',
  itemTypes: ['eventstream'],

  backingNameFor: (ctx) => {
    const r = sanitizeBackingName(ctx.displayName, EVENT_HUB_NAME_RULES);
    return { name: r.name, sanitized: r.sanitized };
  },

  preflight: async (): Promise<AutoBindPreflight> => {
    const { eventhubsConfigGate, readEventHubsConfig } = await import('./eventhubs-client');
    const gate = eventhubsConfigGate();
    if (gate) {
      return {
        ok: false,
        kind: 'unavailable',
        reason:
          `The Event Hubs namespace that backs eventstreams is not wired into the Console (${gate.missing}). `
          + 'Deploy it with platform/fiab/bicep/modules/streaming/eventhubs.bicep.',
        missing: gate.missing,
      };
    }
    const cfg = readEventHubsConfig();
    return {
      ok: true,
      coords: { namespace: cfg.namespace, subscriptionId: cfg.subscriptionId, resourceGroup: cfg.resourceGroup },
    };
  },

  probe: async (name, coords) => {
    const { listEventHubsIn } = await import('./eventhubs-client');
    const hubs = await listEventHubsIn({
      namespace: coords.namespace,
      subscriptionId: coords.subscriptionId,
      resourceGroup: coords.resourceGroup,
    });
    return hubs.some((h) => h.name.toLowerCase() === name.toLowerCase());
  },

  create: async (name, coords) => {
    const { ensureEventHub } = await import('./eventhubs-client');
    await ensureEventHub(
      { namespace: coords.namespace, subscriptionId: coords.subscriptionId, resourceGroup: coords.resourceGroup },
      { name },
    );
  },

  /** The keys the eventstream editor already reads to decide live-vs-draft. */
  stateKeys: (name, coords) => ({
    transportHub: name,
    eventHubNamespace: coords.namespace,
  }),

  existingBinding: (ctx) => stateString(ctx, 'transportHub'),
};

// ===========================================================================
// eventhouse / kql-database → Azure Data Explorer database
// ===========================================================================

export const adxDatabaseAutoBind: AutoBindProvider = {
  provider: 'adx-database',
  itemTypes: ['eventhouse', 'kql-database'],

  // EXACTLY the call `lib/install/provisioners/kql-db.ts` makes.
  backingNameFor: (ctx) => {
    const name = safeAdxDatabaseName(ctx.displayName);
    return { name, sanitized: name !== ctx.displayName };
  },

  preflight: async (): Promise<AutoBindPreflight> => {
    const { kustoConfigGate } = await import('./kusto-client');
    const gate = kustoConfigGate();
    if (gate) {
      return {
        ok: false,
        kind: 'unavailable',
        reason:
          `No Azure Data Explorer cluster is wired into the Console (${gate.missing}). `
          + 'Deploy one with platform/fiab/bicep/modules/data/adx.bicep.',
        missing: gate.missing,
      };
    }
    return { ok: true, coords: { clusterUri: process.env.LOOM_KUSTO_CLUSTER_URI || '' } };
  },

  probe: async (name) => {
    const { listDatabases } = await import('./kusto-client');
    const dbs = await listDatabases();
    return dbs.some((d) => d.name === name);
  },

  create: async (name) => {
    const { createDatabase } = await import('./kusto-client');
    const res = await createDatabase(name, { hotCacheDays: 7, softDeleteDays: 30 });
    // ARM answers 'Accepted' before the database is queryable. Surfacing that
    // as a RETRY (rather than pretending it is bound) is what makes the editor
    // show a progress state that resolves itself, instead of a canvas whose
    // first query 404s.
    if (res.provisioningState && res.provisioningState !== 'Succeeded') {
      throw statusError(`ADX database "${name}" is still provisioning (${res.provisioningState}).`, 202);
    }
  },

  stateKeys: (name, coords) => ({
    kqlDatabase: name,
    ...(coords.clusterUri ? { kustoClusterUri: coords.clusterUri } : {}),
  }),

  existingBinding: (ctx) => stateString(ctx, 'kqlDatabase') || stateString(ctx, 'database'),
};

// ===========================================================================
// lakehouse → ADLS Gen2 Delta root
// ===========================================================================

export const lakehouseAutoBind: AutoBindProvider = {
  provider: 'lakehouse-adls',
  itemTypes: ['lakehouse'],

  // EXACTLY the expression `lib/install/provisioners/lakehouse.ts` uses for its
  // root directory (`lakehouseRootPath`, itemId fallback included), so an
  // installed lakehouse is ATTACHED here rather than duplicated under a second
  // root with the user's Delta tables in the wrong one.
  backingNameFor: (ctx) => ({
    name: lakehouseRootPath(ctx.displayName, ctx.itemId),
    // Report whether the DISPLAY NAME itself had to change; the structural
    // `lakehouses/` prefix is not part of the mapping a human is inspecting.
    sanitized: safeAdlsRelPath(ctx.displayName) !== ctx.displayName,
  }),

  /**
   * Pick the container the same way the lakehouse provisioner does — the item's
   * own pinned container first, then `landing` (the raw zone, a new lakehouse's
   * natural home), then `bronze`, then whatever exists — so an auto-bound
   * lakehouse and an installer-provisioned one share a container as well as a
   * root.
   *
   * Reads the CONFIGURED container names rather than listing the account: this
   * runs on every lakehouse open, the configured set is what the provisioner's
   * listing can return anyway, and it keeps the choice deterministic.
   */
  preflight: async (ctx): Promise<AutoBindPreflight> => {
    const pinned = stateString(ctx, 'adlsContainer');
    const { configuredContainerNames } = await import('./adls-client');
    const configured = configuredContainerNames() as string[];
    if (pinned && configured.includes(pinned)) return { ok: true, coords: { container: pinned } };
    const container =
      (configured.includes('landing') && 'landing')
      || (configured.includes('bronze') && 'bronze')
      || configured[0];
    if (!container) {
      return {
        ok: false,
        kind: 'unavailable',
        reason:
          'No ADLS Gen2 container is wired into the Console, so a lakehouse has nowhere to live. '
          + 'Deploy the medallion containers with platform/fiab/bicep/modules/data/storage.bicep.',
        missing: 'LOOM_LANDING_URL (or LOOM_BRONZE_URL)',
      };
    }
    return { ok: true, coords: { container } };
  },

  probe: async (name, coords) => {
    const { getMetadata } = await import('./adls-client');
    const meta = await getMetadata(coords.container, name);
    return meta.exists;
  },

  create: async (name, coords) => {
    const { createDirectory } = await import('./adls-client');
    await createDirectory(coords.container, name);
  },

  stateKeys: (name, coords) => ({
    lakehouseRoot: name,
    adlsContainer: coords.container,
  }),

  existingBinding: (ctx) => stateString(ctx, 'lakehouseRoot'),
};

/**
 * The live registry. Order matters only for `claims()` ties; the pipeline pair
 * are mutually exclusive by construction (`pipelineBackend` returns exactly one
 * of 'adf' | 'synapse'), so exactly one ever claims a `data-pipeline`.
 */
export const AUTO_BIND_PROVIDERS: readonly AutoBindProvider[] = [
  adfPipelineAutoBind,
  synapsePipelineAutoBind,
  eventstreamAutoBind,
  adxDatabaseAutoBind,
  lakehouseAutoBind,
];
