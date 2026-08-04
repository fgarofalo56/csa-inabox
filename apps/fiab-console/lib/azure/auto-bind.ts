/**
 * AUTO-BIND ENGINE — a Loom item's Azure backing object is provisioned and
 * bound BY THE PLATFORM, not by the user.
 *
 * The rule this implements: `.claude/rules/auto-bind-by-default.md`
 *
 *   "For anything in Loom that requires a direct binding or mapping to the
 *    Azure service, just do that by default. Don't make the user or customer
 *    do it. Mount ADF, mount whatever the underlying service is, mapped and
 *    named exactly the same as it is in Loom. […] If there's some binding or
 *    mapping or mounting that needs to take place between what's in Loom and
 *    the Azure service, you figure it out, you fix it, you make it work."
 *
 * The live defect it closes: #2942. Opening a `data-pipeline` item showed no
 * canvas at all — the centre pane was a *"Bind to an existing pipeline"* form
 * whose dropdown read "No pipelines found" and whose **Bind** button was
 * disabled. A dead end: there was no path from that screen to a working
 * canvas, and the ribbon's entire authoring surface was inert behind it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *
 * `ensureAutoBinding(ctx)` is the ONE seam. Given a Loom item it guarantees, on
 * return, that either
 *
 *   (a) the item's backing Azure object EXISTS and the item's `state` carries a
 *       binding to it (`status: 'bound'`), or
 *   (b) the caller learns precisely why not, in a form the UI can act on —
 *       `'retry'` (transient; show progress + Retry) or `'unavailable'`
 *       (a genuine estate/permission gate; show a Fix-it).
 *
 * It is:
 *
 *   IDEMPOTENT   Calling it N times creates ONE backing object. Call 1 creates;
 *                calls 2..N probe, find it, and return `via:'existing'` without
 *                issuing a create. This is the property the editor depends on,
 *                because the editor calls it on EVERY open.
 *
 *   SELF-HEALING A binding whose backing object has been deleted, renamed, or
 *                lost out-of-band is REPAIRED on the next call (`via:
 *                'recreated'`) rather than surfaced as an error. Per rule §3,
 *                "a stale binding is a bug to repair automatically, not a
 *                message to show the user."
 *
 *   NAME-FAITHFUL The backing object carries the item's `displayName`,
 *                sanitized ONLY where the service's naming rules force it, and
 *                then deterministically via `./backing-name`. The mapping
 *                (`sourceName` → `backingName`, plus a `sanitized` flag) is
 *                recorded in `state.autoBind` so it is inspectable rather than
 *                guessed.
 *
 *   NON-FATAL    It never throws. A provider blowing up becomes a `'retry'`
 *                outcome. Item creation must never fail because Azure hiccuped.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES *NOT* DO
 * ---------------------------------------------------------------------------
 *
 * It does not persist. `ensureAutoBinding` returns a `statePatch`; the caller
 * decides whether and how to write it (the create path merges before the Cosmos
 * insert; the editor path writes through `persistAutoBindPatch`). Keeping the
 * engine free of persistence is what lets the core be unit-tested against a
 * fake provider with no Cosmos in the picture.
 *
 * It does not authorize. Every adopter is already behind a session + workspace
 * guard (`withSession` / `withWorkspaceOwner` / `authorizeItemWorkspace`). This
 * engine assumes the caller has established access to the item and MUST NOT be
 * mounted on an unauthenticated path.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATCH ALSO WRITES LEGACY KEYS
 * ---------------------------------------------------------------------------
 *
 * A provider's `stateKeys()` returns the binding fields the EXISTING resolvers
 * already read — `state.pipelineName` + `state.factory*` for pipelines,
 * `state.transportHub`/`ehId` for eventstreams, and so on. Auto-bind therefore
 * writes the same shape the manual bind button always wrote, so every
 * downstream route (`resolveBinding`, run/save/validate/triggers) works
 * unchanged and a previously hand-bound item is recognised as already bound.
 * `state.autoBind` is ADDITIVE provenance, never the sole source of truth.
 *
 * Server-only: providers reach Azure control planes. Never import from a client
 * component.
 */
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The item facts a provider needs. Deliberately not the whole `WorkspaceItem`. */
export interface AutoBindContext {
  itemId: string;
  /** The item's PERSISTED `itemType` (e.g. 'data-pipeline', not the route slug). */
  itemType: string;
  displayName: string;
  workspaceId: string;
  /** The item's current `state` bag — read-only to the engine. */
  state: Record<string, unknown>;
  /**
   * Route-slug hint used to disambiguate a type that has more than one backend
   * (a `data-pipeline` opened through `/api/items/adf-pipeline/...` means ADF;
   * through `/api/items/synapse-pipeline/...` means Synapse). Absent → the
   * provider's own default backend selection applies.
   */
  slugHint?: string;
}

