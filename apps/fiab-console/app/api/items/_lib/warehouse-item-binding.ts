/**
 * #3669 — the link from a Databricks SQL warehouse back to the Loom item that
 * owns it, and the check that uses it.
 *
 * WHERE THE LINK LIVES. On the warehouse itself, as the custom tag
 * `loom_item_id` (`LOOM_OWNER_KEY`, shared with jobs and pipelines in
 * `databricks-resource-binding.ts`). Item `state` cannot carry it: `PATCH
 * /api/cosmos-items/[type]/[id]` replaces `state` wholesale, so anything
 * recorded there is a claim the item's own editor can rewrite. The warehouse tag
 * is written only by Loom code paths that are themselves authorized:
 *
 *   - `databricks-sql-warehouse/[id]/create` stamps it at birth (write-scoped on
 *     the item) and refuses a caller-supplied `loom_item_id` in `body.tags`;
 *   - `editWarehouse` always re-sends the current tags, so a scale or edit
 *     cannot drop it;
 *   - `admin/databricks-warehouses/adopt` stamps an existing warehouse
 *     (tenant admin, write-scoped on the target item);
 *   - {@link healWarehouseLink} re-stamps a warehouse whose tag went missing,
 *     for a WRITER of the item, using only the warehouse id the item's own
 *     server-written receipt records (see SELF-HEAL below).
 *
 * The tag is read LIVE from Databricks (`getWarehouse` → `tags.custom_tags`) on
 * every check, never from a cache, so a re-link or a deletion takes effect on the
 * next request.
 *
 * THE RECEIPT. `create` also records the new warehouse id on the item at
 * `state.provisioning.secondaryIds.warehouseId` ({@link WAREHOUSE_RECEIPT_PATH}).
 * `provisioning` is a server-derived key (`server-derived-scope.ts`): a request
 * body cannot change it, and a save that omits it carries it forward. The
 * receipt is NOT an authorization input — the tag is — it only tells the
 * self-heal which warehouse this item was born with. Workspace teardown already
 * reads the same path (`resource-teardown.ts`), so a recorded warehouse is now
 * removed with its workspace, as every other Databricks item's resource is.
 *
 * THE CHECK ({@link authorizeWarehouseTarget}). A caller may target a warehouse
 * when its tagged item sits in a workspace the caller can READ — the canonical
 * `authorizeItemWorkspace` ladder with `allowReadRoles`, given the item's own
 * `workspaceId` explicitly (that function ALLOWS when it is handed no workspace
 * and finds no item, so an empty `workspaceId` is refused here before it is
 * reached). A tenant admin goes through the same ladder for a tagged warehouse,
 * so the tenant boundary the resolver enforces still applies to them.
 *
 * An UNTAGGED warehouse (created before this change, outside Loom, or the
 * deployment-shared `loom-default`) and an ORPHANED one (its tag names no
 * warehouse item) belong to no item, so only a tenant admin may target them —
 * unchanged from before this change for admins, and the adopt route is how such
 * a warehouse is brought into an item. Every refusal a non-admin can see is the
 * same 404 body, so the response does not reveal which of "unknown", "untagged",
 * "orphaned" or "not readable" applied.
 *
 * CLOUD BOUNDARIES. Databricks SQL warehouses are the Commercial / GCC backend.
 * On GCC-High / IL5 / DoD the same item type is backed by a Synapse dedicated
 * SQL pool (`create/route.ts`), which this module does not touch; callers must
 * only reach it on the Databricks path.
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  databricksConfigGate,
  editWarehouse,
  getWarehouse,
  type Warehouse,
} from '@/lib/azure/databricks-client';
import { LOOM_ADOPTABLE_WAREHOUSE_NAMES, WAREHOUSE_ENV_VAR } from '@/lib/azure/databricks-sql-warehouse';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { LOOM_OWNER_KEY, resolveLegacyClaim } from '@/app/api/items/_lib/databricks-resource-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The Cosmos `itemType` whose items own Databricks SQL warehouses. */
export const WAREHOUSE_ITEM_TYPE = 'databricks-sql-warehouse';

/** Stable code on every refusal a non-admin can receive from this check. */
export const WAREHOUSE_NOT_AVAILABLE_CODE = 'warehouse_not_available';

/** Stable code when the link could not be read, so nothing was run. */
export const WAREHOUSE_UNVERIFIABLE_CODE = 'warehouse_unverifiable';

const NOT_AVAILABLE_ERROR =
  'This SQL warehouse is not available to you. Either it does not exist, it is not linked to a ' +
  'Loom SQL warehouse item, or you have no role in the workspace of the item it is linked to.';

