/**
 * Resolve an attached-lakehouse item to the canonical
 *   abfss://<container>@<account>.dfs.core.windows.net/<root>
 * URI of its ADLS Gen2 root, so the notebook Spark-session auto-mount preamble
 * (and the editor's attached-sources list) can hand the user a ready-to-use,
 * REAL storage path — never a guessed one (no-vaporware.md).
 *
 * The lakehouse → storage mapping is non-trivial: in an Azure-native Loom a
 * lakehouse is materialised in the internal DLZ ADLS Gen2 (the
 * bronze/silver/gold/landing containers behind LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL)
 * either by lib/install/provisioners/lakehouse.ts (the installer) or by
 * `lakehouseAutoBind` (lib/azure/auto-bind-providers.ts — New item), and each
 * records the exact container + root it chose. We resolve from that record, in
 * priority order:
 *
 *   1. state.provisioning.secondaryIds.adlsRoot — the full abfss URI the
 *      provisioner already built via resolveAbfssRoot() at create time. This is
 *      the most accurate (exact container chosen) AND sovereign-cloud-correct
 *      (the DFS host was parsed from the configured LOOM_*_URL). Preferred.
 *   2. state.provisioning.secondaryIds.{container, rootPath} — re-derive the
 *      abfss via resolveAbfssRoot() from the recorded container + root. Honours
 *      an explicit state.storageAccount when the lakehouse owns an external
 *      account.
 *   2c. state.{adlsContainer, lakehouseRoot} — the binding AUTO-BIND persisted
 *      when the item was created (`lakehouseAutoBind.stateKeys`). #4759: this
 *      step did not exist, so every lakehouse created through New item
 *      (auto-bind roots it in `landing`) fell through to step 3, which answered
 *      `bronze`, and the editor's first open 404'd on a directory that was
 *      never there.
 *      For an item created on or after `LAKEHOUSE_ITEM_ROOT_SINCE` the
 *      recorded root must also be THIS item's own root shape
 *      (`lakehouseItemRootPath`: one segment ending in `--<item id>`, or the
 *      bare id); anything else falls through to step 3.
 *   3. No persisted binding — FIND the root rather than guess it (#4759,
 *      auto-bind-by-default.md rule 3). The root is
 *      `lakehouseItemRootPath(displayName, id)` for an item created on or after
 *      `LAKEHOUSE_ITEM_ROOT_SINCE`, else the name-only
 *      `lakehouseRootPath(displayName, id)` that item already has. A directory
 *      is adopted only when its ownership marker (`LAKEHOUSE_OWNER_METADATA_KEY`)
 *      allows it: an item root must carry THIS item's id; a name-only root may
 *      carry this item's id or no marker (roots written before markers existed),
 *      never another item's id. Containers are probed in order and the first
 *      that holds an adoptable root wins:
 *        a. the LEGACY answer — the first configured (+ owned) container, i.e.
 *           exactly what this step returned before #4759. Lakehouses created
 *           before auto-bind existed (2026-08-22) were materialised there,
 *           normally `bronze`; probing it first means no such item changes
 *           container because of this fix.
 *        b. then `lakehouseContainerOrder` (lib/azure/backing-name.ts) — the
 *           SAME order auto-bind creates in (`landing` first), which finds a
 *           post-08-22 root whose binding never reached Cosmos (create-time
 *           deadline, a save that dropped it). When the item declares
 *           `ownedContainers`, the owned order is kept instead, unchanged
 *           from before #4759.
 *      Nothing found anywhere → the first container of that order that does
 *      not hold another item's directory at that path, so the resolver and the
 *      creator agree on a lakehouse with no root yet. A probe
 *      that FAILS (403, network, or the PROBE_TIMEOUT_MS bound) stops the walk
 *      and returns the legacy answer: a failed probe establishes nothing, so it
 *      must not move an item to a different container. No LOOM_*_URL
 *      configured at all → null, and no probe is made.
 *
 *      A NAME-ONLY ROOT IS SHARED-CHECKED. A name-only root is derived from the
 *      display name, which can change, and an unmarked directory says nothing
 *      about who wrote it. So before a pre-cutover item uses a name-only root
 *      (adopted OR chosen as the fallback), the resolver reads every other
 *      lakehouse's root (`listLakehouseRootFacts`, recorded or derived) and
 *      does not use a container where one of them overlaps this root
 *      segment-wise. If that read fails, no name-only root is used: an unknown
 *      answer is not a "no". Item roots skip this, being unique by
 *      construction. Lakehouses left without a root this way are the ones the
 *      readiness check `lakehouse-shared-roots` lists for an admin.
 *
 *      WHEN STEP 3 RUNS AGAIN. The probe result is persisted ONLY when a root
 *      was FOUND and the caller passed `{ persist: true }`; the next resolve
 *      then takes step 2c. In every other case — nothing found, a probe
 *      failed, or the caller did not opt in — nothing is written and the next
 *      resolve probes again: at most one HEAD per configured container, each
 *      bounded by PROBE_TIMEOUT_MS, and the walk stops at the first failure.
 *
 * Returns null (caller skips the source silently — honest gate) when the
 * lakehouse can't be found, isn't a lakehouse, or no storage env is configured.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  KNOWN_CONTAINERS,
  getServiceClient,
  resolveAbfssRoot,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import {
  lakehouseContainerOrder,
  lakehouseItemRootPath,
  lakehouseRootLocation,
  lakehouseRootPath,
  lakehouseRootsOverlap,
  lakehouseUsesItemRoot,
  LAKEHOUSE_OWNER_METADATA_KEY,
  LAKEHOUSE_ROOT_PREFIX,
  safeAdlsRelPath,
  type LakehouseRootFacts,
  type LakehouseRootLocation,
} from '@/lib/azure/backing-name';
import { trimSlashes } from '@/lib/util/trim';

const CONTAINER_URL_ENV: Record<KnownContainer, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
  'csv-imports': 'LOOM_CSV_IMPORTS_URL',
};

/**
 * Per-probe bound for step 3, matching `listContainers` in adls-client.ts:
 * without an abort signal a HEAD against an unreachable account retries with
 * backoff and hangs, and several callers resolve lakehouses in series.
 */
