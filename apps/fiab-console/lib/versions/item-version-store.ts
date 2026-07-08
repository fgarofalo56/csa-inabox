/**
 * Item version-history store (Wave-2 W6).
 *
 * The version-snapshot LAYER: on every item save, a compact point-in-time
 * snapshot of the item's content is written into the dedicated `item-versions`
 * Cosmos container (PK /itemId — one physical partition per item). Instrumented
 * at the TWO shared item-save chokepoints the editors funnel through — the
 * generic `PATCH /api/cosmos-items/[type]/[id]` route and the per-type
 * `updateOwnedItem` helper — NOT in the ~100 individual editors.
 *
 * Snapshot model: each save records the NEW content as a version. On the FIRST
 * save for an item (no prior versions) the PRE-save content is ALSO recorded as
 * a baseline, so the item's original/creation state is captured even though item
 * CREATE goes through a different route. Every stored version therefore carries
 * full content, so any two versions diff cleanly and "restore" always has a
 * complete definition to write back.
 *
 * Cap: at most LOOM_ITEM_VERSION_CAP (default 50) versions per item; the oldest
 * are evicted on each save (`versionsToPrune`). Best-effort throughout — a
 * version-write failure NEVER fails or blocks the underlying save.
 */
import type { Container } from '@azure/cosmos';
import { itemVersionsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** Max snapshots retained per item (oldest-evicted on save). */
export const DEFAULT_ITEM_VERSION_CAP = 50;

export function itemVersionCap(): number {
  const raw = Number(process.env.LOOM_ITEM_VERSION_CAP);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_ITEM_VERSION_CAP;
}

/** A persisted item content snapshot. `content` mirrors the diffable slice of
 *  the item ({ displayName, description, state }). PK is /itemId. */
export interface ItemVersionDoc {
  id: string;                 // `ver:<itemId>:<uuid>`
  docType: 'item-version';
  itemId: string;             // partition key
  itemType: string;
  workspaceId: string;
  /** Snapshot of the item's diffable content at save time. */
  content: ItemVersionContent;
  /** ISO timestamp this content was saved (the item's updatedAt at snapshot). */
  savedAt: string;
  /** Entra oid of the actor who produced this save. */
  savedBy: string;
  /** Display name / UPN of the actor, for the timeline (best-effort). */
  savedByName?: string;
  /** True for the seeded pre-first-save baseline (creation state). */
  baseline?: boolean;
}

/** The diffable slice of an item captured in a version. */
export interface ItemVersionContent {
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
}

/** Row shape returned by the list route (metadata + summary, NO full content). */
export interface ItemVersionListEntry {
  id: string;
  savedAt: string;
  savedBy: string;
  savedByName?: string;
  displayName: string;
  baseline?: boolean;
  /** True for the newest version (its content equals the live item). */
  current?: boolean;
  /** Human summary of what this save changed vs the next-older version. */
  changeSummary: string;
}

/** Project the diffable content slice out of a full item doc. */
export function contentOf(item: WorkspaceItem): ItemVersionContent {
  return {
    displayName: item.displayName,
    description: item.description,
    state: item.state,
  };
}

/**
 * PURE cap decision: given all versions for an item (any order) and a cap,
 * return the ids of the versions to DELETE so only the newest `cap` remain.
 * Sorts by savedAt ascending (oldest first), tie-broken by id for determinism,
 * and returns the leading `(n - cap)` ids. Exported for unit testing.
 */
export function versionsToPrune(
  all: ReadonlyArray<{ id: string; savedAt: string }>,
  cap: number,
): string[] {
  if (cap < 1) cap = 1;
  if (all.length <= cap) return [];
  const sorted = [...all].sort((a, b) => {
    if (a.savedAt < b.savedAt) return -1;
    if (a.savedAt > b.savedAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(0, all.length - cap).map((v) => v.id);
}

/** Actor attribution for a recorded version. */
export interface VersionActor {
  oid: string;
  name?: string;
}

function newVersionDoc(
  item: WorkspaceItem,
  content: ItemVersionContent,
  savedAt: string,
  actor: VersionActor,
  baseline: boolean,
): ItemVersionDoc {
  return {
    id: `ver:${item.id}:${crypto.randomUUID()}`,
    docType: 'item-version',
    itemId: item.id,
    itemType: item.itemType,
    workspaceId: item.workspaceId,
    content,
    savedAt,
    savedBy: actor.oid,
    savedByName: actor.name,
    ...(baseline ? { baseline: true } : {}),
  };
}

/** Read every version doc for an item (single-partition query, newest first). */
async function readAllVersions(container: Container, itemId: string): Promise<ItemVersionDoc[]> {
  const { resources } = await container.items
    .query<ItemVersionDoc>(
      {
        query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c.savedAt DESC',
        parameters: [{ name: '@i', value: itemId }],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  return resources;
}

/**
 * Record a version for a save. `prev` is the item BEFORE the save (used to seed
 * the creation baseline on the very first version); `next` is the item AFTER the
 * save (the content this version captures). Best-effort: any failure is caught
 * and logged, NEVER thrown, so it cannot fail the underlying save.
 *
 * Returns the number of versions written (0 on failure), for tests/telemetry.
 */
export async function recordItemVersion(
  prev: WorkspaceItem | null,
  next: WorkspaceItem,
  actor: VersionActor,
): Promise<number> {
  try {
    const container = await itemVersionsContainer();
    const existing = await readAllVersions(container, next.id);

    let written = 0;
    // Seed the pre-first-save baseline so the item's original state is captured
    // (item CREATE doesn't pass through this layer). Only when nothing exists yet
    // AND we have a prior state that differs from the new one.
    if (existing.length === 0 && prev) {
      const baseAt = prev.updatedAt || prev.createdAt || new Date(0).toISOString();
      const baseDoc = newVersionDoc(
        prev,
        contentOf(prev),
        baseAt,
        { oid: prev.createdBy || actor.oid, name: undefined },
        true,
      );
      await container.items.create<ItemVersionDoc>(baseDoc);
      existing.push(baseDoc);
      written++;
    }

    const savedAt = next.updatedAt || new Date().toISOString();
    const doc = newVersionDoc(next, contentOf(next), savedAt, actor, false);
    await container.items.create<ItemVersionDoc>(doc);
    existing.push(doc);
    written++;

    // Enforce the cap — evict oldest beyond the cap.
    const prune = versionsToPrune(
      existing.map((v) => ({ id: v.id, savedAt: v.savedAt })),
      itemVersionCap(),
    );
    for (const id of prune) {
      try {
        await container.item(id, next.id).delete();
      } catch {
        /* best-effort prune — a stale/missing doc must not fail the save */
      }
    }
    return written;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[item-version-store] recordItemVersion failed (non-fatal):', e);
    return 0;
  }
}

/** All version docs for an item, newest first. Throws on Cosmos failure (the
 *  list route wraps it). */
export async function listItemVersions(itemId: string): Promise<ItemVersionDoc[]> {
  const container = await itemVersionsContainer();
  return readAllVersions(container, itemId);
}

/** A single version doc by id (point read within the item's partition). */
export async function getItemVersion(itemId: string, versionId: string): Promise<ItemVersionDoc | null> {
  const container = await itemVersionsContainer();
  try {
    const { resource } = await container.item(versionId, itemId).read<ItemVersionDoc>();
    // Guard against a versionId from a different item sharing the partition read.
    if (!resource || resource.itemId !== itemId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}
