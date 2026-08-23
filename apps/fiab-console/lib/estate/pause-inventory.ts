/**
 * ESTATE PAUSE/RESUME — the inventory resolver. THIS IS THE SAFETY-CRITICAL HALF.
 *
 * ── WHY THIS MODULE IS WRITTEN THE WAY IT IS ───────────────────────────────
 * MEASURED 2026-08-22 across the live Commercial subscriptions: of 23 pausable
 * resources, **11 are Loom's and 12 belong to 10 completely unrelated resource
 * groups** — a blog, a Sentinel dev estate, two Atlas estates, a diagnostics RG,
 * a GitHub-runner PoC, a demo sandbox, a chat app, a PoC RG, and a shared
 * AI/ML DLZ stack.
 *
 * A subscription-scoped pause would therefore take down the operator's blog, a
 * Sentinel dev estate, two Atlas estates, a NASA PoC runner and a SAP HANA
 * sandbox. That is not a hypothetical blast radius; it is the measured one.
 *
 * So the four scope rules below are implemented as EXECUTABLE CODE with tests,
 * not as guidance:
 *
 *   R-SCOPE-1  Never scope by subscription. The pause set is an EXPLICIT
 *              inventory: `buildPauseInventory` is handed a list of discovered
 *              resources and classifies each one individually. There is no
 *              "everything in sub X" code path, and `assertExplicitScope`
 *              refuses any scope descriptor that is not an explicit inventory.
 *
 *   R-SCOPE-2  Never scope by resource-group NAME pattern either. `/loom/i`
 *              over RG names fails in BOTH directions and is measurably wrong
 *              on this estate:
 *                • FALSE NEGATIVE — `rg-dlz-aiml-stack-dev` contains
 *                  `func-csa-inabox-copilot-fg`, a genuine Loom component, and
 *                  has no "loom" anywhere in its name. A name filter MISSES it.
 *                • FALSE POSITIVE — any RG whose name merely contains the
 *                  substring "loom" (a customer called Loomis, a bloom/gloom/
 *                  heirloom project) matches and would be TORN DOWN.
 *              `__tests__/pause-inventory.test.ts` encodes both directions as a
 *              regression guard. Nothing in this module reads a resource-group
 *              name to decide ownership; `resolveOwnership` does not receive
 *              one, so the mistake cannot be made by editing a regex.
 *
 *   R-SCOPE-3  Membership comes from an explicit ownership TAG (preferred) or a
 *              deploy-emitted MANIFEST, and it is RE-VERIFIED immediately before
 *              acting on each resource (`reverifyBeforeAct`). Anything not
 *              POSITIVELY identified as Loom-owned is left alone. Fail-safe here
 *              means "leave it RUNNING": the contract is copied verbatim in
 *              spirit from `.github/workflows/csa-loom-shir-idle-stop.yml`,
 *              whose rule is *never scale down on uncertainty* — on ANY query
 *              error it leaves the VMSS up and exits 0.
 *
 *   R-SCOPE-4  `dryRunPause` returns exactly what would be acted on, each row
 *              carrying its owning tag, so the UI can show the operator the real
 *              set before any confirm.
 *
 * ── DISCOVERY IS NOT STATE (PRP §3c) ───────────────────────────────────────
 * `DiscoveredResource` is the Azure Resource Graph shape and deliberately
 * carries NO usable power-state field — it declares `powerState?: never`. Power
 * state is obtained only through `pause-state.ts`'s `armPowerReading()`, which
 * requires an ARM api-version. MEASURED: the activity log recorded
 * `Microsoft.Synapse/workspaces/sqlPools/pause/action` Succeeded at 20:22:14
 * while Resource Graph went on reporting that pool `Online`. Resource Graph is
 * a replicated index — fine for "what exists", wrong for "what is running".
 *
 * The module is PURE + side-effect-free: no fetch, no Azure SDK, no ARM writes.
 * Callers inject the readers, which is what makes every rule above testable.
 */