export const PROBE_TIMEOUT_MS = 6000;

function isKnownContainer(name: string): name is KnownContainer {
  return (KNOWN_CONTAINERS as readonly string[]).includes(name);
}

/** DLZ containers that have a configured LOOM_*_URL env (and, if the
 *  lakehouse declares ownedContainers, that it actually owns), in
 *  `KNOWN_CONTAINERS` order — or in `owned` order when that is declared.
 *  Element [0] is the pre-#4759 step-3 answer. */
function configuredCandidates(owned?: string[]): KnownContainer[] {
  const candidates = (Array.isArray(owned) && owned.length
    ? owned.filter(isKnownContainer)
    : [...KNOWN_CONTAINERS]) as KnownContainer[];
  return candidates.filter((c) => !!process.env[CONTAINER_URL_ENV[c]]);
}

/**
 * Is `root` a path auto-bind could have written as `lakehouseRoot`? Step 2c
 * accepts exactly the shape `lakehouseRootPath` produces —
 * `lakehouses/<sanitised segments>`, a fixpoint of `safeAdlsRelPath` — and
 * nothing else. Any other value is not a binding auto-bind wrote, so the
 * resolver falls through to step 3 and derives the root from the item's name.
 */
function isLakehouseRootShape(root: string): boolean {
  if (!root.startsWith(LAKEHOUSE_ROOT_PREFIX)) return false;
  if (root.length <= LAKEHOUSE_ROOT_PREFIX.length) return false;
  return safeAdlsRelPath(root) === root;
}

/**
 * Is `root` this item's own item-unique root — `lakehouses/<name>--<itemId>` or
 * `lakehouses/<itemId>`, one segment, as {@link lakehouseItemRootPath} builds?
 */
