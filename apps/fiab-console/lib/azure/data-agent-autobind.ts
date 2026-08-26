/**
 * AUTO-BIND for `data-agent` — the agent's grounding SOURCE is attached by the
 * platform, not typed in by the user.
 *
 * The rule this implements: `.claude/rules/auto-bind-by-default.md`, whose
 * "Explicitly forbidden" list names this exact shape:
 *
 *     "'No pipelines found' + a disabled Bind button — i.e. a dead end."
 *
 * The live defect it closes: #4092. A saved `data-agent` in a workspace that
 * DID contain a compatible warehouse rendered Type=Warehouse, Item="None
 * found", and a disabled **Add** — a dead end with no route to a bound agent.
 * The picker's render defect is fixed separately (its GET never projected
 * `workspaceId`, so the candidate fetch never ran at all); THIS module is the
 * stronger half of the rule: the picker should be there to CHANGE the source,
 * not to make the binding in the first place.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN `AutoBindProvider`
 * ---------------------------------------------------------------------------
 *
 * `./auto-bind.ts` binds a Loom item to an AZURE CONTROL-PLANE OBJECT it can
 * `probe` and, failing that, `create` (an ADF pipeline, an ADLS container, an
 * ADX database). A data-agent has no such object: it is grounded on SIBLING
 * LOOM ITEMS that already exist in its workspace. There is nothing to create —
 * and manufacturing a warehouse as a side effect of creating an agent would be
 * a surprising, cost-material act, which is precisely what the provider
 * contract's mandatory `create()` would force. So the binding is attach-only
 * and lives here.
 *
 * What it DOES borrow from the engine is the inspectability contract
 * (`auto-bind-by-default.md` §2 — "recorded in the item's state so the mapping
 * is inspectable, never guessed"): the choice is written to `state.autoBind` in
 * the SAME {@link AutoBindRecord} shape, so `readAutoBindRecord` parses it and
 * support can read the mapping without re-deriving it.
 *
 * ---------------------------------------------------------------------------
 * WHEN IT RUNS, AND WHEN IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 *   RUNS   at item CREATE (rule §1 — "Creating a Loom item PROVISIONS AND BINDS
 *          its backing resource. No second step, no wizard the user must
 *          find."), and on the editor's OPEN read for an agent that predates
 *          this code — which is the reported population.
 *
 *   DOES NOT RUN once it has run before. Provenance under
 *          `state.autoBind.provider === 'data-agent-source'` retires it
 *          permanently. An agent whose sources are empty because the USER
 *          removed them is a deliberate state, and re-attaching underneath them
 *          on every open would be the platform arguing with the operator. That
 *          leaves no dead end, because with the render defect fixed the picker
 *          lists every compatible item and Add is live.
 *
 *   DOES NOT RUN when the agent already has sources — it never edits, reorders,
 *          or replaces a binding a user or a bundle established.
 *
 * NEVER THROWS. A create or an editor open must not fail because Cosmos
 * hiccuped; the caller gets `null` and the surface is unchanged.
 *
 * Server-only: reads and writes Cosmos. Never import from a client component.
 */
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { DaSourceType } from '@/lib/editors/_family-utils';
import { AUTO_BIND_STATE_KEY, readAutoBindRecord, persistAutoBindPatch, type AutoBindRecord } from './auto-bind';

/** Provider key stamped on `state.autoBind.provider` by this module. */
export const DA_AUTO_BIND_PROVIDER = 'data-agent-source';

/** The `state` key holding the agent's typed grounding sources. */
export const DA_SOURCES_STATE_KEY = 'sources';

/**
 * The item types a data-agent is auto-bound to, IN PRECEDENCE ORDER, paired
 * with the `DaSourceType` the editor and the executor use for each.
 *
 * WHY THESE FOUR AND NOT THE FULL PICKER LIST. The picker also offers
 * `ai-search-index`, `ontology`, `graph-model` and `loom-app-runtime`. Those
 * are deliberately NOT auto-bound: each is a specialised grounding mode whose
 * usefulness depends on intent the platform cannot infer (which index, which
 * object type, which deployed app), and silently attaching a hosted agent as a
 * new agent's default source would be a surprising choice presented as a
 * platform decision. The four below are the "query the data" sources with real
 * NL2SQL / NL2KQL execution paths, where "ground this agent on the data in its
 * own workspace" is unambiguous. All the rest remain one click away in the
 * picker — which, post-#4092, actually lists them.
 *
 * ORDER IS THE TIE-BREAK, and it is the point: the precedence must be a stated
 * rule rather than "whatever Cosmos returned first", so the same workspace
 * always produces the same binding.
 */
export const DA_AUTO_BIND_TYPES: readonly { itemType: string; sourceType: DaSourceType }[] = [
  { itemType: 'warehouse', sourceType: 'warehouse' },
  { itemType: 'lakehouse', sourceType: 'lakehouse' },
  { itemType: 'semantic-model', sourceType: 'semantic-model' },
  { itemType: 'kql-database', sourceType: 'kql' },
];