const NOT_AVAILABLE_REMEDIATION =
  'Choose a warehouse created from a SQL warehouse item in a workspace you can open, ask a ' +
  'workspace owner to share that workspace with you, or run the function on Azure OpenAI ' +
  'instead. A tenant admin can link an existing warehouse to its item with "Link to this item" ' +
  'in the SQL warehouse editor.';

/** True for any spelling of the owner key: trimmed, case-insensitive. */
export function isOwnerTagKey(key: unknown): boolean {
  return typeof key === 'string' && key.trim().toLowerCase() === LOOM_OWNER_KEY;
}

/**
 * Read the owner tag off a warehouse. `conflict` is true when the tag appears
 * with more than one distinct value — the warehouse then names no single owner
 * and is treated as unverifiable, never as the first or last value.
 */
export function warehouseOwnerTag(wh: Pick<Warehouse, 'tags'> | null | undefined): {
  value?: string;
  conflict: boolean;
} {
  const tags = Array.isArray(wh?.tags?.custom_tags) ? wh!.tags!.custom_tags! : [];
  const values = new Set(
    tags
      .filter((t) => isOwnerTagKey(t?.key) && typeof t?.value === 'string' && t.value.trim())
      .map((t) => t.value.trim()),
  );
  if (values.size > 1) return { conflict: true };
  const [value] = [...values];
  return { value, conflict: false };
}

/**
 * The id of the ONE warehouse in `list` whose owner tag names `itemId` (both
 * sides normalised through `cosmosIdFromLoomId`), else ''. Two or more matches
 * also give '' — the editor preselects nothing rather than guess between them.
 */
export function linkedWarehouseIdFor(list: ReadonlyArray<Pick<Warehouse, 'id' | 'tags'>>, itemId: string): string {
  const self = cosmosIdFromLoomId(itemId);
  if (!self) return '';
  const hits = list.filter((w) => {
    const tag = warehouseOwnerTag(w);
    return !tag.conflict && !!tag.value && cosmosIdFromLoomId(tag.value) === self;
  });
  return hits.length === 1 ? hits[0].id : '';
}

/**
 * Thrown by {@link loadWarehouseItemRaw} when one id matches MORE THAN ONE
 * warehouse item. Item ids are unique only within a partition (the workspace),
 * and this lookup is cross-partition, so two documents can share an id. Picking
 * either one would authorize against a workspace chosen by query order, so the
 * link is treated as unverifiable instead.
 */
export class DuplicateWarehouseItemError extends Error {
  constructor(public readonly count: number) {
    super(`the linked item id matches ${count} SQL warehouse items`);
    this.name = 'DuplicateWarehouseItemError';
  }
}

/**
 * Load a `databricks-sql-warehouse` item by id WITHOUT authorizing. Cross-partition
 * on purpose: an item in a workspace the caller cannot read must still resolve,
 * so it can be REFUSED rather than mistaken for "no item".
 *
 * FAILS CLOSED on an ambiguous id: more than one row throws
 * {@link DuplicateWarehouseItemError}; it never returns the first.
 */
export async function loadWarehouseItemRaw(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: WAREHOUSE_ITEM_TYPE },
      ],
    })
    .fetchAll();
  if (resources.length > 1) throw new DuplicateWarehouseItemError(resources.length);
  return resources[0] ?? null;
}

export type WarehouseItemResolution =
  /** The warehouse is tagged and the tag names an existing warehouse item. */
  | { kind: 'bound'; warehouse: Warehouse; item: WorkspaceItem }
  /** The warehouse carries no owner tag. */
  | { kind: 'unbound'; warehouse: Warehouse }
  /** The tag names no `databricks-sql-warehouse` item. */
  | { kind: 'orphaned'; warehouse: Warehouse; itemId: string }
  /** Databricks answered 404 for this warehouse id. */
  | { kind: 'not_found' }
  /** Databricks or Cosmos could not be read, or the tag is ambiguous. */
  | { kind: 'unverifiable'; detail: string };

/**
 * Resolve a warehouse id to the Loom item its live `loom_item_id` tag names.
 * Read-only: never stamps, never edits.
 */