import type { EstateFallbackSku, EstateSkuSnapshot, LoomOwnershipEvidence } from './pause-state';

// ---------------------------------------------------------------------------
// Ownership tags
// ---------------------------------------------------------------------------

/**
 * The estate ownership tag. Stamped by the deploy on every resource Loom owns;
 * its VALUE is the estate id, so two Loom estates sharing a subscription cannot
 * pause each other.
 */
export const LOOM_ESTATE_TAG_KEY = 'loom-estate-id';

/**
 * The pre-existing per-item ownership tag (`lib/azure/activator-monitor.ts`
 * exports the same string as LOOM_RULE_TAG_ITEM_ID; `lib/logic-app/auto-bind.ts`
 * stamps it).
 *
 * IT IS NOT AN OWNERSHIP SIGNAL FOR PAUSE, and deliberately confers nothing on
 * its own. PR #3897 review measured the reason: a resource carrying only
 * `loom-item-id` was claimed by estate-A AND by a completely unrelated
 * estate-B, because a Loom ITEM id does not name which ESTATE the item lives
 * in. That contradicts the invariant stated on LOOM_ESTATE_TAG_KEY, and
 * R-SCOPE-3 requires ownership be established POSITIVELY for THIS estate — an
 * ambiguous claim is not a positive one.
 *
 * So it is retained only to be NAMED in exclusion reasons, which is genuinely
 * useful: "this looks Loom-ish but carries no estate tag" is exactly what an
 * operator needs to see to go and fix the tagging.
 */
export const LOOM_ITEM_TAG_KEY = 'loom-item-id';

// ---------------------------------------------------------------------------
// Discovery — what exists. NOT what is running.
// ---------------------------------------------------------------------------

/**
 * One row from discovery (Azure Resource Graph, or a deploy-emitted manifest).
 *
 * NOTE THE ABSENT FIELD. `powerState?: never` is the type-level enforcement of
 * PRP §3c: it makes `d.powerState` typed `undefined`, so any attempt to feed a
 * discovery row into something expecting an `EstatePowerState` is a compile
 * error, and there is no assignment that could populate it. Callers that need
 * state must go and do the authoritative ARM GET.
 */
export interface DiscoveredResource {
  resourceId: string;
  /** Full ARM type. Compared case-insensitively throughout. */
  resourceType: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
  /**
   * Tags as discovery reported them. `null` means the tags could NOT be read —
   * which is `indeterminate`, not "no tags". Conflating the two is how a
   * fail-open crawls in.
   */
  tags: Readonly<Record<string, string>> | null;
  /** Why tags are null. Surfaced verbatim in the exclusion reason. */
  tagsError?: string;
  discoverySource: 'resource-graph' | 'deploy-manifest';
  /**
   * Structurally impossible to populate. Do not remove: this is what stops a
   * Resource Graph `properties.state` from being carried into the state model.
   */
  readonly powerState?: never;
}

// ---------------------------------------------------------------------------
// Build-checked type assertions
//
// These live in a SOURCE file on purpose. The equivalent `@ts-expect-error`
// guards in `__tests__/pause-inventory.test.ts` are NOT enforced by the build:
// `next.config` typechecks with `tsconfig.build.json`, which excludes
// `**/__tests__/**`. A guard the gate never runs is not a guard. These compile
// under the build config, cost nothing at runtime, and fail `next build` the
// moment the property they protect is weakened.
// ---------------------------------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

/**
 * PRP §3c — discovery must never carry a usable power state.
 *
 * Change `powerState?: never` to any real type and `IsNever<...>` becomes
 * `false`, `Assert<false>` is a compile error, and `next build` goes red here.
 */
type _DiscoveryHasNoPowerState = Assert<IsNever<NonNullable<DiscoveredResource['powerState']>>>;

/**
 * R-SCOPE-1 — `PauseScope` must stay a single-member union. If a
 * `{ kind: 'subscription' }` member is ever added, `'explicit-inventory'` stops
 * being the only `kind` and this assertion fails, so the widening cannot land as
 * a quiet type edit.
 */