/** How the current binding came to be. Recorded for support/diagnosis. */
export type AutoBindVia = 'created' | 'attached' | 'existing' | 'recreated';

/** The inspectable mapping record written to `state.autoBind`. */
export interface AutoBindRecord {
  /** Provider key, e.g. 'adf-pipeline'. */
  provider: string;
  /** The object's name AS IT EXISTS IN AZURE. */
  backingName: string;
  /** The Loom `displayName` this name was derived from. */
  sourceName: string;
  /** True when the service's naming rules forced `backingName !== sourceName`. */
  sanitized: boolean;
  /** How this binding was (re)established on the most recent ensure. */
  via: AutoBindVia;
  /** ISO timestamp of the most recent successful ensure. */
  boundAt: string;
  /** Provider coordinates (factory/sub/rg, account/container, cluster, …). */
  coords?: Record<string, string>;
  /**
   * True when the Loom item was RENAMED after its backing object was created,
   * so `backingName` no longer equals the sanitized current `displayName`.
   *
   * We deliberately keep the ORIGINAL binding in that case instead of creating
   * a fresh object under the new name: the existing object holds the user's
   * authored pipeline/hub/database, and silently orphaning it to satisfy the
   * name rule would destroy work. The drift is recorded so the editor can offer
   * an explicit re-map, and so support can see it without guessing.
   */
  nameDrift?: boolean;
}

/** Everything a caller can learn from one ensure. */
export type AutoBindOutcome =
  | {
      status: 'bound';
      record: AutoBindRecord;
      /** Merge into `item.state` and persist. Already includes `autoBind`. */
      statePatch: Record<string, unknown>;
      /** False when the binding was already correct — nothing needs writing. */
      changed: boolean;
    }
  /** No provider claims this item type — it has no Azure backing object. */
  | { status: 'unsupported' }
  /**
   * A genuine estate/permission gate the platform cannot self-serve. Per rule
   * §"Allowed (narrowly)" + `ux-baseline` G2 this must reach the user as a
   * one-click Fix-it, never a paragraph of instructions.
   */
  | { status: 'unavailable'; provider: string; reason: string; missing?: string }
  /**
   * Transient (5xx / throttle / timeout / provisioning-in-flight). The surface
   * shows PROGRESS and a Retry — never a dead end, never a red error banner.
   */
  | { status: 'retry'; provider: string; reason: string };

/** A provider's answer to "can I run at all, and against what coordinates?" */
export type AutoBindPreflight =
  | { ok: true; coords: Record<string, string> }
  | { ok: false; kind: 'unavailable' | 'retry'; reason: string; missing?: string };

/**
 * One Azure backing service, taught how to probe + create its object.
 *
 * Providers implement only the service-specific parts. Idempotency, self-heal,
 * naming, drift detection, and outcome classification all live in the engine —
 * so a NEW provider cannot get those wrong, which is exactly the failure mode
 * that produced five divergent name sanitizers.
 */
