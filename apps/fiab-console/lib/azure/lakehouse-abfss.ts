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
 *      when the item was created (`lakehouseAutoBind.stateKeys`), or that an
 *      earlier resolve persisted. #4759: this step did not exist, so every
 *      lakehouse created through New item (auto-bind roots it in `landing`)
 *      fell through to step 3, which answered `bronze`, and the editor's first
 *      open 404'd on a directory that was never there.
 *
 *   A RECORDED LOCATION IS DECIDED BY THE RECORD AND THE DIRECTORY, NOT BY THE
 *   ITEM'S AGE (steps 1, 2, 2b and 2c alike):
 *     - the item's own item root (`lakehouseItemRootPath`, ending `--<id>`) is
 *       used with no further read: no other item can hold it;
 *     - a directory marked (`LAKEHOUSE_OWNER_METADATA_KEY`) for this item is used;
 *     - a directory marked for another item is not this item's: the record is
 *       skipped and the next step is tried;
 *     - any other recorded root (unmarked, not created yet, or on an account
 *       whose marker is not read here) is used unless another item also RECORDS
 *       an overlapping root, or it is another item's item root: that is
 *       `root-shared`, and resolution stops. Items that merely share the display
 *       name and never recorded a root do not count. If the other items cannot
 *       be read, the item's own record is kept. A recorded root found to be the
 *       item's alone is stamped with its marker when the caller persists, so
 *       later resolves read no other item.
 *   So an item created by an older build, whose recorded root is name-only,
 *   keeps it, whatever its `createdAt`.
 *
 *   3. No persisted binding — FIND the root rather than guess it (#4759,
 *      auto-bind-by-default.md rule 3). The item's own item root is probed in
 *      each container; an item created before `LAKEHOUSE_ITEM_ROOT_SINCE` also
 *      has its name-only root (`lakehouseRootPath`) probed, since files may sit
 *      there from before item roots existed. `LAKEHOUSE_ITEM_ROOT_SINCE` decides
 *      ONLY that: whether an unrecorded item may have a name-only root.
 *        - item root: adopted when marked for this item or unmarked (its path
 *          carries the id; a first write creates it with no marker);
 *        - name-only root: adopted when marked for this item; `root-shared` when
 *          marked for another; when unmarked, adopted only if no other
 *          lakehouse's root (recorded, or derived from its name) overlaps it —
 *          else `root-shared`, or `root-unverified` if the others cannot be read.
 *      Containers are probed in order and the first that holds an adoptable
 *      root wins:
 *        a. the LEGACY answer — the first configured (+ owned) container, i.e.
 *           exactly what this step returned before #4759. Lakehouses created
 *           before auto-bind existed (2026-08-22) were materialised there,
 *           normally `bronze`; probing it first means no such item changes
 *           container because of this fix.
 *        b. then `lakehouseContainerOrder` (lib/azure/backing-name.ts) — the
 *           SAME order auto-bind creates in (`landing` first). When the item
 *           declares `ownedContainers`, the owned order is kept instead.
 *      Nothing found anywhere → the item's own item root, in the first container
 *      of that order that does not hold another item's directory there — the
 *      same place auto-bind creates it, so resolver and creator agree. With
 *      `{ persist: true }` it is CREATED then, marked and recorded, so an item
 *      whose create-time auto-bind never ran or timed out has its root from
 *      the first open. A probe that FAILS (403, network, or the
 *      PROBE_TIMEOUT_MS bound) stops the walk and returns the legacy container:
 *      a failed probe establishes nothing, so it must not move an item. No
 *      LOOM_*_URL configured at all → `no-storage`, and no probe is made.
 *
 *   OTHER ITEMS ARE READ ONLY WHEN NEEDED. The cross-item read
 *   (`listLakehouseRootFacts`, recycled items included, since their files stay
 *   until purge) runs for an unmarked recorded root that is not an item root,
 *   and for an unmarked name-only root found in step 3. A recorded item root,
 *   or a marked directory, needs none.
 *
 *   WRITES. With `{ persist: true }` a root found by step 3 is recorded on the
 *   item (conditional on its ETag) and, if unmarked, stamped with the item's
 *   marker; a root chosen with nothing found is created. Without it, nothing is
 *   written and the next resolve probes again: at most two HEADs per configured
 *   container, each bounded by PROBE_TIMEOUT_MS, stopping at the first failure.
 *
 * `resolveLakehouseStorage` returns the location, or the reason there is none
 * (`LakehouseStorageWithheld`: not-found, no-storage, root-shared,
 * root-unverified). `resolveLakehouseAbfss` returns the location or null
 * (caller skips the source silently — honest gate).
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  KNOWN_CONTAINERS,
  getAccountName,
  getServiceClient,
  resolveAbfssRoot,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import {
  isLakehouseItemRootOf,
  isLakehouseRootShape,
  lakehouseContainerOrder,
  lakehouseItemRootPath,
  lakehouseRootLocation,
  lakehouseRootPath,
  lakehouseRootsOverlap,
  lakehouseUsesItemRoot,
  LAKEHOUSE_OWNER_METADATA_KEY,
  type LakehouseRootFacts,
  type LakehouseRootLocation,
} from '@/lib/azure/backing-name';
import { trimSlashes } from '@/lib/util/trim';
import { LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } from '@/lib/admin/env-checks/lakehouse-shared-roots';

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