type _ScopeIsExplicitOnly = Assert<PauseScope['kind'] extends 'explicit-inventory' ? true : false>;

// Reference the aliases so `noUnusedLocals`-style tooling keeps them alive.
export type EstatePauseTypeInvariants = [_DiscoveryHasNoPowerState, _ScopeIsExplicitOnly];

// ---------------------------------------------------------------------------
// Scope — R-SCOPE-1
// ---------------------------------------------------------------------------

/**
 * The ONLY legal scope. A single-member union on purpose: adding
 * `{ kind: 'subscription' }` here would be a visible, reviewable edit to a type
 * whose docstring says why it must not exist — not a quiet change to a filter.
 */
export type PauseScope = {
  kind: 'explicit-inventory';
  /** The estate whose resources may be paused. */
  estateId: string;
};

/**
 * R-SCOPE-1 — refuse any scope that is not an explicit inventory.
 *
 * The runtime check exists because scope can arrive from a request body, where
 * TypeScript guarantees nothing. `subscription`, `resource-group` and
 * `tenant` are named explicitly so the error says what was actually rejected.
 */
export function assertExplicitScope(scope: unknown): asserts scope is PauseScope {
  const s = scope as { kind?: unknown; estateId?: unknown } | null;
  if (!s || typeof s !== 'object') {
    throw new Error('Pause scope is missing. The pause set must be an explicit inventory.');
  }
  if (s.kind !== 'explicit-inventory') {
    throw new Error(
      `Pause scope kind '${String(s.kind)}' is refused. The pause set must be an explicit `
        + 'inventory of individually Loom-owned resources (R-SCOPE-1). Subscription-, '
        + 'resource-group- and tenant-wide scopes are not supported: measured 2026-08-22, a '
        + 'subscription-wide pause in this estate would have stopped 12 resources across 10 '
        + 'unrelated resource groups.',
    );
  }
  if (typeof s.estateId !== 'string' || !s.estateId) {
    throw new Error('Pause scope has no estateId; Loom ownership cannot be established without it.');
  }
}

// ---------------------------------------------------------------------------
// Pausable types — the registry, with R-CAP-1 declared fallback SKUs
// ---------------------------------------------------------------------------

export interface PausableTypeSpec {
  /** Lower-cased ARM type. */
  resourceType: string;
  label: string;
  /** How the pause is effected against ARM. */
  mechanism: 'arm-pause-action' | 'arm-stop-action' | 'scale-to-zero' | 'deallocate';
  /**
   * R-CAP-1 — true when RE-ACQUIRING this capacity on resume can fail (regional
   * capacity, quota, SKU retirement). These MUST carry a declared fallback.
   */
  capacityConstrained: boolean;
  /** R-CAP-1 — the fallback used when the original SKU is unavailable on resume. */
  fallbackSku?: EstateFallbackSku;
  /** api-version for the AUTHORITATIVE ARM power-state read on this type. */
  armApiVersion: string;
}

/**
 * The pausable types, keyed by lower-cased ARM type.
 *
 * A type that is not in this table is NOT pausable — the default is to leave a
 * resource alone, so adding a type is a deliberate, reviewable act. Every
 * `capacityConstrained: true` entry carries a `fallbackSku`; the invariant is
 * asserted in the tests, so a future addition that forgets one fails CI rather
 * than failing a resume at 3am.
 */