/** The item facts the pick needs. Deliberately not the whole `WorkspaceItem`. */
export interface DaBindCandidate {
  id: string;
  itemType: string;
  displayName: string;
  /** ISO-8601. Absent sorts LAST, so an undated row never displaces a dated one. */
  createdAt?: string;
}

/** The typed source shape the editor renders and the executor resolves. */
export interface DaBoundSource {
  id: string;
  type: DaSourceType;
  name: string;
  tables: string;
  description: string;
  instructions: string;
  examples: { question: string; query: string }[];
}

/** Matches the editor's `DA_INSTRUCTION_TEMPLATE` so an auto-bound source and a
 *  hand-added one are indistinguishable in the Build tab. */
const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';

/**
 * THE DETERMINISTIC CHOICE (rule §2; issue #4092 acceptance 3).
 *
 * Pure, so the rule is testable without Cosmos. Given every compatible item in
 * the workspace, pick exactly one:
 *
 *   1. the highest-precedence ITEM TYPE present in {@link DA_AUTO_BIND_TYPES} —
 *      a warehouse outranks a lakehouse outranks a semantic model outranks a
 *      KQL database, regardless of how many of the lower kinds exist;
 *   2. within that type, the EARLIEST `createdAt` — the workspace's established
 *      source, not whichever one was made most recently;
 *   3. ties broken lexicographically by `id`, which is a total order, so there
 *      is no input for which this function has to guess.
 *
 * Returns null when the workspace holds nothing compatible — an honest "there
 * is nothing to bind", never an invented binding.
 */