export async function resolveWarehouseItem(warehouseId: string): Promise<WarehouseItemResolution> {
  let warehouse: Warehouse;
  try {
    warehouse = await getWarehouse(warehouseId);
  } catch (e: unknown) {
    if ((e as { status?: number })?.status === 404) return { kind: 'not_found' };
    return { kind: 'unverifiable', detail: 'the warehouse could not be read from Databricks' };
  }
  const tag = warehouseOwnerTag(warehouse);
  if (tag.conflict) {
    return { kind: 'unverifiable', detail: `the warehouse carries more than one ${LOOM_OWNER_KEY} value` };
  }
  if (!tag.value) return { kind: 'unbound', warehouse };
  let item: WorkspaceItem | null;
  try {
    item = await loadWarehouseItemRaw(tag.value);
  } catch (e: unknown) {
    if (e instanceof DuplicateWarehouseItemError) {
      return { kind: 'unverifiable', detail: 'the linked item id matches more than one item' };
    }
    return { kind: 'unverifiable', detail: 'the linked item could not be read' };
  }
  if (!item) return { kind: 'orphaned', warehouse, itemId: tag.value };
  return { kind: 'bound', warehouse, item };
}

export type WarehouseTargetVerdict =
  | { ok: true; warehouse: Warehouse; item?: WorkspaceItem }
  | { ok: false; res: NextResponse };

function notAvailable(): WarehouseTargetVerdict {
  return {
    ok: false,
    res: NextResponse.json(
      {
        ok: false,
        code: WAREHOUSE_NOT_AVAILABLE_CODE,
        error: NOT_AVAILABLE_ERROR,
        remediation: NOT_AVAILABLE_REMEDIATION,
      },
      { status: 404 },
    ),
  };
}

/**
 * May this session run work on this Databricks SQL warehouse? Read scope: the
 * caller needs any role on the workspace of the item the warehouse is linked to.
 */
export async function authorizeWarehouseTarget(
  session: SessionPayload,
  warehouseId: string,
): Promise<WarehouseTargetVerdict> {
  const r = await resolveWarehouseItem(warehouseId);

  if (r.kind === 'unverifiable') {
    return {
      ok: false,
      res: NextResponse.json(
        {
          ok: false,
          code: WAREHOUSE_UNVERIFIABLE_CODE,
          error: `Could not confirm which Loom item this SQL warehouse belongs to (${r.detail}), so nothing was run.`,
          remediation:
            'Retry. If it persists, check that the Console identity can read SQL warehouses in the ' +
            'Databricks workspace.',
        },
        { status: 502 },
      ),
    };
  }
  if (r.kind === 'not_found') return notAvailable();

  if (r.kind === 'bound') {
    const workspaceId = typeof r.item.workspaceId === 'string' ? r.item.workspaceId.trim() : '';
    // FAIL CLOSED: `authorizeItemWorkspace` allows when it has no workspace to check.
    if (!workspaceId) return notAvailable();
    const denied = await authorizeItemWorkspace(session, {
      workspaceId,
      itemId: r.item.id,
      itemType: WAREHOUSE_ITEM_TYPE,
      allowReadRoles: true,
      notFound: NOT_AVAILABLE_ERROR,
    });
    if (!denied) return { ok: true, warehouse: r.warehouse, item: r.item };
    // An ordinary refusal gets the coded body; a tenancy refusal (409) is a
    // different, true statement and passes through unchanged.
    return denied.status === 404 ? notAvailable() : { ok: false, res: denied };
  }

  // 'unbound' | 'orphaned' — no item, so no workspace to check against.
  if (isTenantAdmin(session)) return { ok: true, warehouse: r.warehouse };
  return notAvailable();
}

// ─────────────────────────────────────────────────────────────────────────────
// STAMPING — shared by the adopt route and the self-heal.
// ─────────────────────────────────────────────────────────────────────────────

/** What the read-back after a stamp showed. Never what was sent. */
export type StampOutcome =
  | { kind: 'stamped' }
  /** Another owner value is on the warehouse after our write — a concurrent link won. */
  | { kind: 'linked_elsewhere'; linkedItemId: string }
  /** More than one owner value is on the warehouse after our write. */
  | { kind: 'tag_conflict' }
  /** The tag could not be read back, or is absent. */
  | { kind: 'unconfirmed' }
  /** Databricks refused the edit. */
  | { kind: 'edit_failed'; message: string };

/**
 * Judge the warehouse as READ BACK after a stamp. A different value here means
 * another writer landed between our read and our read-back, and this caller did
 * NOT win — so it reports the other owner instead of success.
 */
export function judgeStampReadBack(after: Pick<Warehouse, 'tags'> | null, itemId: string): StampOutcome {
  if (!after) return { kind: 'unconfirmed' };
  const tag = warehouseOwnerTag(after);
  if (tag.conflict) return { kind: 'tag_conflict' };
  if (tag.value === itemId) return { kind: 'stamped' };
  if (tag.value) return { kind: 'linked_elsewhere', linkedItemId: tag.value };
  return { kind: 'unconfirmed' };
}

