/**
 * BULK auto-bind repair — the durable counterpart to the per-open self-heal.
 *
 * ## Why this exists (#3796)
 *
 * `autoBindOnCreate` already fires on every item-creation route, but it races an
 * 8s deadline and deliberately never throws: a slow ADF control plane must not
 * fail the create. So the binding is BEST-EFFORT at create time, and an item
 * whose seed did not finish is left with a real, bound, but EMPTY backing
 * object. `autoBindOnOpen` repairs that — but only when a human opens the item,
 * and only for the two item types it is wired into. Nothing sweeps the backlog.
 *
 * That backlog is #3549's live population: an install that reported "created"
 * with counts, over pipelines whose ADF object holds zero activities.
 *
 * ## What this does NOT do
 *
 * It does not reimplement the bind algorithm. Live mode delegates every decision
 * to `autoBindOnOpen`, so idempotency, self-heal, name-drift and the
 * "never overwrite authored work" invariant are the ENGINE's, exercised here
 * rather than duplicated. Dry-run calls only the provider's READ methods
 * (`preflight` / `probe` / `isEmpty`, all documented non-mutating) and writes
 * nothing, anywhere.
 *
 * ## Why "36 → 0" is the WRONG success criterion
 *
 * `seedPipelineFromContent` authors `state.content` into the backing object. An
 * item created from the catalog picker has NO `state.content` — so its empty
 * pipeline is *correct*, and repair is a designed no-op. The honest target is
 * the one #3796 itself offers as its alternative: every empty backing object is
 * either repaired or carries a stated, inspectable reason. Every row this sweep
 * emits carries that reason.
 *
 * ## Coverage, stated rather than implied
 *
 * `maybeRepairSeed` needs BOTH `seedFromContent` and `isEmpty` on a provider.
 * Three of the five registered providers (eventstream, adx-database,
 * lakehouse-adls) have the former and not the latter, so they are structurally
 * unreachable by repair. They are reported as `no-empty-probe` — named and
 * counted, never silently omitted from the scan. Their reasoned opt-outs live in
 * `ISEMPTY_OPT_OUTS` (`__tests__/auto-bind-seed.test.ts`); each turns on "no
 * call site would reach it", and #3694 tracks the wiring that would change that.
 * This sweep IS such a call site, which is worth saying on #3694 — but adding
 * three data-plane emptiness probes is that issue's work, not this one's.
 */
import type { SqlParameter } from '@azure/cosmos';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  autoBindContextFromItem,
  autoBindOnOpen,
  readAutoBindRecord,
  resolveAutoBindProvider,
  type AutoBindProvider,
} from './auto-bind';
import { AUTO_BIND_PROVIDERS } from './auto-bind-providers';

/**
 * What the sweep concluded about one item. Every value is a FACT the sweep
 * established, not a guess — which is what makes the "stated reason" branch of
 * #3796's acceptance checkable rather than rhetorical.
 */
export type SweepDisposition =
  /** LIVE: the item's authored content was written into the backing object. */
  | 'repaired'
  /** LIVE: the backing object was missing; the engine created (and seeded) it. */
  | 'created'
  /** `state.autoBind.seeded === true` — healthy. Costs ZERO control-plane calls. */
  | 'already-healthy'
  /** `isEmpty()` said false. Repair REFUSES to touch it. This is the safety case. */
  | 'has-content'
  /** Backing object empty, item carries nothing to author. Correctly empty. */
  | 'no-authored-content'
  /** DRY-RUN: object is empty AND the item carries a content object to author. */
  | 'would-repair'
  /** DRY-RUN: no backing object at all; a live run would create and seed one. */
  | 'missing'
  /** Provider implements no `isEmpty`, so repair cannot reach it (#3694). */
  | 'no-empty-probe'
  /** No registered provider claims this item type — it has no Azure backing. */
  | 'unsupported'
  /** Estate/permission gate from `preflight`. Needs a Fix-it, not a retry. */
  | 'unavailable'
  /** Transient (throttle / 5xx / provisioning in flight). Re-run the sweep. */
  | 'retry'
  /** LIVE: content EXISTED and could not be authored. Reported, never swallowed. */
  | 'seed-failed'
  /** The sweep itself threw on this item. Never aborts the rest of the scan. */
  | 'failed';

