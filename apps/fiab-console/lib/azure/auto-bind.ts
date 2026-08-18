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

/**
 * What a provider's `seedFromContent` did with the item's authored content.
 *
 * `seeded:false` with no `error` means "there was nothing to seed" (a blank
 * item a user just created has no bundle content, and an EMPTY backing object
 * is the correct outcome for it). `seeded:false` WITH an `error` means the
 * content existed and we failed to author it — which must reach the user
 * honestly rather than being swallowed into a green bind.
 */
export interface AutoBindSeedResult {
  /** True only when the item's authored content was actually written. */
  seeded: boolean;
  /** Human-readable summary for the step log / support (e.g. "3 activities"). */
  detail?: string;
  /** Set when content EXISTED but could not be authored. */
  error?: string;
}

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
  /**
   * True when the item's AUTHORED CONTENT (the bundle's activity graph, table
   * DDL, stream topology …) was written into the backing object at create time.
   *
   * #3549: without this the create path authored an EMPTY twin of a Loom item
   * that already carried real content. A bundle-installed pipeline whose
   * install had config-gated (so no ADF pipeline existed and `pipelineName` was
   * never stamped) got an empty pipeline manufactured under it on first open —
   * a genuinely published ARM resource with `activities: []`. It then reported
   * `ok:true` forever, because the item WAS bound and the live object DID
   * exist; only its contents were missing. 36 of 41 pipelines in the live
   * factory were in that state.
   */
  seeded?: boolean;
  /** Set when authored content existed but could not be written. Honest, not fatal. */
  seedError?: string;
  /**
   * The seed's own summary of what it did — "3 activities", or "3 activities;
   * used 2 pre-existing reference(s) as-is: SalesDW_Prod, ProdOrders".
   *
   * WHY THIS FIELD EXISTS (#3549 review round 2). `seedPipelineFromContent`
   * computed that adopted-reference disclosure and returned it on
   * `AutoBindSeedResult.detail`, and `finish()` below persisted only `seeded`
   * and `seedError` — so the string was built and dropped on every call. A
   * comment claimed "a support read of the record shows which objects Loom did
   * not author" while nothing carried it: the same describes-a-mechanism-that-
   * does-not-exist shape as the eventstream re-seed comment this review round
   * was opened for.
   *
   * WHERE IT LANDS, precisely: `state.autoBind.seedDetail` in Cosmos, and the
   * `autoBind` block the two pipeline bind GETs return
   * (`autoBindWireStatus`). No UI renders it today — it is diagnostic, for
   * support reading the item or the bind response. The USER-facing copy of the
   * same disclosure is the installer's step log (`adf-pipeline.ts` pushes
   * `seed.steps`), which the auto-bind path has no equivalent of.
   */
  seedDetail?: string;
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
   * OPTIONAL, but see the coverage test in `__tests__/auto-bind-seed.test.ts`:
   * a provider that omits this MUST be on the documented opt-out list, so a new
   * provider cannot silently inherit the #3549 empty-twin defect.
   *
   * Author the item's EXISTING content into the object `create` just made.
   * Called by the ENGINE, and ONLY on the create paths (`via:'created'` /
   * `'recreated'`) — never for `'existing'` or `'attached'`, because those
   * objects already hold whatever the user or the installer put there and
   * re-authoring bundle content over them would destroy real work.
   *
   * Must NOT throw: return `{seeded:false, error}` instead. A seed failure
   * leaves a REAL, bound backing object behind, so it is reported honestly on
   * the record rather than being turned into a dead end.
   */
  seedFromContent?(
    name: string,
    coords: Record<string, string>,
    ctx: AutoBindContext,
  ): Promise<AutoBindSeedResult>;
  /**
   * OPTIONAL. Does the backing object hold NO authored content?
   *
   * This is what makes a failed seed non-terminal and what repairs the items
   * that were already broken when #3549 was reported. `probe` answers "does it
   * EXIST", which is why an already-empty pipeline took the `via:'existing'`
   * path and was never seeded — the platform could not tell a healthy binding
   * from an empty twin.
   *
   * The engine calls this ONLY when the item's provenance does not already say
   * `seeded:true`, so a healthy item costs zero extra control-plane calls on
   * its steady-state opens. When it returns true AND the item has authored
   * content, the engine re-runs `seedFromContent` — safe by construction,
   * because there is no work in an empty object to destroy.
   *
   * A provider that omits this NEVER re-seeds, which is the pre-existing
   * behaviour. Must not throw: return false if it cannot tell (unknown is not
   * empty — we do not overwrite on a guess).
   *
   * COVERAGE, stated rather than implied (#3549 review, BLOCKER 2). Only the
   * two PIPELINE providers implement it today, so only they self-heal an empty
   * binding. `eventstream`, `adx-database` and `lakehouse-adls` do not — and
   * would gain nothing yet if they did, because `autoBindOnOpen` is wired into
   * the two pipeline bind routes ONLY, so nothing re-runs the engine for those
   * item types after create (that wiring is tracked in #3694). Each of the
   * three carries a reasoned entry in `ISEMPTY_OPT_OUTS`
   * (`__tests__/auto-bind-seed.test.ts`), which walks the live registry
   * mechanically: adding a sixth provider without either an `isEmpty` or an
   * entry turns that walk red.
   */
  isEmpty?(
    name: string,
    coords: Record<string, string>,
    ctx: AutoBindContext,
  ): Promise<boolean>;
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
    ...(r.seeded === true ? { seeded: true } : {}),
    ...(typeof r.seedError === 'string' && r.seedError ? { seedError: r.seedError } : {}),
    ...(typeof r.seedDetail === 'string' && r.seedDetail ? { seedDetail: r.seedDetail } : {}),
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
 * Repair an EMPTY backing object we are about to report as bound (#3549).
 *
 * Returns a seed result when a repair was attempted, `undefined` when the
 * question did not arise — in which case `finish()` carries the prior record's
 * provenance forward untouched, exactly as before.
 *
 * The guards, in the order they matter:
 *
 *   1. `seeded === true` on the record → the content is already in there.
 *      Returns immediately, so a healthy item's steady-state open makes ZERO
 *      extra control-plane calls. This is the common path and it must stay free.
 *   2. No `seedFromContent` / no `isEmpty` → the provider has not opted in;
 *      behaviour is unchanged from before this hook existed.
 *   3. `isEmpty` says the object holds something → NEVER touch it. A user's
 *      authored graph outranks a stale bundle every time, and an `isEmpty` that
 *      cannot tell is contracted to answer false, so an unknown is treated as
 *      "has work". We still record `seeded:true` in that case, because the
 *      object demonstrably HAS content — that clears a stale `seedError` and
 *      retires the probe.
 *
 * Only once all three pass do we seed — into an object we have just confirmed
 * is empty, so there is nothing to destroy. `seedFromContent` itself returns
 * `{seeded:false}` with no error when the item has no authored content, which
 * leaves a blank item exactly as it was.
 *
 * Never throws: a repair failure must not turn a working binding into a dead
 * end, so it is reported on the record like any other seed failure.
 */
async function maybeRepairSeed(
  provider: AutoBindProvider,
  name: string,
  coords: Record<string, string>,
  ctx: AutoBindContext,
  record: AutoBindRecord | null,
): Promise<AutoBindSeedResult | undefined> {
  if (record?.seeded === true) return undefined;
  if (!provider.seedFromContent || !provider.isEmpty) return undefined;
  try {
    if (!(await provider.isEmpty(name, coords, ctx))) {
      // The object HOLDS content — whether we wrote it, the installer did, or
      // the user authored it on the canvas. Record that, which both clears a
      // now-stale `seedError` (otherwise the editor's gate would accuse a
      // pipeline that is demonstrably fine, forever) and stops every later
      // open paying for this probe.
      return { seeded: true, detail: 'backing object already holds content' };
    }
    return await provider.seedFromContent(name, coords, ctx);
  } catch (e) {
    return { seeded: false, error: e instanceof Error ? e.message : String(e) };
  }
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
 *        - absent  → CREATE it, then SEED it from the item's own authored
 *          content (`seedFromContent`), then `via:'created'` / `'recreated'`.
 *
 * Step 5's seed is what stops the platform manufacturing an EMPTY twin of an
 * item that already has content (#3549). It runs on the create paths ONLY —
 * an attached/existing object holds real work and is never overwritten.
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

  const finish = (
    name: string,
    via: AutoBindVia,
    sanitized: boolean,
    seed?: AutoBindSeedResult,
  ): AutoBindOutcome => {
    const nameDrift = name !== target.name;
    // Seeding runs ONLY on the create paths. On 'existing'/'attached' we carry
    // the PRIOR record's seed provenance forward untouched: re-deriving it as
    // `undefined` every steady-state open would flip `changed` to true and make
    // the editor write Cosmos on every single open.
    const seeded = seed ? seed.seeded : record?.seeded === true;
    const seedError = seed ? seed.error : record?.seedError;
    // `detail` is the seed's own account of what it wrote — including which
    // references it ADOPTED rather than created (#3549 review round 2). It is
    // carried forward on the non-create paths exactly like the two above, so a
    // steady-state open neither loses it nor re-writes Cosmos over it.
    const seedDetail = seed ? seed.detail : record?.seedDetail;
    const next: AutoBindRecord = {
      provider: provider.provider,
      backingName: name,
      sourceName: ctx.displayName,
      sanitized,
      via,
      boundAt: now().toISOString(),
      ...(Object.keys(coords).length ? { coords } : {}),
      ...(nameDrift ? { nameDrift: true } : {}),
      ...(seeded ? { seeded: true } : {}),
      ...(seedError ? { seedError } : {}),
      ...(seedDetail ? { seedDetail } : {}),
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
      (record.seeded === true) !== (next.seeded === true) ||
      (record.seedError || '') !== (next.seedError || '') ||
      (record.seedDetail || '') !== (next.seedDetail || '') ||
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
        // #3549 (review BLOCKER 3) — REPAIR an empty binding before reporting
        // it healthy. `probe` is existence-only, so both the item whose seed
        // FAILED and the item that was bound to an empty pipeline long before
        // auto-bind existed land here and, without this, stay empty forever.
        const repair = await maybeRepairSeed(provider, candidate, coords, ctx, record);
        return finish(candidate, 'existing', candidate !== ctx.displayName, repair);
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
      // Same repair as the candidate path: an object we ATTACH to can equally
      // be an empty twin an earlier gated install left behind.
      const repair = await maybeRepairSeed(provider, target.name, coords, ctx, record);
      return finish(target.name, 'attached', target.sanitized, repair);
    }
    await provider.create(target.name, coords, ctx);
    // ---- 5b. SEED the object we just made with the item's own content -----
    //
    // #3549. `create` deliberately makes an EMPTY object — that is right for a
    // blank item a user just created, and wrong for an item that already
    // carries an authored graph (a bundle install whose provisioner config-
    // gated, so it stamped `state.content` but never authored the backing
    // pipeline). Without this step the platform manufactures an empty twin of
    // real content and then reports it as bound and healthy forever.
    //
    // Only on create/recreate: an 'existing'/'attached' object holds the user's
    // work and must never be overwritten from a stale bundle.
    let seed: AutoBindSeedResult | undefined;
    if (provider.seedFromContent) {
      try {
        seed = await provider.seedFromContent(target.name, coords, ctx);
      } catch (e) {
        // A provider is contracted not to throw here; if one does, the binding
        // still stands (the object exists) and the failure is recorded rather
        // than converted into a dead end.
        seed = { seeded: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return finish(target.name, candidate ? 'recreated' : 'created', target.sanitized, seed);
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
  /**
   * True when the item's authored content was written into the backing object
   * at create time. Absent for a binding that was merely attached/existing.
   */
  seeded?: boolean;
  /**
   * Set when authored content existed but could not be written — the object is
   * REAL and bound but may be empty, so the caller must not present it as
   * complete (that is exactly the #3549 "silently empty" failure).
   */
  seedError?: string;
  /**
   * The seed's summary of what it wrote, including any references it ADOPTED
   * rather than created. DIAGNOSTIC: no surface renders it today — it is here
   * so the disclosure is reachable from the bind GET without a Cosmos read.
   * See `AutoBindRecord.seedDetail`.
   */
  seedDetail?: string;
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
        ...(outcome.record.seeded === true ? { seeded: true } : {}),
        ...(outcome.record.seedError ? { seedError: outcome.record.seedError } : {}),
        ...(outcome.record.seedDetail ? { seedDetail: outcome.record.seedDetail } : {}),
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