/** The ownership marker of a lakehouse root directory, as read from ADLS. */
export type LakehouseRootOwner =
  | { exists: false }
  /**
   * `owner` is null when the directory carries no marker. `etag` and `metadata`
   * are what {@link stampLakehouseRootOwner} needs to add a marker without
   * dropping the directory's other metadata or racing another writer.
   */
  | { exists: true; owner: string | null; etag?: string; metadata?: Record<string, string> };

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
    const p = (props || {}) as { metadata?: Record<string, string | undefined>; etag?: string };
    const metadata: Record<string, string> = {};
    let owner: string | null = null;
    for (const [k, v] of Object.entries(p.metadata || {})) {
      if (typeof v !== 'string') continue;
      metadata[k] = v;
      if (k.toLowerCase() === LAKEHOUSE_OWNER_METADATA_KEY && v && owner === null) owner = v;
    }
    return { exists: true, owner, etag: typeof p.etag === 'string' ? p.etag : undefined, metadata };
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
 * Add this item's ownership marker to an EXISTING root directory, keeping its
 * other metadata. Conditional on the ETag of the read that found it unmarked
 * (`If-Match`), so a directory another writer changed in between is left alone.
 * Used only where the caller has established the directory is this item's: its
 * own id-bearing item root, or a recorded root no other item uses. Best-effort:
 * returns false (and changes nothing) without an ETag or on any failure, and
 * the next resolve reaches the same decision again.
 */