export const PAUSABLE_RESOURCE_TYPES: Readonly<Record<string, PausableTypeSpec>> = {
  'microsoft.synapse/workspaces/sqlpools': {
    resourceType: 'microsoft.synapse/workspaces/sqlpools',
    label: 'Synapse dedicated SQL pool',
    mechanism: 'arm-pause-action',
    capacityConstrained: true,
    fallbackSku: {
      name: 'DW100c',
      tier: 'DataWarehouse',
      capacity: 100,
      reason:
        'The original DWU was unavailable in the region on resume. DW100c is the smallest '
        + 'service level, so the warehouse comes back QUERYABLE (degraded) rather than staying '
        + 'down; scale back up from the Loom estate page once capacity frees.',
    },
    armApiVersion: '2021-06-01',
  },
  'microsoft.kusto/clusters': {
    resourceType: 'microsoft.kusto/clusters',
    label: 'Azure Data Explorer cluster',
    mechanism: 'arm-stop-action',
    capacityConstrained: true,
    fallbackSku: {
      name: 'Dev(No SLA)_Standard_E2a_v4',
      tier: 'Basic',
      capacity: 1,
      reason:
        'The original ADX SKU was unavailable in the region on resume. The dev SKU restores '
        + 'query availability with no SLA rather than leaving the eventhouse down; the original '
        + 'SKU is recorded in the snapshot for a later scale-up.',
    },
    armApiVersion: '2023-08-15',
  },
  'microsoft.analysisservices/servers': {
    resourceType: 'microsoft.analysisservices/servers',
    label: 'Azure Analysis Services server',
    mechanism: 'arm-stop-action',
    capacityConstrained: true,
    fallbackSku: {
      name: 'B1',
      tier: 'Basic',
      capacity: 1,
      reason:
        'The original AAS SKU was unavailable on resume. B1 restores the semantic layer at the '
        + 'smallest billable tier; models over the B1 memory ceiling will need the original SKU.',
    },
    armApiVersion: '2017-08-01',
  },
  'microsoft.compute/virtualmachinescalesets': {
    resourceType: 'microsoft.compute/virtualmachinescalesets',
    label: 'VM scale set (SHIR)',
    mechanism: 'scale-to-zero',
    capacityConstrained: true,
    fallbackSku: {
      name: 'Standard_D2s_v3',
      capacity: 1,
      reason:
        'The original VM size was unavailable in the region on resume. A single D2s_v3 node '
        + 'restores the self-hosted IR so pipelines run, at reduced throughput.',
    },
    armApiVersion: '2023-09-01',
  },
  'microsoft.compute/virtualmachines': {
    resourceType: 'microsoft.compute/virtualmachines',
    label: 'Virtual machine',
    mechanism: 'deallocate',
    capacityConstrained: true,
    fallbackSku: {
      name: 'Standard_D2s_v3',
      reason:
        'The original VM size was unavailable in the region on resume. D2s_v3 is broadly '
        + 'available; resize back once capacity frees.',
    },
    armApiVersion: '2023-09-01',
  },
  'microsoft.containerservice/managedclusters': {
    resourceType: 'microsoft.containerservice/managedclusters',
    label: 'AKS cluster',
    mechanism: 'arm-stop-action',
    capacityConstrained: true,
    fallbackSku: {
      name: 'Standard_D2s_v3',
      capacity: 1,
      reason:
        'The original node SKU/count was unavailable on resume. A single D2s_v3 node restores '
        + 'the control path so workloads schedule, at reduced capacity.',
    },
    armApiVersion: '2024-02-01',
  },
  'microsoft.app/containerapps': {
    resourceType: 'microsoft.app/containerapps',
    label: 'Container App',
    mechanism: 'scale-to-zero',
    // Serverless: scale-out is not a reservation, so resume does not contend
    // for capacity the way a dedicated SKU does.
    capacityConstrained: false,
    armApiVersion: '2024-03-01',
  },
  'microsoft.streamanalytics/streamingjobs': {
    resourceType: 'microsoft.streamanalytics/streamingjobs',
    label: 'Stream Analytics job',
    mechanism: 'arm-stop-action',
    capacityConstrained: false,
    armApiVersion: '2021-10-01-preview',
  },
  'microsoft.web/sites': {
    resourceType: 'microsoft.web/sites',
    label: 'Function App / App Service',
    mechanism: 'arm-stop-action',
    // Stopping a site releases compute but the hosting PLAN reservation stays,
    // so a restart does not contend for regional capacity.
    capacityConstrained: false,
    armApiVersion: '2023-12-01',
  },
};