export function isItemRootOf(root: string, itemId: string): boolean {
  if (!itemId || !isLakehouseRootShape(root)) return false;
  const seg = root.slice(LAKEHOUSE_ROOT_PREFIX.length);
  if (seg.includes('/')) return false;
  return seg === itemId || seg.endsWith(`--${itemId}`);
}

/** The ownership marker of a lakehouse root directory, as read from ADLS. */
export type LakehouseRootOwner =
  | { exists: false }
  /** `owner` is null when the directory carries no marker. */
  | { exists: true; owner: string | null };

/**
 * Read `root` in `container` and its ownership marker. A definite answer is
 * returned; THROWS when the answer is unknown (403, network, or the
 * PROBE_TIMEOUT_MS abort). `getMetadata` is not used because it takes no abort
 * signal; `getProperties` returns the metadata in the same call.
 */
export async function readLakehouseRootOwner(container: string, root: string): Promise<LakehouseRootOwner> {
  try {
    const props = await getServiceClient()
      .getFileSystemClient(container)
      .getFileClient(root)
      .getProperties({ abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const meta = ((props as { metadata?: Record<string, string | undefined> } | undefined)?.metadata || {});
    let owner: string | null = null;
    for (const [k, v] of Object.entries(meta)) {
      if (k.toLowerCase() === LAKEHOUSE_OWNER_METADATA_KEY && typeof v === 'string' && v) { owner = v; break; }
    }
    return { exists: true, owner };
  } catch (e: any) {
    if (e?.statusCode === 404) return { exists: false };
    throw e;
  }
}

/**
 * Create a lakehouse root directory carrying this item's ownership marker. The
 * create is conditional (`If-None-Match: *`), so it never re-marks or replaces a
 * directory that already exists: a 409/412 means another writer got there
 * first, and the error is rethrown for the caller to report.
 */
export async function createOwnedLakehouseRoot(container: string, root: string, itemId: string): Promise<void> {
  await getServiceClient()
    .getFileSystemClient(container)
    .getDirectoryClient(root)
    .create({
      metadata: { [LAKEHOUSE_OWNER_METADATA_KEY]: itemId },
      conditions: { ifNoneMatch: '*' },
    });
}

/**
 * May `lakehouseId` adopt a root directory whose marker is `owner`? An item root
 * must carry this item's id. A name-only root may carry this item's id or no
 * marker at all (it was written before markers existed), never another id.
 */
export function mayAdoptRoot(owner: string | null, lakehouseId: string, itemRoot: boolean): boolean {
  if (owner === lakehouseId) return true;
  return !itemRoot && owner === null;
}

/**
 * Every lakehouse item's root facts (recycled items excluded), read across all
 * workspaces: lakehouses in different workspaces share the same containers.
 * Shared by the resolver's name-root check and the readiness check
 * `lib/admin/env-checks/lakehouse-shared-roots.ts`. Throws on a failed read.
 */
export async function listLakehouseRootFacts(
  items?: Awaited<ReturnType<typeof itemsContainer>>,
): Promise<LakehouseRootFacts[]> {
  const c = items ?? (await itemsContainer());
  const { resources } = await c.items
    .query<LakehouseRootFacts>({
      query:
        'SELECT c.id, c.displayName, c.createdAt, '
        + 'c.state.lakehouseRoot AS lakehouseRoot, c.state.adlsContainer AS adlsContainer, '
        + 'c.state.storageAccount AS storageAccount, '
        + 'c.state.provisioning.secondaryIds.adlsRoot AS provAdlsRoot, '
        + 'c.state.provisioning.secondaryIds.container AS provContainer, '
        + 'c.state.provisioning.secondaryIds.rootPath AS provRootPath '
        + "FROM c WHERE c.itemType = 'lakehouse' "
        + 'AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
      parameters: [],
    })
    .fetchAll();
  return resources;
}

export interface ResolvedLakehouseAbfss {
  /** Full abfss://<container>@<account>.dfs.<suffix>/<root> URI. */
  abfss: string;
  container: string;
  /** Root path inside the container (no leading/trailing slash). */
  root: string;
}

export interface ResolveLakehouseAbfssOptions {
  /**
   * Write a root found by step 3 back onto the item (`state.adlsContainer` +
   * `state.lakehouseRoot`), so later resolves take step 2c. DEFAULT false: a
   * resolve is a read, and it writes nothing unless the caller opts in. Pass
   * true only from a caller that has already resolved its access to the item
   * (`resolveItemAccessByOid`) before calling — today, the item-bound branch
   * of `/api/lakehouse/paths`.
   */
  persist?: boolean;
}

/**
 * Write the found binding onto the item, conditional on the item not having
 * changed since it was read (IfMatch on the `_etag` of that read). A 412 — or
 * any other failure — is swallowed: the answer being returned is already
 * right, and the next resolve probes again.
 */
async function persistFoundBinding(
  items: Awaited<ReturnType<typeof itemsContainer>>,
  lh: WorkspaceItem,
  workspaceId: string,
  container: KnownContainer,
  root: string,
): Promise<void> {
  const etag = (lh as { _etag?: unknown })._etag;
  const next: WorkspaceItem = {
    ...lh,
    state: { ...((lh.state as Record<string, unknown>) || {}), adlsContainer: container, lakehouseRoot: root },
    updatedAt: new Date().toISOString(),
  };
  try {
    await items.item(lh.id, workspaceId).replace<WorkspaceItem>(
      next,
      typeof etag === 'string' && etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
    );
  } catch {
    /* best-effort — see above */
  }
}

/**
 * Read the lakehouse item from Cosmos and return its ADLS Gen2 root as abfss,
 * or null when it can't be resolved against REAL configured storage.
 *
 * @param lakehouseId the attached-source item id
 * @param workspaceId the partition key (the notebook's workspace — the
 *        attached lakehouse lives in the same workspace)
 * @param opts        see {@link ResolveLakehouseAbfssOptions}; default writes nothing
 */
export async function resolveLakehouseAbfss(
  lakehouseId: string,
  workspaceId: string,
  opts: ResolveLakehouseAbfssOptions = {},
): Promise<ResolvedLakehouseAbfss | null> {
  if (!lakehouseId || !workspaceId) return null;
  const items = await itemsContainer();
  let lh: WorkspaceItem | null = null;
  try {
    const { resource } = await items.item(lakehouseId, workspaceId).read<WorkspaceItem>();
    lh = resource && resource.itemType === 'lakehouse' ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  if (!lh) return null;

  const state = (lh.state as Record<string, any>) || {};
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, unknown>;

  // 1. Provisioner already stamped a full abfss root — most accurate + already
  //    sovereign-cloud-correct. Parse out container/root for the editor list.
  const stampedAbfss = typeof sec.adlsRoot === 'string' ? sec.adlsRoot.trim() : '';
  if (stampedAbfss.startsWith('abfss://')) {
    const m = stampedAbfss.match(/^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i);
    return {
      abfss: stampedAbfss,
      container: m?.[1] || (typeof sec.container === 'string' ? sec.container : ''),
      root: trimSlashes((m?.[2] || (typeof sec.rootPath === 'string' ? sec.rootPath : ''))),
    };
  }

  // 2. Re-derive from recorded container + rootPath.
  const recContainer = typeof sec.container === 'string' ? sec.container : '';
  const recRoot = typeof sec.rootPath === 'string' ? sec.rootPath : '';
  if (recContainer && recRoot && isKnownContainer(recContainer)) {
    const abfss = resolveAbfssRoot(recContainer, recRoot);
    if (abfss) return { abfss, container: recContainer, root: trimSlashes(recRoot) };
  }

  // 2b. Lakehouse bound to an explicit external storage account (state.storageAccount).
  const explicitAccount = typeof state.storageAccount === 'string' ? state.storageAccount.trim() : '';
  if (explicitAccount && recContainer && recRoot) {
    const clean = trimSlashes(recRoot);
    return {
      abfss: `abfss://${recContainer}@${explicitAccount}.${dfsSuffix()}/${clean}`,
      container: recContainer,
      root: clean,
    };
  }

  // 2c. The binding auto-bind persisted on create (#4759): a configured DLZ
  //     container and a root of the exact shape auto-bind writes.
  const boundContainer = typeof state.adlsContainer === 'string' ? state.adlsContainer.trim() : '';
  const boundRoot = typeof state.lakehouseRoot === 'string' ? state.lakehouseRoot.trim() : '';
  const itemRootEra = lakehouseUsesItemRoot(lh.createdAt);
  if (
    boundContainer && boundRoot && isKnownContainer(boundContainer) && isLakehouseRootShape(boundRoot)
    && (!itemRootEra || isItemRootOf(boundRoot, lh.id))
  ) {
    const abfss = resolveAbfssRoot(boundContainer, boundRoot);
    if (abfss) return { abfss, container: boundContainer, root: boundRoot };
  }

  // 3. No persisted binding: probe for the root (see the header for the order,
  //    for which items each probe exists to find, and for when it re-runs).
  const owned = Array.isArray(state.ownedContainers) ? (state.ownedContainers as string[]) : undefined;
  const ownedDeclared = !!owned && owned.length > 0;
  const candidates = configuredCandidates(owned);
  const legacy = candidates[0];
  if (legacy) {
    const root = itemRootEra
      ? lakehouseItemRootPath(lh.displayName || '', lh.id)
      : lakehouseRootPath(lh.displayName || '', lh.id);
    const preferred = (ownedDeclared ? candidates : lakehouseContainerOrder(candidates)) as KnownContainer[];
    const probeOrder = [legacy, ...preferred.filter((c) => c !== legacy)];
    // Name-only roots only: does another lakehouse's root overlap `root` in
    // container `c`? Read once, lazily. A failed read answers "yes" (unknown is
    // not "no"), so no name-only root is used on an unverified answer.
    let others: LakehouseRootLocation[] | null | undefined;
    const sharedWithOther = async (c: KnownContainer): Promise<boolean> => {
      if (itemRootEra) return false;
      if (others === undefined) {
        others = await listLakehouseRootFacts(items)
          .then((rows) => rows
            .filter((r) => r.id !== lh!.id)
            .map(lakehouseRootLocation)
            .filter((l): l is LakehouseRootLocation => !!l))
          .catch(() => null);
      }
      if (others === null) return true;
      const mine: LakehouseRootLocation = {
        id: lh!.id, account: '', container: c, segments: root.split('/').filter(Boolean), recorded: false,
      };
      return others.some((o) => lakehouseRootsOverlap(mine, o));
    };
    let found: KnownContainer | null = null;
    let probeFailed = false;
    // Containers holding a directory at `root` that this item may not adopt.
    const heldByOther = new Set<KnownContainer>();
    for (const c of probeOrder) {
      try {
        const r = await readLakehouseRootOwner(c, root);
        if (!r.exists) continue;
        if (mayAdoptRoot(r.owner, lh.id, itemRootEra) && (r.owner === lh.id || !(await sharedWithOther(c)))) {
          found = c;
          break;
        }
        heldByOther.add(c);
      } catch {
        // Not a 404: this container could not be read (or the probe timed
        // out), so the root cannot be said to be absent from it.
        probeFailed = true;
        break;
      }
    }
    let container: KnownContainer | null = found;
    if (!container) {
      const fallbacks = probeFailed ? [legacy] : preferred;
      for (const c of fallbacks) {
        if (heldByOther.has(c)) continue;
        if (await sharedWithOther(c)) continue;
        container = c;
        break;
      }
    }
    if (!container) return null;
    const abfss = resolveAbfssRoot(container, root);
    if (abfss) {
      if (found && opts.persist === true) {
        await persistFoundBinding(items, lh, workspaceId, found, root);
      }
      return { abfss, container, root };
    }
  }

  // No real configured storage — honest gate: caller skips this source.
  return null;
}