export async function stampLakehouseRootOwner(
  container: string,
  root: string,
  itemId: string,
  found: { etag?: string; metadata?: Record<string, string> },
): Promise<boolean> {
  if (!found.etag) return false;
  try {
    await getServiceClient()
      .getFileSystemClient(container)
      .getDirectoryClient(root)
      .setMetadata(
        { ...(found.metadata || {}), [LAKEHOUSE_OWNER_METADATA_KEY]: itemId },
        { conditions: { ifMatch: found.etag }, abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
    return true;
  } catch {
    return false;
  }
}

/**
 * May `lakehouseId` adopt a root directory whose marker is `owner`? Its own
 * marker, or none. An unmarked directory at the item's own id-bearing ITEM root
 * is its own (the path carries the id, so no other item's root is there; a first
 * write creates the directory without a marker). An unmarked NAME-only root is
 * adoptable only after the caller's overlap check. Another item's marker: never.
 */
export function mayAdoptRoot(owner: string | null, lakehouseId: string): boolean {
  return owner === lakehouseId || owner === null;
}

/**
 * Every lakehouse item's root facts, read across all workspaces: lakehouses in
 * different workspaces share the same containers. `includeRecycled` keeps
 * recycled items, whose files remain until they are purged; both the resolver
 * and the readiness check pass it, so a recycled item's root still counts. Each
 * row carries `recycled` so a surface can say which ones those are. Throws on a
 * failed read.
 */
export async function listLakehouseRootFacts(
  items?: Awaited<ReturnType<typeof itemsContainer>>,
  opts: { includeRecycled?: boolean } = {},
): Promise<LakehouseRootFacts[]> {
  const c = items ?? (await itemsContainer());
  const { resources } = await c.items
    .query<LakehouseRootFacts>({
      query:
        'SELECT c.id, c.workspaceId, c.displayName, c.createdAt, '
        + 'c.state.lakehouseRoot AS lakehouseRoot, c.state.adlsContainer AS adlsContainer, '
        + 'c.state.storageAccount AS storageAccount, '
        + 'c.state.provisioning.secondaryIds.adlsRoot AS provAdlsRoot, '
        + 'c.state.provisioning.secondaryIds.container AS provContainer, '
        + 'c.state.provisioning.secondaryIds.rootPath AS provRootPath, '
        + 'c.state._recycled AS recycled '
        + "FROM c WHERE c.itemType = 'lakehouse'"
        + (opts.includeRecycled ? '' : ' AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)'),
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
   * `state.lakehouseRoot`), so later resolves take step 2c; stamp this item's
   * marker on an unmarked root it was found to own; and, when nothing exists
   * yet, create the item's own marked root. DEFAULT false: a resolve is a read,
   * and it writes nothing unless the caller opts in. Pass true only from a
   * caller that has already resolved its access to the item
   * (`resolveItemAccessByOid`) before calling — today, the item-bound branch
   * of `/api/lakehouse/paths`, which is the editor's first request.
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
 * Why a lakehouse has no storage location to hand back:
 *
 *   not-found        the item does not exist in that workspace, or is not a
 *                    lakehouse.
 *   no-storage       no `LOOM_*_URL` container is configured for this
 *                    deployment, so there is nowhere a lakehouse can live.
 *   root-shared      this lakehouse's storage location is also used by another
 *                    lakehouse item: another item records the same (or a nested)
 *                    root, or its directory is marked for another item, or an
 *                    older item's unrecorded name-only root is one another item
 *                    could also be using. Nothing is returned and no other
 *                    container is chosen in its place: the files are where they
 *                    are, and an administrator picks the item that keeps the
 *                    location (Admin > Readiness, "Keep root for ...").
 *   root-unverified  an unrecorded name-only root was found, and the other
 *                    lakehouses could not be read to confirm it is this item's
 *                    alone. An unknown answer is not a "no"; retry. A RECORDED
 *                    root is never withheld for this reason.
 */
export type LakehouseStorageWithheld = 'not-found' | 'no-storage' | 'root-shared' | 'root-unverified';

export type LakehouseStorageResolution =
  | { ok: true; bound: ResolvedLakehouseAbfss }
  | { ok: false; reason: LakehouseStorageWithheld };

/**
 * The user-facing text for a withheld resolution, ONE wording for every route
 * that renders it. `null` for `not-found`, which each route answers with its own
 * 404, and for `no-storage`, which each route already words as its own gate.
 */
export function lakehouseStorageWithheldMessage(reason: LakehouseStorageWithheld): string | null {
  if (reason === 'root-shared') {
    return 'This lakehouse\'s storage location is also used by another item, so Loom is not opening it here. '
      + `An administrator can resolve it in one step: Admin > Readiness lists it under "${LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE}" `
      + 'with the other items that use the same location, and "Keep root for ..." chooses which lakehouse keeps it.';
  }
  if (reason === 'root-unverified') {
    return 'Loom found an older storage folder for this lakehouse but could not confirm that it belongs to this '
      + 'lakehouse alone, because the list of lakehouse items could not be read. Nothing was opened. Retry in a moment.';
  }
  return null;
}

/**
 * Read the lakehouse item from Cosmos and return its ADLS Gen2 root as abfss,
 * or null when it can't be resolved against REAL configured storage. The
 * reason is dropped; callers that show it use {@link resolveLakehouseStorage}.
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
  const r = await resolveLakehouseStorage(lakehouseId, workspaceId, opts);
  return r.ok ? r.bound : null;
}

/** A recorded location, before it is checked against this item. */
interface RecordedCandidate {
  bound: ResolvedLakehouseAbfss;
  /** '' = the primary Loom account, a lower-cased name = another account, null = unknown. */
  account: string | null;
}

/** The primary account's name, lower-cased, or null when none is configured. */
function primaryAccountLower(): string | null {
  try {
    return getAccountName().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * {@link resolveLakehouseAbfss}, with the reason when no location is returned.
 * See the header for the resolution order.
 */
export async function resolveLakehouseStorage(
  lakehouseId: string,
  workspaceId: string,
  opts: ResolveLakehouseAbfssOptions = {},
): Promise<LakehouseStorageResolution> {
  if (!lakehouseId || !workspaceId) return { ok: false, reason: 'not-found' };
  const items = await itemsContainer();
  let lh: WorkspaceItem | null = null;
  try {
    const { resource } = await items.item(lakehouseId, workspaceId).read<WorkspaceItem>();
    lh = resource && resource.itemType === 'lakehouse' ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return { ok: false, reason: 'not-found' };
    throw e;
  }
  if (!lh) return { ok: false, reason: 'not-found' };
  const item: WorkspaceItem = lh;

  const state = (item.state as Record<string, any>) || {};
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, unknown>;
  const explicitAccount = typeof state.storageAccount === 'string' ? state.storageAccount.trim() : '';
  const persist = opts.persist === true;
  const itemRoot = lakehouseItemRootPath(item.displayName || '', item.id);
  // Only an item created before the cutover can have files under a name-only
  // root it never recorded, so only such an item looks for one in step 3.
  const nameRoot = lakehouseUsesItemRoot(item.createdAt) ? null : lakehouseRootPath(item.displayName || '', item.id);

  // Every OTHER lakehouse's root, recycled ones included (their files remain
  // until purge). Read once, lazily, and ONLY when an unmarked root has to be
  // checked; null when the read failed.
  let others: LakehouseRootLocation[] | null | undefined;
  const otherRoots = async (): Promise<LakehouseRootLocation[] | null> => {
    if (others === undefined) {
      others = await listLakehouseRootFacts(items, { includeRecycled: true })
        .then((rows) => rows
          .filter((r) => r.id !== item.id)
          .map(lakehouseRootLocation)
          .filter((l): l is LakehouseRootLocation => !!l))
        .catch(() => null);
    }
    return others;
  };
  /**
   * Does `root` in `container` overlap a root another lakehouse USES? null =
   * could not tell. `usedOnly` counts only roots another item has recorded, or
   * its own id-bearing item root; without it, the name-only root an unrecorded
   * older item would derive counts too.
   */
  const overlapsOther = async (
    account: string | null, container: string, root: string, usedOnly: boolean,
  ): Promise<boolean | null> => {
    const o = await otherRoots();
    if (o === null) return null;
    const mine: LakehouseRootLocation = {
      id: item.id, account, container, segments: root.split('/').filter(Boolean), recorded: true,
    };
    return o
      .filter((x) => !usedOnly || x.recorded || isLakehouseItemRootOf(x.segments.join('/'), x.id))
      .some((x) => lakehouseRootsOverlap(mine, x));
  };

  /**
   * Is a RECORDED location (steps 1-2c) this item's? Decided by the record and
   * the directory, never by the item's age:
   *   - its own item root (`--<id>`): yes, with no read at all;
   *   - a directory marked for this item: yes;
   *   - a directory marked for another item: no, and the next step is tried;
   *   - otherwise (unmarked, not yet created, or on an account whose marker
   *     this resolver does not read): yes, unless another item also records
   *     that root (or it is another item's item root), which is `root-shared`
   *     and stops resolution. If the other items cannot be read, the item's
   *     own record is kept: it was written by the server for this item. A
   *     recorded root found to be this item's alone is stamped with its marker
   *     when the caller persists, so the next resolve reads no other item.
   */
  const checkRecorded = async (c: RecordedCandidate): Promise<LakehouseStorageResolution | null> => {
    const ok: LakehouseStorageResolution = { ok: true, bound: c.bound };
    if (isLakehouseItemRootOf(c.bound.root, item.id)) return ok;
    let dir: LakehouseRootOwner | null = null;
    if (c.account === '' && c.bound.container) {
      try {
        dir = await readLakehouseRootOwner(c.bound.container, c.bound.root);
      } catch {
        dir = null;
      }
    }
    if (dir?.exists && dir.owner === item.id) return ok;
    if (dir?.exists && dir.owner !== null) return null;
    const shared = await overlapsOther(c.account, c.bound.container, c.bound.root, true);
    if (shared === true) return { ok: false, reason: 'root-shared' };
    if (shared === false && persist && dir?.exists) {
      await stampLakehouseRootOwner(c.bound.container, c.bound.root, item.id, dir);
    }
    return ok;
  };

  // 1. Provisioner already stamped a full abfss root — most accurate + already
  //    sovereign-cloud-correct. Parse out container/root for the editor list.
  const stampedAbfss = typeof sec.adlsRoot === 'string' ? sec.adlsRoot.trim() : '';
  if (stampedAbfss.startsWith('abfss://')) {
    const m = stampedAbfss.match(/^abfss:\/\/([^@]+)@([^./]+)\.[^/]+\/(.*)$/i);
    const acct = (m?.[2] || '').toLowerCase();
    const primary = primaryAccountLower();
    const decided = await checkRecorded({
      account: acct && primary !== null ? (acct === primary ? '' : acct) : null,
      bound: {
        abfss: stampedAbfss,
        container: m?.[1] || (typeof sec.container === 'string' ? sec.container : ''),
        root: trimSlashes((m?.[3] || (typeof sec.rootPath === 'string' ? sec.rootPath : ''))),
      },
    });
    if (decided) return decided;
  }

  // 2. Re-derive from recorded container + rootPath.
  const recContainer = typeof sec.container === 'string' ? sec.container : '';
  const recRoot = typeof sec.rootPath === 'string' ? sec.rootPath : '';
  if (recContainer && recRoot && isKnownContainer(recContainer)) {
    const abfss = resolveAbfssRoot(recContainer, recRoot);
    if (abfss) {
      const decided = await checkRecorded({
        account: explicitAccount.toLowerCase(),
        bound: { abfss, container: recContainer, root: trimSlashes(recRoot) },
      });
      if (decided) return decided;
    }
  }

  // 2b. Lakehouse bound to an explicit external storage account (state.storageAccount).
  if (explicitAccount && recContainer && recRoot) {
    const clean = trimSlashes(recRoot);
    const decided = await checkRecorded({
      account: explicitAccount.toLowerCase(),
      bound: {
        abfss: `abfss://${recContainer}@${explicitAccount}.${dfsSuffix()}/${clean}`,
        container: recContainer,
        root: clean,
      },
    });
    if (decided) return decided;
  }

  // 2c. The binding auto-bind (or an earlier resolve) persisted: a configured
  //     DLZ container and a root of the exact shape auto-bind writes.
  const boundContainer = typeof state.adlsContainer === 'string' ? state.adlsContainer.trim() : '';
  const boundRoot = typeof state.lakehouseRoot === 'string' ? state.lakehouseRoot.trim() : '';
  if (boundContainer && boundRoot && isKnownContainer(boundContainer) && isLakehouseRootShape(boundRoot)) {
    const abfss = resolveAbfssRoot(boundContainer, boundRoot);
    if (abfss) {
      const decided = await checkRecorded({
        account: explicitAccount.toLowerCase(),
        bound: { abfss, container: boundContainer, root: boundRoot },
      });
      if (decided) return decided;
    }
  }

  // 3. No usable recorded binding: probe for the root (see the header for the
  //    order, for which items each probe exists to find, and for when it re-runs).
  const owned = Array.isArray(state.ownedContainers) ? (state.ownedContainers as string[]) : undefined;
  const ownedDeclared = !!owned && owned.length > 0;
  const candidates = configuredCandidates(owned);
  const legacy = candidates[0];
  if (!legacy) {
    // No real configured storage — honest gate: caller skips this source.
    return { ok: false, reason: 'no-storage' };
  }
  const preferred = (ownedDeclared ? candidates : lakehouseContainerOrder(candidates)) as KnownContainer[];
  const probeOrder = [legacy, ...preferred.filter((c) => c !== legacy)];
  const rootsToProbe = nameRoot ? [itemRoot, nameRoot] : [itemRoot];
  let found: { container: KnownContainer; root: string; dir: LakehouseRootOwner & { exists: true } } | null = null;
  let probeFailed = false;
  // Containers holding a directory at the item root marked for another item.
  const heldByOther = new Set<KnownContainer>();
  walk: for (const c of probeOrder) {
    for (const root of rootsToProbe) {
      let r: LakehouseRootOwner;
      try {
        r = await readLakehouseRootOwner(c, root);
      } catch {
        // Not a 404: this container could not be read (or the probe timed
        // out), so the root cannot be said to be absent from it.
        probeFailed = true;
        break walk;
      }
      if (!r.exists) continue;
      if (root === itemRoot) {
        // The item's own id-bearing root: its own marker or none.
        if (mayAdoptRoot(r.owner, item.id)) { found = { container: c, root, dir: r }; break walk; }
        heldByOther.add(c);
        continue;
      }
      // The name-only root of an older item.
      if (r.owner === item.id) { found = { container: c, root, dir: r }; break walk; }
      // Marked for another item: this item's files may be here too, so no other
      // location is offered in their place.
      if (r.owner !== null) return { ok: false, reason: 'root-shared' };
      const shared = await overlapsOther('', c, root, false);
      if (shared === null) return { ok: false, reason: 'root-unverified' };
      if (shared) return { ok: false, reason: 'root-shared' };
      found = { container: c, root, dir: r };
      break walk;
    }
  }

  if (found) {
    const abfss = resolveAbfssRoot(found.container, found.root);
    if (!abfss) return { ok: false, reason: 'no-storage' };
    if (persist) {
      // An unmarked root this item may use is stamped as this item's, so
      // auto-bind and every later resolve recognise it without another check.
      if (found.dir.owner === null) {
        await stampLakehouseRootOwner(found.container, found.root, item.id, found.dir);
      }
      await persistFoundBinding(items, item, workspaceId, found.container, found.root);
    }
    return { ok: true, bound: { abfss, container: found.container, root: found.root } };
  }

  if (probeFailed) {
    // A failed probe establishes nothing, so the item is not moved to another
    // container: the answer is the legacy container, and nothing is written.
    if (nameRoot) {
      const shared = await overlapsOther('', legacy, nameRoot, false);
      if (shared === null) return { ok: false, reason: 'root-unverified' };
      if (shared) return { ok: false, reason: 'root-shared' };
    }
    const root = nameRoot ?? itemRoot;
    const abfss = resolveAbfssRoot(legacy, root);
    return abfss ? { ok: true, bound: { abfss, container: legacy, root } } : { ok: false, reason: 'no-storage' };
  }

  // Nothing exists yet: the item's own root, in the first container auto-bind
  // would create it in that does not hold another item's directory there. With
  // `persist`, it is created now, marked, and recorded, so an item that never
  // got a root at create (auto-bind timed out or was not run) has one from its
  // first open, and every later write lands in it.
  const container = preferred.find((c) => !heldByOther.has(c));
  if (!container) return { ok: false, reason: 'root-shared' };
  const abfss = resolveAbfssRoot(container, itemRoot);
  if (!abfss) return { ok: false, reason: 'no-storage' };
  if (persist) {
    let mine = false;
    try {
      await createOwnedLakehouseRoot(container, itemRoot, item.id);
      mine = true;
    } catch {
      // Created concurrently (by auto-bind, or a first write): recorded only if
      // it is this item's.
      mine = await readLakehouseRootOwner(container, itemRoot)
        .then((r) => r.exists && mayAdoptRoot(r.owner, item.id))
        .catch(() => false);
    }
    if (mine) await persistFoundBinding(items, item, workspaceId, container, itemRoot);
  }
  return { ok: true, bound: { abfss, container, root: itemRoot } };
}