/** The spec for an ARM type, or null when the type is not pausable. */
export function pausableTypeSpec(resourceType: string): PausableTypeSpec | null {
  return PAUSABLE_RESOURCE_TYPES[String(resourceType || '').toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Ownership resolution — R-SCOPE-2 and R-SCOPE-3
// ---------------------------------------------------------------------------

/**
 * A deploy-emitted manifest of the resource ids this estate owns. The secondary
 * membership source for resources ARM cannot tag (or that were created before
 * tagging landed). Ids are compared case-insensitively, as ARM ids are.
 */
export interface DeployManifest {
  estateId: string;
  resourceIds: readonly string[];
}

function manifestHas(manifest: DeployManifest | undefined, resourceId: string): boolean {
  if (!manifest) return false;
  const wanted = resourceId.toLowerCase();
  return manifest.resourceIds.some((id) => String(id).toLowerCase() === wanted);
}

/** Case-insensitive tag lookup — ARM tag keys are not case-sensitive. */
function tagValue(tags: Readonly<Record<string, string>>, key: string): string | undefined {
  const wanted = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/**
 * R-SCOPE-2 / R-SCOPE-3 — decide whether a resource is Loom's.
 *
 * DELIBERATELY does not receive the resource-group name in any decision path.
 * Ownership is decided ONLY by:
 *   1. the `loom-estate-id` tag matching this estate  -> loom-owned;
 *   2. the tag present but naming a DIFFERENT estate  -> not-loom-owned
 *      (another Loom deployment; not ours to stop);
 *   3. the deploy manifest listing the resource id    -> loom-owned;
 *   4. tags readable but no estate-scoped evidence    -> not-loom-owned;
 *   5. tags NOT readable                              -> indeterminate.
 *
 * (4) and (5) are both non-pausable. They are kept distinct because (5) is an
 * error the operator should see, and (4) is the ordinary, correct answer for the
 * blog / Sentinel / Atlas resources that share these subscriptions.
 *
 * NOTE: `loom-item-id` alone is NOT a membership source. It names a Loom ITEM,
 * not a Loom ESTATE, so two estates sharing a subscription would both claim the
 * same resource — measured in PR #3897 review. A resource carrying only that tag
 * is reported as not-loom-owned with a reason that names the missing estate tag,
 * so the fix (stamp `loom-estate-id`) is obvious from the dry run.
 */
export function resolveOwnership(
  resource: DiscoveredResource,
  ctx: { estateId: string; manifest?: DeployManifest },
): LoomOwnershipEvidence {
  const { estateId, manifest } = ctx;

  // (5) FAIL-SAFE. Tags could not be read -> we know nothing -> leave it alone.
  // Same contract as csa-loom-shir-idle-stop.yml: never act on uncertainty.
  if (resource.tags == null) {
    return {
      verdict: 'indeterminate',
      source: 'none',
      reason:
        `Could not read the tags of ${resource.name}`
        + `${resource.tagsError ? `: ${resource.tagsError}` : ''}. `
        + 'Loom ownership was NOT established, so the resource is left running (fail-safe).',
    };
  }

  const estateTag = tagValue(resource.tags, LOOM_ESTATE_TAG_KEY);

  // (2) Another Loom estate's resource. Positively NOT ours.
  if (estateTag && estateTag !== estateId) {
    return {
      verdict: 'not-loom-owned',
      source: 'ownership-tag',
      tagKey: LOOM_ESTATE_TAG_KEY,
      tagValue: estateTag,
      reason:
        `${resource.name} carries ${LOOM_ESTATE_TAG_KEY}='${estateTag}', which is a DIFFERENT Loom `
        + `estate from '${estateId}'. It is not this estate's to pause.`,
    };
  }

  // (1) Ours, by the estate tag. The strongest evidence.
  if (estateTag === estateId) {
    return {
      verdict: 'loom-owned',
      source: 'ownership-tag',
      tagKey: LOOM_ESTATE_TAG_KEY,
      tagValue: estateTag,
      reason: `${resource.name} carries ${LOOM_ESTATE_TAG_KEY}='${estateId}'.`,
    };
  }

  // (3) Ours, by the deploy-emitted manifest.
  if (manifest && manifest.estateId === estateId && manifestHas(manifest, resource.resourceId)) {
    return {
      verdict: 'loom-owned',
      source: 'deploy-manifest',
      reason:
        `${resource.name} is listed in the deploy manifest for estate '${estateId}' `
        + `(${manifest.resourceIds.length} resource(s)).`,
    };
  }

  // (4) Read the tags, found no ESTATE-SCOPED evidence. The correct answer for
  //     every unrelated resource sharing these subscriptions — and also for a
  //     resource carrying only `loom-item-id`, which cannot say WHICH estate.
  const itemTag = tagValue(resource.tags, LOOM_ITEM_TAG_KEY);
  return {
    verdict: 'not-loom-owned',
    source: 'none',
    reason: itemTag
      ? `${resource.name} carries ${LOOM_ITEM_TAG_KEY}='${itemTag}' but no ${LOOM_ESTATE_TAG_KEY} `
        + `tag, so it cannot be established that it belongs to estate '${estateId}' rather than `
        + 'another Loom estate in this subscription. It is left alone. Stamp '
        + `${LOOM_ESTATE_TAG_KEY} to bring it into scope.`
      : `${resource.name} carries no ${LOOM_ESTATE_TAG_KEY} tag and is not in the deploy manifest. `
        + 'Loom ownership was not positively established, so it is left alone. '
        + 'Note: its resource-group NAME is deliberately not consulted (R-SCOPE-2).',
  };
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

export interface PauseCandidate {
  resource: DiscoveredResource;
  spec: PausableTypeSpec;
  ownership: LoomOwnershipEvidence;
  /** R-CAP-1 — the declared fallback carried forward into the snapshot. */
  fallbackSku?: EstateFallbackSku;
}

export type ExclusionReasonKind =
  | 'not-loom-owned'
  | 'ownership-indeterminate'
  | 'type-not-pausable';

export interface ExcludedResource {
  resource: DiscoveredResource;
  kind: ExclusionReasonKind;
  ownership: LoomOwnershipEvidence;
  reason: string;
}

export interface PauseInventory {
  estateId: string;
  /** Exactly what would be acted on. */
  pausable: PauseCandidate[];
  /** Everything else, each with the reason it was left alone. Never dropped. */
  excluded: ExcludedResource[];
  builtAt: string;
}

/**
 * Build the pause inventory: classify EVERY discovered resource individually.
 *
 * Invariant, asserted in the tests: `pausable.length + excluded.length ===
 * discovered.length`. Nothing is silently dropped — a resource that vanishes
 * from both lists is a resource nobody reviewed.
 *
 * Ordering matters: ownership is resolved FIRST, so an unrelated resource of a
 * pausable type (the blog's Container App, the Sentinel dev VM) is excluded for
 * the honest reason "not Loom's", not the incidental one "wrong type".
 */
export function buildPauseInventory(
  discovered: readonly DiscoveredResource[],
  ctx: { scope: PauseScope; manifest?: DeployManifest; now?: string },
): PauseInventory {
  assertExplicitScope(ctx.scope);
  const estateId = ctx.scope.estateId;

  const pausable: PauseCandidate[] = [];
  const excluded: ExcludedResource[] = [];

  for (const resource of discovered) {
    const ownership = resolveOwnership(resource, { estateId, manifest: ctx.manifest });

    // R-SCOPE-3: anything not POSITIVELY identified as Loom-owned is left alone.
    if (ownership.verdict !== 'loom-owned') {
      excluded.push({
        resource,
        kind: ownership.verdict === 'indeterminate' ? 'ownership-indeterminate' : 'not-loom-owned',
        ownership,
        reason: ownership.reason,
      });
      continue;
    }

    const spec = pausableTypeSpec(resource.resourceType);
    if (!spec) {
      excluded.push({
        resource,
        kind: 'type-not-pausable',
        ownership,
        reason:
          `${resource.name} is Loom-owned but its type ${resource.resourceType} has no pause `
          + 'mechanism registered in PAUSABLE_RESOURCE_TYPES, so it is left running.',
      });
      continue;
    }

    pausable.push({
      resource,
      spec,
      ownership,
      ...(spec.fallbackSku ? { fallbackSku: spec.fallbackSku } : {}),
    });
  }

  return {
    estateId,
    pausable,
    excluded,
    builtAt: ctx.now ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// R-SCOPE-4 — the dry run
// ---------------------------------------------------------------------------

export interface DryRunRow {
  resourceId: string;
  name: string;
  resourceType: string;
  resourceGroup: string;
  subscriptionId: string;
  /** How the pause would be effected. */
  mechanism: PausableTypeSpec['mechanism'];
  /** The owning tag that put this row in the list — shown in the UI. */
  owningTagKey?: string;
  owningTagValue?: string;
  ownershipSource: LoomOwnershipEvidence['source'];
  ownershipReason: string;
  /** R-CAP-1 — what resume would fall back to if the SKU is unavailable. */
  fallbackSku?: EstateFallbackSku;
}

export interface DryRunResult {
  estateId: string;
  /** Exactly the resources that would be acted on. */
  wouldPause: DryRunRow[];
  /** Everything examined and left alone, with the reason. */
  wouldLeaveRunning: Array<{
    resourceId: string;
    name: string;
    resourceGroup: string;
    resourceType: string;
    kind: ExclusionReasonKind;
    reason: string;
  }>;
  summary: string;
}

/**
 * R-SCOPE-4 — exactly what a pause would act on, each row with its owning tag.
 *
 * This is what the UI renders BEFORE any confirm. It performs no Azure call and
 * changes nothing; it is a projection of the inventory.
 */
export function dryRunPause(inventory: PauseInventory): DryRunResult {
  const wouldPause: DryRunRow[] = inventory.pausable.map((c) => ({
    resourceId: c.resource.resourceId,
    name: c.resource.name,
    resourceType: c.resource.resourceType,
    resourceGroup: c.resource.resourceGroup,
    subscriptionId: c.resource.subscriptionId,
    mechanism: c.spec.mechanism,
    ...(c.ownership.tagKey ? { owningTagKey: c.ownership.tagKey } : {}),
    ...(c.ownership.tagValue ? { owningTagValue: c.ownership.tagValue } : {}),
    ownershipSource: c.ownership.source,
    ownershipReason: c.ownership.reason,
    ...(c.fallbackSku ? { fallbackSku: c.fallbackSku } : {}),
  }));

  const wouldLeaveRunning = inventory.excluded.map((e) => ({
    resourceId: e.resource.resourceId,
    name: e.resource.name,
    resourceGroup: e.resource.resourceGroup,
    resourceType: e.resource.resourceType,
    kind: e.kind,
    reason: e.reason,
  }));

  const rgs = new Set(wouldLeaveRunning.map((r) => r.resourceGroup));
  return {
    estateId: inventory.estateId,
    wouldPause,
    wouldLeaveRunning,
    summary:
      `Would pause ${wouldPause.length} Loom-owned resource(s) in estate '${inventory.estateId}'. `
      + `${wouldLeaveRunning.length} resource(s) across ${rgs.size} resource group(s) are left `
      + 'running because Loom ownership was not positively established.',
  };
}

// ---------------------------------------------------------------------------
// R-SCOPE-3 — re-verify immediately before acting
// ---------------------------------------------------------------------------

export interface ReverifyResult {
  proceed: boolean;
  reason: string;
  ownership: LoomOwnershipEvidence;
}

/**
 * R-SCOPE-3 — re-verify membership IMMEDIATELY BEFORE acting on one resource.
 *
 * The inventory may be minutes old by the time the executor reaches a given
 * resource: a tag can be removed, a resource re-created with the same id under
 * different ownership, or the estate re-tagged mid-run. So the tags are read
 * again, from the caller-injected reader, and the ownership decision is REDONE.
 *
 * ── WHY THE MANIFEST IS RE-READ TOO, NOT PASSED IN (#3897 review) ──────────
 * The first version took the ORIGINAL `manifest` in `ctx` and reused it. That
 * made re-verification partial and silently defeatable: measured,
 *
 *     tags removed + stale manifest -> proceed=true,  source=deploy-manifest
 *     tags removed, no manifest     -> proceed=false                (control)
 *
 * so untagging a resource — which the tests name as "an operator excluding it
 * deliberately" — stopped working the moment a manifest was in play. `ctx` no
 * longer ACCEPTS a manifest value; a caller must supply `readManifest`, a
 * re-reader invoked at act time. Omitting it is a valid, fail-safe choice: it
 * makes manifest-sourced ownership non-re-verifiable, so the tag becomes
 * mandatory for the final go/no-go.
 *
 * FAIL-SAFE throughout. If either reader throws, or returns nothing, or the
 * fresh evidence no longer establishes Loom ownership, `proceed` is false and
 * the resource is left RUNNING. Never the other way around — the SHIR idle-stop
 * contract: on any query error, leave it up.
 */
export async function reverifyBeforeAct(
  candidate: PauseCandidate,
  readTags: (resourceId: string) => Promise<Readonly<Record<string, string>> | null>,
  ctx: {
    estateId: string;
    /**
     * Re-reads the deploy manifest AT ACT TIME. Omit it and manifest-sourced
     * ownership simply cannot be re-verified, so the estate tag is required.
     * There is deliberately no way to pass a pre-fetched manifest here.
     */
    readManifest?: () => Promise<DeployManifest | null>;
  },
): Promise<ReverifyResult> {
  let freshTags: Readonly<Record<string, string>> | null;
  try {
    freshTags = await readTags(candidate.resource.resourceId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const ownership: LoomOwnershipEvidence = {
      verdict: 'indeterminate',
      source: 'none',
      reason: `Re-reading the tags of ${candidate.resource.name} failed: ${detail}.`,
    };
    return {
      proceed: false,
      reason:
        `Could not re-verify ownership of ${candidate.resource.name} before acting (${detail}). `
        + 'Leaving it RUNNING — never act on uncertainty.',
      ownership,
    };
  }

  let freshManifest: DeployManifest | undefined;
  if (ctx.readManifest) {
    try {
      freshManifest = (await ctx.readManifest()) ?? undefined;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        proceed: false,
        reason:
          `Could not re-read the deploy manifest before acting on ${candidate.resource.name} `
          + `(${detail}). Leaving it RUNNING — never act on uncertainty.`,
        ownership: {
          verdict: 'indeterminate',
          source: 'none',
          reason: `Re-reading the deploy manifest failed: ${detail}.`,
        },
      };
    }
  }

  const fresh: DiscoveredResource = {
    ...candidate.resource,
    tags: freshTags,
    ...(freshTags == null
      ? { tagsError: 'the tag re-read returned no tags' }
      : { tagsError: undefined }),
  };
  const ownership = resolveOwnership(fresh, {
    estateId: ctx.estateId,
    ...(freshManifest ? { manifest: freshManifest } : {}),
  });

  if (ownership.verdict !== 'loom-owned') {
    return {
      proceed: false,
      reason:
        `Ownership of ${candidate.resource.name} no longer verifies as Loom-owned at act time `
        + `(${ownership.verdict}). ${ownership.reason} Leaving it RUNNING.`,
      ownership,
    };
  }

  return {
    proceed: true,
    reason: `Ownership re-verified immediately before acting. ${ownership.reason}`,
    ownership,
  };
}
