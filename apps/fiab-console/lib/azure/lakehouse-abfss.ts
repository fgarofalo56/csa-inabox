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
 * by lib/install/provisioners/lakehouse.ts, which records the exact container +
 * root it chose. We resolve from that record, in priority order:
 *
 *   1. state.provisioning.secondaryIds.adlsRoot — the full abfss URI the
 *      provisioner already built via resolveAbfssRoot() at create time. This is
 *      the most accurate (exact container chosen) AND sovereign-cloud-correct
 *      (the DFS host was parsed from the configured LOOM_*_URL). Preferred.
 *   2. state.provisioning.secondaryIds.{container, rootPath} — re-derive the
 *      abfss via resolveAbfssRoot() from the recorded container + root. Honours
 *      an explicit state.storageAccount when the lakehouse owns an external
 *      account.
 *   3. Deterministic convention fallback — `lakehouses/<safeRelPath(name)>` in
 *      the first configured + (optionally) owned container. Used only before
 *      the lakehouse's first provision has stamped a record; still resolves to a
 *      REAL configured host (returns null if no LOOM_*_URL is set at all).
 *
 * Returns null (caller skips the source silently — honest gate) when the
 * lakehouse can't be found, isn't a lakehouse, or no storage env is configured.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  KNOWN_CONTAINERS,
  resolveAbfssRoot,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';

const CONTAINER_URL_ENV: Record<KnownContainer, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
  'csv-imports': 'LOOM_CSV_IMPORTS_URL',
};

/** Same path-segment sanitiser the lakehouse provisioner uses to build `root`. */
function safeRelPath(p: string): string {
  return String(p)
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function isKnownContainer(name: string): name is KnownContainer {
  return (KNOWN_CONTAINERS as readonly string[]).includes(name);
}

/** First DLZ container that has a configured LOOM_*_URL env (and, if the
 *  lakehouse declares ownedContainers, that it actually owns). */
function firstConfiguredContainer(owned?: string[]): KnownContainer | null {
  const candidates = (Array.isArray(owned) && owned.length
    ? owned.filter(isKnownContainer)
    : [...KNOWN_CONTAINERS]) as KnownContainer[];
  for (const c of candidates) {
    if (process.env[CONTAINER_URL_ENV[c]]) return c;
  }
  return null;
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
      root: (m?.[2] || (typeof sec.rootPath === 'string' ? sec.rootPath : '')).replace(/^\/+|\/+$/g, ''),
    };
  }

  // 2. Re-derive from recorded container + rootPath.
  const recContainer = typeof sec.container === 'string' ? sec.container : '';
  const recRoot = typeof sec.rootPath === 'string' ? sec.rootPath : '';
  if (recContainer && recRoot && isKnownContainer(recContainer)) {
    const abfss = resolveAbfssRoot(recContainer, recRoot);
    if (abfss) return { abfss, container: recContainer, root: recRoot.replace(/^\/+|\/+$/g, '') };
  }

  // 2b. Lakehouse bound to an explicit external storage account (state.storageAccount).
  const explicitAccount = typeof state.storageAccount === 'string' ? state.storageAccount.trim() : '';
  if (explicitAccount && recContainer && recRoot) {
    const clean = recRoot.replace(/^\/+|\/+$/g, '');
    return {
      abfss: `abfss://${recContainer}@${explicitAccount}.${dfsSuffix()}/${clean}`,
      container: recContainer,
      root: clean,
    };
  }

  // 3. Deterministic convention fallback (before first provision): the
  //    provisioner writes to `lakehouses/<safeRelPath(displayName) || id>` in
  //    the first configured (and, if declared, owned) DLZ container.
  const owned = Array.isArray(state.ownedContainers) ? (state.ownedContainers as string[]) : undefined;
  const fallbackContainer = firstConfiguredContainer(owned);
  if (fallbackContainer) {
    const root = `lakehouses/${safeRelPath(lh.displayName || '') || lh.id}`;
    const abfss = resolveAbfssRoot(fallbackContainer, root);
    if (abfss) return { abfss, container: fallbackContainer, root };
  }

  // No real configured storage — honest gate: caller skips this source.
  return null;
}