export interface AutoBindProvider {
  /** Stable key recorded in `AutoBindRecord.provider`. */
  readonly provider: string;
  /** Loom item types this provider backs. */
  readonly itemTypes: readonly string[];
  /**
   * When several providers claim the same itemType, the engine picks the one
   * whose `claims()` returns true for the context (backend env + slug hint).
   * Omitted → the provider claims every listed itemType unconditionally.
   */
  claims?(ctx: AutoBindContext): boolean;
  /** The deterministic Azure name for this item. Must be pure. */
  backingNameFor(ctx: AutoBindContext): { name: string; sanitized: boolean };
  /** Config/estate readiness + the coordinates probe/create will target. */
  preflight(ctx: AutoBindContext): Promise<AutoBindPreflight>;
  /** Does an object of this name exist at `coords`? Must not create. */
  probe(name: string, coords: Record<string, string>, ctx: AutoBindContext): Promise<boolean>;
  /** Create the object. Called only when `probe` said false. */
  create(name: string, coords: Record<string, string>, ctx: AutoBindContext): Promise<void>;
  /**
   * The binding fields the EXISTING downstream resolvers read (e.g.
   * `pipelineName`). Merged into the state patch so nothing downstream changes.
   */
  stateKeys(name: string, coords: Record<string, string>): Record<string, unknown>;
  /**
   * Read any binding this item ALREADY has under the legacy keys, from before
   * `state.autoBind` existed (a hand-bound pipeline, a provisioner-installed
   * eventstream). Lets the engine adopt it instead of creating a second object.
   */
  existingBinding?(ctx: AutoBindContext): string | null;
}

/** The `state` key the provenance record lives under. */
export const AUTO_BIND_STATE_KEY = 'autoBind';