export interface SweepRow {
  itemId: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  /** Provider key, or null when nothing claims the type. */
  provider: string | null;
  /** The backing object's name, when one was resolved. */
  backingName: string | null;
  disposition: SweepDisposition;
  /** Why this row got that disposition. Always populated. */
  reason: string;
}

export interface SweepResult {
  /** False only when the caller explicitly asked for writes. */
  dryRun: boolean;
  /** Items examined. */
  scanned: number;
  /** Count per disposition — the summary a support engineer reads first. */
  byDisposition: Record<string, number>;
  rows: SweepRow[];
  /**
   * True when the scan stopped early (row cap or deadline) — so a caller can
   * never read a partial scan as a complete one. Re-run to continue.
   */
  truncated: boolean;
  /** Set when truncated, naming which bound stopped it. */
  truncatedBy?: 'limit' | 'deadline';
}

export interface SweepOptions {
  /** Write when false. Callers must opt IN to mutation; see the route. */
  dryRun: boolean;
  /** Restrict to one workspace. Omitted → every workspace the container holds. */
  workspaceId?: string;
  /** Restrict to specific item types. Omitted → every type a provider claims. */
  itemTypes?: readonly string[];
  /** Max items to examine. Default 200, hard cap 1000. */
  limit?: number;
  /**
   * Wall-clock budget in ms, default 120_000. A caller with its own budget
   * (an HTTP route has `maxDuration`) MUST pass its own — this module cannot
   * know what its caller can afford, and a sweep killed mid-flight by the host
   * returns nothing at all, which is strictly worse than a reported partial.
   */
  deadlineMs?: number;
  /** Test seam — the engine's own. Injected fakes exercise the REAL algorithm. */
  providers?: readonly AutoBindProvider[];
  /** Test seam — supply items instead of querying Cosmos. */
  loadItems?: (o: { itemTypes: string[]; workspaceId?: string; limit: number }) => Promise<WorkspaceItem[]>;
  /** Test seam — monotonic clock for the deadline. */
  now?: () => number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_DEADLINE_MS = 120_000;

/**
 * Every item type some registered provider backs, derived from the registry.
 *
 * DERIVED, never hand-listed: a second list drifts from the first silently and
 * in one direction — a provider added tomorrow would simply never be swept, and
 * the sweep would report a clean estate it never looked at. Same argument, same
 * failure shape, as #3783's suite deriver.
 */
export function sweepableItemTypes(
  providers: readonly AutoBindProvider[] = AUTO_BIND_PROVIDERS,
): string[] {
  return [...new Set(providers.flatMap((p) => p.itemTypes))].sort();
}

/**
 * Does this item carry a content object that `seedFromContent` could author?
 *
 * Deliberately the WEAKER half of `authoredContent`'s test: shape only, no kind
 * matching. Only the provider's own `seedFromContent` knows which kinds it
 * accepts, and duplicating that list here would be the drift this file argues
 * against everywhere else. So dry-run reports `would-repair` (an attempt will be
 * made), and only the LIVE run distinguishes `repaired` from
 * `no-authored-content` — which it does from the engine's own seed record, not
 * from a second opinion.
 */
function carriesContentObject(state: Record<string, unknown> | undefined): boolean {
  const raw = state?.content;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return typeof (raw as { kind?: unknown }).kind === 'string';
}

/**
 * Query the items container for everything a provider could back.
 *
 * The Cosmos client is imported DYNAMICALLY, matching `persistAutoBindPatch` in
 * the sibling module: a caller that injects `loadItems` (every unit test, and
 * any future caller with its own enumeration) then never loads it at all.
 */
async function loadSweepItems(o: {
  itemTypes: string[];
  workspaceId?: string;
  limit: number;
}): Promise<WorkspaceItem[]> {
  const { itemsContainer } = await import('@/lib/azure/cosmos-client');
  const container = await itemsContainer();
  const where = ['ARRAY_CONTAINS(@types, c.itemType)'];
  const parameters: SqlParameter[] = [{ name: '@types', value: o.itemTypes }];
  if (o.workspaceId) {
    where.push('c.workspaceId = @ws');
    parameters.push({ name: '@ws', value: o.workspaceId });
  }
  const { resources } = await container.items
    .query<WorkspaceItem>({
      query: `SELECT TOP @limit c.id, c.workspaceId, c.itemType, c.displayName, c.state
              FROM c WHERE ${where.join(' AND ')}`,
      parameters: [...parameters, { name: '@limit', value: o.limit }],
    })
    .fetchAll();
  return resources;
}

function row(
  item: WorkspaceItem,
  provider: string | null,
  backingName: string | null,
  disposition: SweepDisposition,
  reason: string,
): SweepRow {
  return {
    itemId: item.id,
    workspaceId: item.workspaceId,
    itemType: item.itemType,
    displayName: item.displayName || '',
    provider,
    backingName,
    disposition,
    reason,
  };
}

/**
 * Classify one item WITHOUT writing anything.
 *
 * Mirrors `maybeRepairSeed`'s guard ORDER exactly, including its cheapness
 * property: a `seeded:true` item returns before any network call, so a healthy
 * estate costs the sweep almost nothing.
 */
async function previewOne(
  item: WorkspaceItem,
  providers: readonly AutoBindProvider[],
): Promise<SweepRow> {
  const ctx = autoBindContextFromItem(item);
  const provider = resolveAutoBindProvider(ctx, providers);
  if (!provider) {
    return row(item, null, null, 'unsupported', `No registered provider claims item type '${item.itemType}'.`);
  }

  // Guard 1 — provenance says the content was authored. Zero control-plane calls.
  const record = readAutoBindRecord(item.state as Record<string, unknown> | undefined);
  if (record?.seeded === true) {
    return row(item, provider.provider, record.backingName, 'already-healthy',
      'state.autoBind.seeded is true — the backing object was authored on a previous bind.');
  }

  // Guard 2 — the provider cannot answer "is it empty?", so repair never reaches it.
  if (!provider.seedFromContent || !provider.isEmpty) {
    return row(item, provider.provider, record?.backingName ?? null, 'no-empty-probe',
      `Provider '${provider.provider}' implements no isEmpty probe, so the engine's repair path cannot `
      + 'evaluate it. Reasoned opt-out in ISEMPTY_OPT_OUTS; wiring tracked in #3694.');
  }

  const pre = await provider.preflight(ctx);
  if (!pre.ok) {
    return row(item, provider.provider, null, pre.kind === 'retry' ? 'retry' : 'unavailable', pre.reason);
  }

  const target = provider.backingNameFor(ctx);
  const name = record?.backingName || provider.existingBinding?.(ctx) || target.name;
  if (!(await provider.probe(name, pre.coords, ctx))) {
    return row(item, provider.provider, name, 'missing',
      'No backing object of that name exists. A live sweep would create it and seed any authored content.');
  }

  if (!(await provider.isEmpty(name, pre.coords, ctx))) {
    return row(item, provider.provider, name, 'has-content',
      'The backing object already holds content. Repair refuses to touch it.');
  }

  if (!carriesContentObject(item.state as Record<string, unknown> | undefined)) {
    return row(item, provider.provider, name, 'no-authored-content',
      'The backing object is empty and the item carries no content to author — for a blank item this is '
      + 'the CORRECT state, not a defect.');
  }

  return row(item, provider.provider, name, 'would-repair',
    'The backing object is empty and the item carries authored content. A live sweep would seed it.');
}

/**
 * Run the repair for one item by delegating the ACTION wholly to the engine.
 *
 * Classification comes from `previewOne` — the same read-only pass dry-run uses
 * — and only rows that need something from the engine are handed to
 * `autoBindOnOpen`: `would-repair` and `missing` for the action, `has-content`
 * for the provenance stamp alone. Everything else is returned as measured.
 *
 * That is not the sweep second-guessing the engine; deciding WHICH items to
 * hand over is the sweep's entire job. Three things fall out of it:
 *
 *   - Dry-run and live agree BY CONSTRUCTION on every non-actionable row, since
 *     one function produces both. They cannot drift.
 *   - The safety case costs one read and zero engine round-trips.
 *   - `has-content` stays distinguishable from `no-authored-content`. The engine
 *     deliberately collapses them — `maybeRepairSeed` returns
 *     `{seeded:true, detail:'backing object already holds content'}` when it
 *     REFUSES, which is right for the editor (it clears a stale seedError) and
 *     wrong for a report: classifying that as `repaired` would inflate the
 *     headline count with items nothing was written to.
 */
async function repairOne(
  item: WorkspaceItem,
  providers: readonly AutoBindProvider[],
): Promise<SweepRow> {
  const preview = await previewOne(item, providers);
  const actionable = preview.disposition === 'would-repair' || preview.disposition === 'missing';
  if (!actionable && preview.disposition !== 'has-content') {
    return preview;
  }

  const { outcome } = await autoBindOnOpen(item, undefined, { providers });

  // `has-content` is handed over for its SIDE EFFECT, not for a verdict. The
  // engine's refusal stamps `seeded:true` ("stops every later open paying for
  // this probe" — its words), which is what makes each sweep pass strictly
  // cheaper than the last. But the verdict stays the one WE measured: the
  // engine reports that refusal as `seeded:true`, and reading that back as
  // `repaired` would credit the sweep with a write it did not make.
  if (!actionable) return preview;

  if (outcome.status === 'unsupported') {
    return row(item, preview.provider, null, 'unsupported', 'The engine resolved no provider for this item.');
  }
  if (outcome.status === 'unavailable') {
    return row(item, outcome.provider, null, 'unavailable', outcome.reason);
  }
  if (outcome.status === 'retry') {
    return row(item, outcome.provider, null, 'retry', outcome.reason);
  }

  const r = outcome.record;
  if (r.seedError) {
    return row(item, r.provider, r.backingName, 'seed-failed', r.seedError);
  }

  // The reason is always the ENGINE's own `seedDetail`, never a sentence of
  // ours describing what we assume it did. If the object gained content between
  // the preview and the act, the engine refuses and its detail says so verbatim
  // — the row stays readable rather than silently asserting a write we did not
  // make. The invariant itself is the engine's and holds either way.
  const created = r.via === 'created' || r.via === 'recreated';
  if (r.seeded === true) {
    return row(item, r.provider, r.backingName, created ? 'created' : 'repaired',
      r.seedDetail || (created ? 'Backing object created and seeded.' : 'Authored content written into the empty backing object.'));
  }
  return row(item, r.provider, r.backingName, 'no-authored-content',
    r.seedDetail
    || (created
      ? 'The engine created the backing object and found no authored content of a kind this provider seeds.'
      : 'The engine found no authored content of a kind this provider seeds — for a blank item this is the '
        + 'CORRECT state, not a defect.'));
}

/**
 * Sweep every auto-bindable item, repairing empty backing objects.
 *
 * Sequential by design. A healthy item costs zero control-plane calls (guard 1),
 * so the expensive rows are exactly the broken ones, and serializing them keeps
 * a large estate from throttling the ADF control plane — the failure mode that
 * would turn a repair pass into a self-inflicted outage.
 */
export async function sweepAutoBind(opts: SweepOptions): Promise<SweepResult> {
  const providers = opts.providers ?? AUTO_BIND_PROVIDERS;
  const now = opts.now ?? (() => Date.now());
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const allTypes = sweepableItemTypes(providers);
  const itemTypes = opts.itemTypes?.length
    ? allTypes.filter((t) => opts.itemTypes!.includes(t))
    : allTypes;

  const rows: SweepRow[] = [];
  let truncated = false;
  let truncatedBy: SweepResult['truncatedBy'];

  if (itemTypes.length === 0) {
    return { dryRun: opts.dryRun, scanned: 0, byDisposition: {}, rows, truncated: false };
  }

  // Ask for one more than the cap so a full page is distinguishable from an
  // exactly-full estate. Reporting a truncated scan as complete is the whole
  // class of defect this repo keeps re-learning.
  const load = opts.loadItems ?? loadSweepItems;
  const items = await load({ itemTypes, workspaceId: opts.workspaceId, limit: limit + 1 });
  const scanList = items.slice(0, limit);
  if (items.length > limit) {
    truncated = true;
    truncatedBy = 'limit';
  }

  for (const item of scanList) {
    if (now() >= deadline) {
      truncated = true;
      truncatedBy = 'deadline';
      break;
    }
    try {
      rows.push(opts.dryRun ? await previewOne(item, providers) : await repairOne(item, providers));
    } catch (e) {
      // One item's failure must never abort the sweep — the backlog is exactly
      // the population most likely to throw.
      rows.push(row(item, null, null, 'failed', e instanceof Error ? e.message : String(e)));
    }
  }

  const byDisposition: Record<string, number> = {};
  for (const r of rows) byDisposition[r.disposition] = (byDisposition[r.disposition] || 0) + 1;

  return { dryRun: opts.dryRun, scanned: rows.length, byDisposition, rows, truncated, truncatedBy };
}