/**
 * Add `loom_item_id = itemId` to a warehouse the CALLER has already judged
 * untagged, then re-read it and report what is actually there.
 *
 * RESIDUAL, stated rather than implied away: the Databricks edit endpoint has no
 * compare-and-swap, so two linkers that both read the warehouse untagged can both
 * write. The read-back makes the LOSER of that race see the other owner and
 * report `linked_elsewhere`; it cannot stop a second writer that lands after the
 * first one's read-back. Both writers are tenant admins (adopt) or writers of
 * the item the receipt names (self-heal), so the window is between authorized
 * callers, not an escalation path.
 */
export async function stampWarehouseOwner(wh: Warehouse, itemId: string): Promise<StampOutcome> {
  const kept = (wh.tags?.custom_tags || []).filter((t) => !isOwnerTagKey(t?.key));
  try {
    // Re-send the current scale settings so the edit changes only the tags.
    await editWarehouse(
      wh.id,
      {
        min_num_clusters: wh.min_num_clusters,
        max_num_clusters: wh.max_num_clusters,
        auto_stop_mins: wh.auto_stop_mins,
        enable_serverless_compute: wh.enable_serverless_compute,
      },
      [...kept, { key: LOOM_OWNER_KEY, value: itemId }],
    );
  } catch (e: unknown) {
    return { kind: 'edit_failed', message: (e as Error)?.message || String(e) };
  }
  let after: Warehouse | null = null;
  try {
    after = await getWarehouse(wh.id);
  } catch {
    after = null;
  }
  return judgeStampReadBack(after, itemId);
}

/**
 * The deployment-shared warehouses: the ones the bootstrap creates or adopts by
 * name (`LOOM_ADOPTABLE_WAREHOUSE_NAMES`, case-insensitive) and the one the
 * Console is wired to (`LOOM_DATABRICKS_SQL_WAREHOUSE_ID`). Linking one to an
 * item would hand it to every reader of that item's workspace, so neither the
 * self-heal nor adopt links them; they stay tenant-admin-only.
 */