/** Read the provenance record off an item's state, if any. */
export function readAutoBindRecord(state: Record<string, unknown> | undefined): AutoBindRecord | null {
  const raw = state?.[AUTO_BIND_STATE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AutoBindRecord>;
  if (typeof r.provider !== 'string' || typeof r.backingName !== 'string' || !r.backingName) return null;
  return {
    provider: r.provider,
    backingName: r.backingName,
    sourceName: typeof r.sourceName === 'string' ? r.sourceName : '',
    sanitized: r.sanitized === true,
    via: (r.via as AutoBindVia) || 'existing',
    boundAt: typeof r.boundAt === 'string' ? r.boundAt : '',
    coords: r.coords && typeof r.coords === 'object' ? (r.coords as Record<string, string>) : undefined,
    nameDrift: r.nameDrift === true,
  };
}

/** Build a context from a loaded Cosmos item. */
export function autoBindContextFromItem(item: WorkspaceItem, slugHint?: string): AutoBindContext {
  return {
    itemId: item.id,
    itemType: item.itemType,
    displayName: item.displayName || '',
    workspaceId: item.workspaceId,
    state: (item.state || {}) as Record<string, unknown>,
    slugHint,
  };
}

/**
 * Pick the provider for a context. When several claim the itemType, the first
 * whose `claims()` passes wins; a provider without `claims()` is the fallback.
 */
export function resolveAutoBindProvider(
  ctx: AutoBindContext,
  providers: readonly AutoBindProvider[],
): AutoBindProvider | null {
  const candidates = providers.filter((p) => p.itemTypes.includes(ctx.itemType));
  if (candidates.length === 0) return null;
  const claimed = candidates.find((p) => typeof p.claims === 'function' && p.claims(ctx));
  if (claimed) return claimed;
  return candidates.find((p) => typeof p.claims !== 'function') ?? candidates[0];
}

/** Classify a thrown error into the retry-vs-unavailable split. */
function classifyThrow(e: unknown): { kind: 'unavailable' | 'retry'; reason: string } {
  const status = (e as { status?: number })?.status;
  const msg = e instanceof Error ? e.message : String(e);
  // 401/403 are estate/permission facts a retry will not change → Fix-it.
  if (status === 401 || status === 403) {
    return { kind: 'unavailable', reason: msg };
  }
  // Everything else — 429, 5xx, timeouts, transport, in-flight provisioning —
  // is worth another attempt, so the surface shows progress rather than a wall.
  return { kind: 'retry', reason: msg };
}

export interface EnsureAutoBindingOptions {
  /**
   * Provider set. Defaults to the real registry; unit tests inject fakes so the
   * ENGINE's idempotency / self-heal / naming invariants are exercised without
   * an Azure control plane in the loop.
   */
  providers?: readonly AutoBindProvider[];
  /** Clock seam for deterministic `boundAt` in tests. */
  now?: () => Date;
}

/**
 * Ensure the item's backing Azure object exists and is bound. See the CONTRACT
 * block at the top of this file for the guarantees.
 *
 * The algorithm, in the order the guarantees demand:
 *
 *   1. Resolve a provider. None → `'unsupported'` (the item has no backing
 *      service; this is not an error and not a gate).
 *   2. Preflight. A provider that cannot reach its service reports
 *      `unavailable` (permission/estate) or `retry` (transient) and STOPS —
 *      we never create against unknown coordinates.
 *   3. Determine the TARGET name from the current displayName, and the
 *      CANDIDATE name already on the item (the `autoBind` record first, then
 *      the provider's legacy key so a hand-bound or installer-provisioned item
 *      is adopted rather than duplicated).
 *   4. If there is a candidate, PROBE it.
 *        - present → bound. `via:'existing'`. `nameDrift` is set when the item
 *          has since been renamed (see `AutoBindRecord.nameDrift` for why we
 *          keep the old object).
 *        - absent  → SELF-HEAL: fall through to create at the TARGET name.
 *   5. No candidate (or it vanished) → probe the TARGET name.
 *        - present → `via:'attached'` (the object already existed; we adopt it
 *          rather than failing or duplicating).
 *        - absent  → CREATE it, then `via:'created'` / `'recreated'`.
 *
 * Step 4's probe is what makes repeat calls cheap AND makes deletion detectable
 * — it is the single line that both idempotency and self-heal hang off. Break
 * it and the mutation test in `__tests__/auto-bind.test.ts` goes red.
 */
export async function ensureAutoBinding(
  ctx: AutoBindContext,
  opts: EnsureAutoBindingOptions = {},
): Promise<AutoBindOutcome> {
  const { AUTO_BIND_PROVIDERS } = await import('./auto-bind-providers');
  const providers = opts.providers ?? AUTO_BIND_PROVIDERS;
  const now = opts.now ?? (() => new Date());

  const provider = resolveAutoBindProvider(ctx, providers);
  if (!provider) return { status: 'unsupported' };

  // ---- 2. Preflight ------------------------------------------------------
  let pre: AutoBindPreflight;
  try {
    pre = await provider.preflight(ctx);
  } catch (e) {
    const c = classifyThrow(e);
    return c.kind === 'unavailable'
      ? { status: 'unavailable', provider: provider.provider, reason: c.reason }
      : { status: 'retry', provider: provider.provider, reason: c.reason };
  }
  if (!pre.ok) {
    return pre.kind === 'unavailable'
      ? { status: 'unavailable', provider: provider.provider, reason: pre.reason, missing: pre.missing }
      : { status: 'retry', provider: provider.provider, reason: pre.reason };
  }
  const coords = pre.coords;

  // ---- 3. Target + candidate names ---------------------------------------
  const target = provider.backingNameFor(ctx);
  const record = readAutoBindRecord(ctx.state);
  const legacy = provider.existingBinding?.(ctx) || null;
  const candidate =
    record && record.provider === provider.provider ? record.backingName : legacy || null;

  const finish = (name: string, via: AutoBindVia, sanitized: boolean): AutoBindOutcome => {
    const nameDrift = name !== target.name;
    const next: AutoBindRecord = {
      provider: provider.provider,
      backingName: name,
      sourceName: ctx.displayName,
      sanitized,
      via,
      boundAt: now().toISOString(),
      ...(Object.keys(coords).length ? { coords } : {}),
      ...(nameDrift ? { nameDrift: true } : {}),
    };
    const keys = provider.stateKeys(name, coords);
    // The legacy keys are what every downstream resolver actually reads
    // (`state.pipelineName` and friends). If the item's state does not already
    // carry them EXACTLY, this ensure has to be written even when the provenance
    // record itself is unchanged — otherwise an item whose record survived but
    // whose `pipelineName` was cleared would report bound while the bind GET
    // read `null` and the editor fell back to the manual picker. That is the
    // #2942 dead end returning through a side door.
    const keysAlreadyPresent = Object.entries(keys).every(([k, v]) => ctx.state?.[k] === v);
    // `changed` drives whether the caller writes at all. A steady-state open
    // (same name, same provider, no drift change, keys already on the item)
    // writes NOTHING — the editor hits this on every subsequent open, so it must
    // not churn Cosmos.
    const changed =
      !record ||
      !keysAlreadyPresent ||
      record.provider !== next.provider ||
      record.backingName !== next.backingName ||
      record.sourceName !== next.sourceName ||
      record.sanitized !== next.sanitized ||
      (record.nameDrift === true) !== (next.nameDrift === true) ||
      via !== 'existing';
    return {
      status: 'bound',
      record: next,
      statePatch: {
        ...keys,
        [AUTO_BIND_STATE_KEY]: next,
      },
      changed,
    };
  };

  // ---- 4. Probe the candidate (idempotency + self-heal) -------------------
  if (candidate) {
    try {
      if (await provider.probe(candidate, coords, ctx)) {
        return finish(candidate, 'existing', candidate !== ctx.displayName);
      }
      // Absent → the backing object was deleted/renamed out of band. Fall
      // through and re-create at the TARGET name. This is the self-heal.
    } catch (e) {
      const c = classifyThrow(e);
      return c.kind === 'unavailable'
        ? { status: 'unavailable', provider: provider.provider, reason: c.reason }
        : { status: 'retry', provider: provider.provider, reason: c.reason };
    }
  }

  // ---- 5. Probe the target, then create ----------------------------------
  try {
    if (await provider.probe(target.name, coords, ctx)) {
      return finish(target.name, 'attached', target.sanitized);
    }
    await provider.create(target.name, coords, ctx);
    return finish(target.name, candidate ? 'recreated' : 'created', target.sanitized);
  } catch (e) {
    const c = classifyThrow(e);
    return c.kind === 'unavailable'
      ? { status: 'unavailable', provider: provider.provider, reason: c.reason }
      : { status: 'retry', provider: provider.provider, reason: c.reason };
  }
}

/**
 * The EDITOR-OPEN adoption: ensure + persist in one call, shaped for a BFF
 * route that is about to answer an editor's "what am I bound to?" request.
 *
 * This is the seam that kills #2942's dead end. The bind GET used to answer
 * `bound: null` for an item nobody had hand-bound, and the editor rendered a
 * *"Bind to an existing pipeline"* form in place of its canvas — with an empty
 * dropdown and a disabled button. Now the route asks the platform to DO the
 * binding first, so the same GET answers with a real name and the editor opens
 * on the canvas.
 *
 * The persist is fire-and-check, not fire-and-forget-the-result: we only write
 * when `changed`, so the steady-state open (every open after the first) issues
 * ZERO Cosmos writes. That matters because this runs on every editor open.
 *
 * A write failure is deliberately NOT propagated. By the time we get here the
 * BACKING OBJECT EXISTS in Azure; the provenance record is a convenience, and
 * the next open recomputes the identical binding because the engine is
 * idempotent. Failing the open over it would reintroduce exactly the dead end
 * this replaces.
 *
 * AUTHORIZATION: the caller must already have authorized `item` (every adopter
 * comes through `loadPipelineItem` / `withWorkspaceOwner` / `authorizeItemWorkspace`).
 */
export interface AutoBindOnOpenResult {
  /** The backing object's name, or null when it could not be established. */
  bound: string | null;
  outcome: AutoBindOutcome;
  /** True when the provenance record was written to Cosmos on this call. */
  persisted: boolean;
}

export async function autoBindOnOpen(
  item: WorkspaceItem,
  slugHint?: string,
  opts: EnsureAutoBindingOptions = {},
): Promise<AutoBindOnOpenResult> {
  const ctx = autoBindContextFromItem(item, slugHint);
  const outcome = await ensureAutoBinding(ctx, opts);
  if (outcome.status !== 'bound') return { bound: null, outcome, persisted: false };
  // Keep the in-memory item consistent with the binding we just established,
  // ALWAYS — not only when we persist. The bind GET reads
  // `item.state.pipelineName` immediately after this call to build its answer,
  // so skipping the in-memory merge on a steady-state open would report
  // `bound: null` for an item that is in fact bound, and the editor would render
  // its manual picker instead of the canvas (#2942's exact symptom).
  item.state = { ...(item.state || {}), ...outcome.statePatch };
  let persisted = false;
  if (outcome.changed) {
    persisted = await persistAutoBindPatch(item.id, item.workspaceId, outcome.statePatch);
  }
  return { bound: outcome.record.backingName, outcome, persisted };
}

/**
 * Shape an outcome for the wire so a client can render the right surface
 * without re-deriving the classification. Consumed by the pipeline editor.
 */
export function autoBindWireStatus(outcome: AutoBindOutcome): {
  status: AutoBindOutcome['status'];
  via?: AutoBindVia;
  backingName?: string;
  sourceName?: string;
  sanitized?: boolean;
  nameDrift?: boolean;
  /** Present for 'retry' and 'unavailable' — human-readable, already remediation-shaped. */
  reason?: string;
  /** Present for 'unavailable' — the resource/env the estate is missing. */
  missing?: string;
  /** True when the UI should offer a Retry rather than a Fix-it. */
  retryable?: boolean;
} {
  switch (outcome.status) {
    case 'bound':
      return {
        status: 'bound',
        via: outcome.record.via,
        backingName: outcome.record.backingName,
        sourceName: outcome.record.sourceName,
        sanitized: outcome.record.sanitized,
        nameDrift: outcome.record.nameDrift,
      };
    case 'retry':
      return { status: 'retry', reason: outcome.reason, retryable: true };
    case 'unavailable':
      return { status: 'unavailable', reason: outcome.reason, missing: outcome.missing, retryable: false };
    default:
      return { status: 'unsupported' };
  }
}

/**
 * The ITEM-CREATE adoption. Rule §1: *"Creating a Loom item PROVISIONS AND
 * BINDS its backing resource. […] No second step, no wizard the user must
 * find."*
 *
 * Bounded by a deadline, deliberately. Creating a Loom item is an interactive
 * action and must stay interactive: if a control plane is slow or wedged we
 * abandon the wait and let the create return. Correctness does not depend on
 * this call completing, because
 *
 *   - the engine is IDEMPOTENT, so the editor's open-time `autoBindOnOpen`
 *     finishes the job — creating the object if this call never got that far,
 *     or adopting it if it did — and
 *   - an abandoned ensure leaves no broken intermediate state: either the Azure
 *     object exists or it does not, and the next probe settles it either way.
 *
 * NEVER throws: item creation must not fail because Azure hiccuped. Returns the
 * outcome for logging, or null when the deadline won the race.
 */
export async function autoBindOnCreate(
  item: WorkspaceItem,
  opts: EnsureAutoBindingOptions & { timeoutMs?: number } = {},
): Promise<AutoBindOutcome | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = autoBindOnOpen(item, undefined, opts).then((r) => r.outcome);
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([work, deadline]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Merge an auto-bind `statePatch` onto a Cosmos item and persist it.
 *
 * Point-read + replace on (`id`, `workspaceId`) — `items` is partitioned by
 * `/workspaceId`, so this touches exactly one document and cannot cross a
 * partition. Best-effort by design: a failed provenance write must never break
 * the editor open that triggered it, because the BACKING OBJECT already exists
 * at that point and the next open re-derives the same binding anyway (the
 * engine is idempotent). Returns whether the write landed.
 *
 * AUTHORIZATION: this performs no access check. Call it only after the caller
 * has been authorized for the item.
 */
export async function persistAutoBindPatch(
  itemId: string,
  workspaceId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { itemsContainer } = await import('@/lib/azure/cosmos-client');
    const items = await itemsContainer();
    const { resource } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
    if (!resource) return false;
    const next: WorkspaceItem = {
      ...resource,
      state: { ...(resource.state || {}), ...patch },
      updatedAt: new Date().toISOString(),
    };
    await items.item(itemId, workspaceId).replace<WorkspaceItem>(next);
    return true;
  } catch {
    return false;
  }
}