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
 *   3. No persisted binding — FIND the root rather than guess it (#4759,
 *      auto-bind-by-default.md rule 3). The root is
 *      `lakehouseRootPath(displayName, id)`. Containers are probed in this
 *      order and the first that holds the root wins (and is persisted, so the
 *      probe runs once per item):
 *        a. the LEGACY answer — the first configured (+ owned) container, i.e.
 *           exactly what this step returned before #4759. Lakehouses created
 *           before auto-bind existed (2026-08-22) were materialised there,
 *           normally `bronze`; probing it first means no such item changes
 *           container because of this fix.
 *        b. then `lakehouseContainerOrder` — the SAME order auto-bind creates
 *           in (`landing` first), which finds a post-08-22 root whose binding
 *           never reached Cosmos (create-time deadline, a save that dropped it).
 *      Nothing found anywhere → the container auto-bind WOULD create in, so
 *      the resolver and the creator agree on a lakehouse with no root yet. A
 *      probe that FAILS (403, network) stops the walk and returns the legacy
 *      answer unpersisted: a failed probe establishes nothing, so it must not
 *      move an item to a different container. No LOOM_*_URL configured at all
 *      → null, and no probe is made.
 *
 * Returns null (caller skips the source silently — honest gate) when the
 * lakehouse can't be found, isn't a lakehouse, or no storage env is configured.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  KNOWN_CONTAINERS,
  getMetadata,
  resolveAbfssRoot,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import { lakehouseRootPath, LAKEHOUSE_ROOT_PREFIX, safeAdlsRelPath } from '@/lib/azure/backing-name';
import { lakehouseContainerOrder } from '@/lib/azure/auto-bind-providers';
import { trimSlashes } from '@/lib/util/trim';

const CONTAINER_URL_ENV: Record<KnownContainer, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
  'csv-imports': 'LOOM_CSV_IMPORTS_URL',
};

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
 * Is `root` a path auto-bind could have written as `lakehouseRoot`?
 *
 * `state.lakehouseRoot` is a TOP-LEVEL state key, and top-level state is
 * replaced wholesale from a request body (see
 * app/api/items/_lib/server-derived-scope.ts), so it is a CLAIM, not a server
 * record. Accepting it verbatim would let a caller widen this item's root to a
 * whole container (`''`) or to any path in it. Bounding it to the shape
 * `lakehouseRootPath` produces — `lakehouses/<sanitised segments>` — keeps
 * step 2c inside the space step 3 ALREADY reaches through a client-writable
 * `displayName`, so reading it adds no reach the resolver did not have.
 */
function isLakehouseRootShape(root: string): boolean {
  if (!root.startsWith(LAKEHOUSE_ROOT_PREFIX)) return false;
  if (root.length <= LAKEHOUSE_ROOT_PREFIX.length) return false;
  return safeAdlsRelPath(root) === root;
}

export interface ResolvedLakehouseAbfss {
  /** Full abfss://<container>@<account>.dfs.<suffix>/<root> URI. */
  abfss: string;
  container: string;
  /** Root path inside the container (no leading/trailing slash). */
  root: string;
}

/**
 * Read the lakehouse item from Cosmos and return its ADLS Gen2 root as abfss,
 * or null when it can't be resolved against REAL configured storage.
 *
 * @param lakehouseId the attached-source item id
 * @param workspaceId the partition key (the notebook's workspace — the
 *        attached lakehouse lives in the same workspace)
 */
export async function resolveLakehouseAbfss(
  lakehouseId: string,
  workspaceId: string,
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

  // 2c. The binding auto-bind persisted on create (#4759). Bounded to a
  //     configured DLZ container and to the root SHAPE auto-bind writes — see
  //     isLakehouseRootShape for why an unbounded read would widen scope.
  const boundContainer = typeof state.adlsContainer === 'string' ? state.adlsContainer.trim() : '';
  const boundRoot = typeof state.lakehouseRoot === 'string' ? state.lakehouseRoot.trim() : '';
  if (boundContainer && boundRoot && isKnownContainer(boundContainer) && isLakehouseRootShape(boundRoot)) {
    const abfss = resolveAbfssRoot(boundContainer, boundRoot);
    if (abfss) return { abfss, container: boundContainer, root: boundRoot };
  }

  // 3. No persisted binding: probe for the root (see the header for the order
  //    and for which items each probe exists to find).
  const owned = Array.isArray(state.ownedContainers) ? (state.ownedContainers as string[]) : undefined;
  const candidates = configuredCandidates(owned);
  const legacy = candidates[0];
  if (legacy) {
    const root = lakehouseRootPath(lh.displayName || '', lh.id);
    const preferred = lakehouseContainerOrder(candidates) as KnownContainer[];
    const probeOrder = [legacy, ...preferred.filter((c) => c !== legacy)];
    let found: KnownContainer | null = null;
    let probeFailed = false;
    for (const c of probeOrder) {
      try {
        if ((await getMetadata(c, root)).exists) { found = c; break; }
      } catch {
        // Not a 404 (getMetadata maps 404 to exists:false): this container
        // could not be read, so the root cannot be said to be absent from it.
        probeFailed = true;
        break;
      }
    }
    const container: KnownContainer = found ?? (probeFailed ? legacy : (preferred[0] ?? legacy));
    const abfss = resolveAbfssRoot(container, root);
    if (abfss) {
      if (found) {
        // Self-heal: record what was found so the next resolve takes step 2c
        // and never probes again. The same writer and keys auto-bind uses;
        // best-effort (it never throws), because the answer is already right.
        const { persistAutoBindPatch } = await import('@/lib/azure/auto-bind');
        await persistAutoBindPatch(lh.id, workspaceId, { adlsContainer: found, lakehouseRoot: root });
      }
      return { abfss, container, root };
    }
  }

  // No real configured storage — honest gate: caller skips this source.
  return null;
}