export function isDeploymentSharedWarehouse(wh: Pick<Warehouse, 'id' | 'name'>): boolean {
  const name = typeof wh.name === 'string' ? wh.name.trim().toLowerCase() : '';
  if (name && LOOM_ADOPTABLE_WAREHOUSE_NAMES.some((n) => n.toLowerCase() === name)) return true;
  const wired = (process.env[WAREHOUSE_ENV_VAR] || '').trim();
  return !!wired && wh.id === wired;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT — written by `create`, read by the self-heal.
// ─────────────────────────────────────────────────────────────────────────────

/** Cosmos path of the receipt; also the exclusivity-claim path. */
export const WAREHOUSE_RECEIPT_PATH = 'c.state.provisioning.secondaryIds.warehouseId';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The warehouse id this item's SERVER-written receipt records, or ''. Reads
 * ONLY `state.provisioning.secondaryIds.warehouseId`; a top-level
 * `state.warehouseId` is client-writable and is deliberately never read here.
 */
export function recordedWarehouseId(item: Pick<WorkspaceItem, 'state'> | null | undefined): string {
  const prov = asRecord(asRecord(item?.state).provisioning);
  const v = asRecord(prov.secondaryIds).warehouseId;
  return typeof v === 'string' ? v.trim() : '';
}

function isPreconditionFailed(e: unknown): boolean {
  const x = e as { code?: unknown; statusCode?: unknown };
  return x?.code === 412 || x?.statusCode === 412;
}

/**
 * Record the warehouse `create` just made on the item, server-side, as a merge
 * into `state.provisioning.secondaryIds` conditional on the item's `_etag`
 * (re-read and retried on 412, at most three attempts). Best-effort: the
 * warehouse already carries its owner tag from birth, so a failed receipt only
 * means the self-heal cannot repair that tag later. Returns whether it landed.
 */
export async function recordWarehouseReceipt(
  item: Pick<WorkspaceItem, 'id' | 'workspaceId'>,
  warehouseId: string,
): Promise<boolean> {
  const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId.trim() : '';
  if (!workspaceId || !warehouseId) return false;
  try {
    const items = await itemsContainer();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { resource } = await items.item(item.id, workspaceId).read<WorkspaceItem>();
      if (!resource) return false;
      const state = asRecord(resource.state);
      const prov = asRecord(state.provisioning);
      const next: WorkspaceItem = {
        ...resource,
        state: {
          ...state,
          provisioning: { ...prov, secondaryIds: { ...asRecord(prov.secondaryIds), warehouseId } },
        },
        updatedAt: new Date().toISOString(),
      };
      const etag = (resource as { _etag?: unknown })._etag;
      try {
        await items.item(item.id, workspaceId).replace<WorkspaceItem>(
          next,
          typeof etag === 'string' && etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
        );
        return true;
      } catch (e: unknown) {
        if (isPreconditionFailed(e)) continue;
        return false;
      }
    }
  } catch {
    /* best-effort — see above */
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEAL (auto-bind-by-default §3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every outcome of {@link healWarehouseLink}. Only `stamped` changed anything.
 *
 *   not_databricks     Gov boundary, or Databricks is not configured.
 *   no_receipt         the item records no warehouse — every item created before
 *                      the receipt existed lands here.
 *   not_writer         the caller has no WRITE role on the item's workspace.
 *   already_linked     the warehouse already names this item.
 *   warehouse_missing  Databricks answered 404 for the recorded id.
 *   unreadable         the warehouse could not be read.
 *   deployment_shared  the recorded id is a deployment-shared warehouse.
 *   linked_elsewhere   the warehouse names a DIFFERENT item — never overwritten.
 *   tag_conflict       the warehouse carries more than one owner value.
 *   claimed_elsewhere  another warehouse item records the same warehouse id.
 *   claim_unverifiable the exclusivity check could not run (fails closed).
 *   unconfirmed        the stamp was sent but could not be read back.
 *   edit_failed        Databricks refused the edit.
 */
export type HealOutcome =
  | 'stamped'
  | 'not_databricks'
  | 'no_receipt'
  | 'not_writer'
  | 'already_linked'
  | 'warehouse_missing'
  | 'unreadable'
  | 'deployment_shared'
  | 'linked_elsewhere'
  | 'tag_conflict'
  | 'claimed_elsewhere'
  | 'claim_unverifiable'
  | 'unconfirmed'
  | 'edit_failed';

const HEAL_NOT_WRITER = 'SQL warehouse item not found, or you have no write role in its workspace.';

/**
 * Re-stamp the owner tag on the warehouse this item was created with, when the
 * tag has gone missing — for a WRITER of the item only.
 *
 * WHICH WAREHOUSE. Only the id the item document's server-written receipt
 * records ({@link recordedWarehouseId}). The function takes no warehouse id
 * argument at all, so no request value can reach the stamp.
 *
 * WHAT IT NEVER DOES. Overwrite a different owner value or a conflicting tag;
 * link a deployment-shared warehouse; link a warehouse another item also
 * records (`resolveLegacyClaim` over the receipt path, fail-closed on error).
 *
 * WHY HERE AND NOT IN THE AUTHORIZATION CHECK. `authorizeWarehouseTarget` is
 * read-scoped and runs on every AI-function call; a write from it would let a
 * Viewer cause a tag edit. The editor's load route calls this once per open,
 * after its own item guard, and this function adds the write-scope check.
 */
export async function healWarehouseLink(session: SessionPayload, item: WorkspaceItem): Promise<HealOutcome> {
  if (isGovCloud() || databricksConfigGate() !== null) return 'not_databricks';
  const warehouseId = recordedWarehouseId(item);
  if (!warehouseId) return 'no_receipt';

  const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId.trim() : '';
  // FAIL CLOSED before the ladder: it allows when handed no workspace.
  if (!workspaceId) return 'not_writer';
  const denied = await authorizeItemWorkspace(session, {
    workspaceId,
    itemId: item.id,
    itemType: WAREHOUSE_ITEM_TYPE,
    notFound: HEAL_NOT_WRITER,
  });
  if (denied) return 'not_writer';

  let wh: Warehouse;
  try {
    wh = await getWarehouse(warehouseId);
  } catch (e: unknown) {
    return (e as { status?: number })?.status === 404 ? 'warehouse_missing' : 'unreadable';
  }
  const tag = warehouseOwnerTag(wh);
  if (tag.conflict) return 'tag_conflict';
  if (tag.value === item.id) return 'already_linked';
  if (tag.value) return 'linked_elsewhere';
  if (isDeploymentSharedWarehouse(wh)) return 'deployment_shared';

  const claim = await resolveLegacyClaim({
    itemType: WAREHOUSE_ITEM_TYPE,
    itemId: item.id,
    resourceId: wh.id,
    paths: [WAREHOUSE_RECEIPT_PATH],
  });
  if (!claim.ok) return claim.status === 409 ? 'claimed_elsewhere' : 'claim_unverifiable';

  const stamped = await stampWarehouseOwner(wh, item.id);
  return stamped.kind;
}