export function pickAutoBindCandidate(candidates: readonly DaBindCandidate[]): DaBindCandidate | null {
  for (const { itemType } of DA_AUTO_BIND_TYPES) {
    const ofType = candidates.filter((c) => c && c.itemType === itemType && typeof c.id === 'string' && c.id);
    if (ofType.length === 0) continue;
    const sorted = [...ofType].sort((a, b) => {
      // An absent createdAt must sort LAST, not first: '' would win every
      // comparison against a real ISO timestamp and make an undated row
      // displace the workspace's genuinely-oldest source.
      const ac = a.createdAt || '￿';
      const bc = b.createdAt || '￿';
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return sorted[0];
  }
  return null;
}

/**
 * Build the typed source entry for a chosen candidate.
 *
 * The `id` is `<sourceType>:<itemId>:auto`. THE THIRD SEGMENT IS LOAD-BEARING,
 * not decoration: `data-agent-execute` recovers a semantic model's item id with
 * `/^semantic-model:([^:]+):/`, which requires a trailing colon, so a two-part
 * id would silently fail to resolve. The editor's hand-add path uses
 * `Date.now()` there; a FIXED `auto` marker is used instead so the same
 * workspace produces a byte-identical binding on every run (idempotent) and so
 * an auto-bound source is self-describing in the persisted document.
 */
export function buildAutoBoundSource(candidate: DaBindCandidate): DaBoundSource | null {
  const entry = DA_AUTO_BIND_TYPES.find((t) => t.itemType === candidate.itemType);
  if (!entry) return null;
  return {
    id: `${entry.sourceType}:${candidate.id}:auto`,
    type: entry.sourceType,
    name: candidate.displayName || candidate.id,
    tables: '',
    description: '',
    instructions: DA_INSTRUCTION_TEMPLATE,
    examples: [],
  };
}

/** The inspectable provenance record for an auto-bound source. */
export function buildAutoBindRecord(
  candidate: DaBindCandidate,
  workspaceId: string,
  now: Date = new Date(),
): AutoBindRecord {
  const entry = DA_AUTO_BIND_TYPES.find((t) => t.itemType === candidate.itemType);
  return {
    provider: DA_AUTO_BIND_PROVIDER,
    backingName: candidate.displayName || candidate.id,
    sourceName: candidate.displayName || candidate.id,
    sanitized: false,
    // 'attached' is the truthful verb: the item already existed and we bound to
    // it. Nothing was created, so 'created'/'recreated' would be a false claim
    // in a record support reads (deploy-integrity.md R7).
    via: 'attached',
    boundAt: now.toISOString(),
    coords: {
      workspaceId,
      itemId: candidate.id,
      itemType: candidate.itemType,
      ...(entry ? { sourceType: entry.sourceType } : {}),
    },
  };
}

/**
 * True when this agent is eligible for auto-bind — i.e. it has no sources AND
 * auto-bind has not already run for it. Exported so the decision is testable on
 * its own and so both call sites (create, open) apply the identical rule.
 *
 * `sources` is checked defensively: a legacy record can persist it as a STRING
 * (the `eo.map is not a function` shape `normalizeDaSources` exists for). A
 * non-empty string IS a binding, so it blocks auto-bind exactly as an array
 * would; only an absent / empty / structurally-unusable value is eligible.
 */
export function shouldAutoBindSources(state: Record<string, unknown> | undefined): boolean {
  const s = state || {};
  const raw = s[DA_SOURCES_STATE_KEY];
  if (Array.isArray(raw)) {
    if (raw.length > 0) return false;
  } else if (typeof raw === 'string') {
    if (raw.trim()) return false;
  } else if (raw && typeof raw === 'object') {
    // An object is not a source list, but it is not "nothing" either — refuse to
    // overwrite a shape we do not understand.
    return false;
  }
  const prior = readAutoBindRecord(s);
  if (prior?.provider === DA_AUTO_BIND_PROVIDER) return false;
  return true;
}

/** Injection seam so the unit tests exercise the real logic with no Cosmos. */
export interface DataAgentAutoBindOptions {
  /** Override the workspace candidate lookup (tests). */
  listCandidates?: (workspaceId: string) => Promise<DaBindCandidate[]>;
  /** Override the persist (tests). Return false to simulate a failed write. */
  persist?: (itemId: string, workspaceId: string, patch: Record<string, unknown>) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Every item in `workspaceId` whose type this module can bind. Partition-keyed
 * on `workspaceId` (the `items` container is partitioned by `/workspaceId`), so
 * this touches exactly one partition and cannot see a sibling workspace's
 * items — the cross-workspace leak `by-type` documents at length.
 *
 * Recycle-bin items are excluded with the same predicate every other list uses:
 * binding an agent to a deleted warehouse would be a binding that resolves to
 * nothing.
 */
async function listWorkspaceCandidates(workspaceId: string): Promise<DaBindCandidate[]> {
  const { itemsContainer } = await import('@/lib/azure/cosmos-client');
  const items = await itemsContainer();
  const types = DA_AUTO_BIND_TYPES.map((t) => t.itemType);
  const orClauses = types.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const { resources } = await items.items
    .query<DaBindCandidate>(
      {
        query:
          `SELECT c.id, c.itemType, c.displayName, c.createdAt FROM c ` +
          `WHERE (${orClauses}) AND c.workspaceId = @w ` +
          `AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)`,
        parameters: [
          ...types.map((t, i) => ({ name: `@t${i}`, value: t })),
          { name: '@w', value: workspaceId },
        ],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  return resources || [];
}

/** What one auto-bind attempt did. */
export interface DataAgentAutoBindResult {
  source: DaBoundSource;
  record: AutoBindRecord;
  /** The state fields to merge — already applied to the item passed in. */
  statePatch: Record<string, unknown>;
  /** True when the patch reached Cosmos. False = in-memory only (see below). */
  persisted: boolean;
}

/**
 * Bind a data-agent to its workspace's compatible source, if it needs one.
 *
 * Returns null — and changes nothing — when the agent is ineligible
 * ({@link shouldAutoBindSources}), when the workspace holds nothing compatible,
 * or when anything at all goes wrong.
 *
 * MUTATES `item.state` IN MEMORY even when the Cosmos write fails, deliberately
 * and for the same reason `autoBindOnOpen` does (`auto-bind.ts`): the GET that
 * triggered this is about to serialise `item.state` into the editor's own load
 * response, and returning the pre-bind state after a successful bind would
 * render the dead end this exists to remove. The write is retried implicitly by
 * the next open, because the decision is a pure function of the workspace.
 *
 * AUTHORIZATION: performs none. Both call sites reach it only after
 * `loadOwnedItem` / `createOwnedItem` has authorized the caller for this item,
 * and every candidate is inside that same already-authorized workspace.
 */
export async function autoBindDataAgentSources(
  item: WorkspaceItem,
  opts: DataAgentAutoBindOptions = {},
): Promise<DataAgentAutoBindResult | null> {
  try {
    if (!item || item.itemType !== 'data-agent') return null;
    if (!item.workspaceId || !item.id) return null;
    const state = (item.state || {}) as Record<string, unknown>;
    if (!shouldAutoBindSources(state)) return null;

    const list = opts.listCandidates ?? listWorkspaceCandidates;
    const candidates = await list(item.workspaceId);
    const chosen = pickAutoBindCandidate(candidates || []);
    if (!chosen) return null;

    const source = buildAutoBoundSource(chosen);
    if (!source) return null;
    const record = buildAutoBindRecord(chosen, item.workspaceId, (opts.now ?? (() => new Date()))());

    const statePatch: Record<string, unknown> = {
      [DA_SOURCES_STATE_KEY]: [source],
      [AUTO_BIND_STATE_KEY]: record,
    };
    item.state = { ...state, ...statePatch };

    const persist = opts.persist ?? persistAutoBindPatch;
    const persisted = await persist(item.id, item.workspaceId, statePatch);
    return { source, record, statePatch, persisted };
  } catch {
    // Never fatal: an item create and an editor open must both survive a Cosmos
    // hiccup. The next open re-derives the identical binding.
    return null;
  }
}
