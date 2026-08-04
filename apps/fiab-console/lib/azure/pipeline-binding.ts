/**
 * Pipeline resource-binding resolver — shared by the ADF + Synapse pipeline
 * BFF routes.
 *
 * Root-cause this fixes: the Loom item id (a Cosmos GUID) was being passed
 * straight to ADF/Synapse `getPipeline()` as the Azure *pipeline name*. Azure
 * has no pipeline named that GUID, so every GET/run/runs/validate/debug 404'd.
 *
 * The real model: a Loom pipeline item BINDS to a real Azure ADF/Synapse
 * pipeline. The binding lives in the Cosmos item's `state`:
 *
 *   state.pipelineName       — the Azure pipeline NAME (what Azure REST wants)
 *   state.factory            — (ADF) factory name override, optional
 *   state.workspace          — (Synapse) workspace name override, optional
 *
 * Routes resolve `{ pipelineName, factory?, workspace? }` from item state via
 * `resolveBinding()`, NOT from the raw route id. When unbound, callers should
 * 412 with a structured `{ ok:false, code:'unbound' }` so the editor can show
 * its bind picker.
 *
 * No mocks. The item lookup is a real Cosmos query (same pattern as
 * /api/cosmos-items). Pipeline operations stay in adf-client / synapse-dev-client.
 */

import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid, ambientAccessOptsFor } from '@/lib/auth/workspace-access';
import { resolveFactoryOverride, type FactoryOverride } from '@/lib/azure/adf-factory-context';
import type { WorkspaceItem } from '@/lib/types/workspace';

export interface PipelineBinding {
  /** The real Azure pipeline name to use for every REST call. */
  pipelineName: string;
  /** Optional ADF factory NAME override (defaults to env LOOM_ADF_NAME). */
  factory?: string;
  /** Optional ADF factory SUBSCRIPTION override — the cross-sub factory the item was bound against. */
  factorySubscriptionId?: string;
  /** Optional ADF factory RESOURCE GROUP override — the cross-sub factory the item was bound against. */
  factoryResourceGroup?: string;
  /** Optional Synapse workspace override (defaults to env LOOM_SYNAPSE_WORKSPACE). */
  workspace?: string;
  /** The Cosmos item this binding came from (so callers can re-save state). */
  item: WorkspaceItem;
}

/**
 * Build the selected-factory override for a resolved binding so a per-item ADF
 * route can wrap its adf-client calls in `withFactoryOverride(...)` and target
 * the SAME factory the item was bound against (persisted at bind time). Returns
 * `undefined` when the item was bound against the env-default factory (no
 * factory coords stored) — the calls then use the env default, unchanged.
 */
export function bindingFactoryOverride(binding: PipelineBinding): FactoryOverride | undefined {
  return resolveFactoryOverride({
    subscriptionId: binding.factorySubscriptionId,
    resourceGroup: binding.factoryResourceGroup,
    factoryName: binding.factory,
  });
}

export class UnboundPipelineError extends Error {
  readonly code = 'unbound';
  constructor(public itemType: string, public itemId: string) {
    super(
      `Loom pipeline item ${itemId} (${itemType}) is not bound to a real Azure pipeline. ` +
        `Pick or create a pipeline in the editor to bind it.`,
    );
    this.name = 'UnboundPipelineError';
  }
}

export class ItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemType: string, public itemId: string) {
    super(`Item ${itemId} (${itemType}) not found in this tenant.`);
    this.name = 'ItemNotFoundError';
  }
}

/**
 * Load a Loom item by (id, itemType) and authorize the caller against the
 * workspace that owns it. Mirrors the access model of /api/cosmos-items so RBAC
 * stays consistent.
 *
 * `itemType` accepts a single type OR a list of acceptable types. This matters
 * because the pipeline family aliases at creation time: an interactively-created
 * `adf-pipeline` / `synapse-pipeline` tile (both `aliasOf:'data-pipeline'` in the
 * catalog) is PERSISTED with `itemType:'data-pipeline'`, while a bundle-installed
 * item may genuinely carry `itemType:'adf-pipeline'` (or `'synapse-pipeline'`).
 * The ADF/Synapse route handlers therefore pass BOTH their own type and
 * `'data-pipeline'` so either persisted form resolves. The list is matched via a
 * parameterized `IN (...)` — no string concatenation of values.
 *
 * #2942 — THE AUTHORIZATION STEP USED TO BE AN OWNER-ONLY POINT READ:
 *
 *     const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
 *     if (!resource || resource.tenantId !== tenantId) return null;
 *
 * i.e. `assertOwner` inlined byte-for-byte. The `workspaces` container is
 * partitioned by `/tenantId` and `Workspace.tenantId` stores the workspace
 * CREATOR's Entra oid, so that point read can only ever find a workspace the
 * CALLER created. It answers "did this caller create the workspace", not "may
 * this caller access it". A tenant admin who did not personally create the
 * workspace therefore got `null` → `ItemNotFoundError` → the data-pipeline
 * editor showed "Item <id> (adf-pipeline) not found in this tenant" and never
 * rendered its canvas — while `GET /api/cosmos-items/data-pipeline/<id>`
 * returned 200 for the SAME caller, because that route resolves through
 * `resolveItemAccessByOid` → `resolveWorkspaceAccessByOid` (owner → ACL → tid
 * boundary → admin-open). Same root cause as #2941's `assertOwner` on the
 * semantic-model model route.
 *
 * It now uses that canonical ladder. `tenantId` here is the caller's Entra oid
 * (legacy naming, matching the ~30 call sites that pass `session.claims.oid`);
 * the tid boundary and the tenant-admin bypass come from the AMBIENT request
 * session for that same principal via `ambientAccessOptsFor`, so no call site
 * had to change.
 *
 * WRITE-SCOPED BY DEFAULT, exactly like `loadOwnedItem`: this helper backs both
 * reads AND `persistBinding` (a Cosmos mutation) plus the run/debug/validate/
 * trigger actions, so a shared read-only Viewer must not pass it. That is also
 * strictly NOT weaker than the previous owner-only behavior. A genuinely
 * read-only caller opts in with `{ allowReadRoles: true }`.
 */
export async function loadPipelineItem(
  itemId: string,
  itemType: string | string[],
  tenantId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<WorkspaceItem | null> {
  const types = (Array.isArray(itemType) ? itemType : [itemType]).filter(Boolean);
  const items = await itemsContainer();
  const typePlaceholders = types.map((_, i) => `@t${i}`);
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: `SELECT * FROM c WHERE c.id = @id AND c.itemType IN (${typePlaceholders.join(', ')})`,
      parameters: [
        { name: '@id', value: itemId },
        ...types.map((t, i) => ({ name: `@t${i}`, value: t })),
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const access = await resolveWorkspaceAccessByOid(
    tenantId,
    item.workspaceId,
    await ambientAccessOptsFor(tenantId),
  );
  if (!access) return null;
  if (!opts.allowReadRoles && !access.canWrite) return null;
  return item;
}

function readBindingFromState(item: WorkspaceItem): {
  pipelineName?: string; factory?: string; factorySubscriptionId?: string; factoryResourceGroup?: string; workspace?: string;
} {
  const state = (item.state || {}) as Record<string, unknown>;
  const pipelineName = typeof state.pipelineName === 'string' ? state.pipelineName.trim() : '';
  const factory = typeof state.factory === 'string' ? state.factory.trim() : undefined;
  const factorySubscriptionId = typeof state.factorySubscriptionId === 'string' ? state.factorySubscriptionId.trim() : undefined;
  const factoryResourceGroup = typeof state.factoryResourceGroup === 'string' ? state.factoryResourceGroup.trim() : undefined;
  const workspace = typeof state.workspace === 'string' ? state.workspace.trim() : undefined;
  return { pipelineName: pipelineName || undefined, factory, factorySubscriptionId, factoryResourceGroup, workspace };
}

/**
 * Resolve the bound Azure pipeline name (+ optional factory/workspace) for a
 * Loom item.
 *
 * Throws:
 *   - ItemNotFoundError      when the item doesn't exist in the tenant
 *   - UnboundPipelineError   when the item exists but has no state.pipelineName
 *
 * Callers map those to 404 / 412 respectively.
 *
 * `opts.allowReadRoles` is for a STRICTLY read-only caller (e.g. rendering the
 * editor's bind picker). It is deliberately NOT the default: `resolveBinding`
 * also backs run / debug / validate / trigger, which execute or mutate.
 */
export async function resolveBinding(
  itemId: string,
  itemType: string | string[],
  tenantId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<PipelineBinding> {
  const item = await loadPipelineItem(itemId, itemType, tenantId, opts);
  // For not-found messages use the caller's primary (first) requested type —
  // e.g. 'adf-pipeline' — since the item genuinely doesn't exist. When the item
  // IS found, prefer its ACTUAL persisted itemType (often 'data-pipeline').
  const primaryType = Array.isArray(itemType) ? itemType[0] : itemType;
  if (!item) throw new ItemNotFoundError(primaryType, itemId);
  const { pipelineName, factory, factorySubscriptionId, factoryResourceGroup, workspace } = readBindingFromState(item);
  if (!pipelineName) throw new UnboundPipelineError(item.itemType || primaryType, itemId);
  return { pipelineName, factory, factorySubscriptionId, factoryResourceGroup, workspace, item };
}

/**
 * Persist a binding onto the Loom item's `state`. Used by the editor's
 * "bind to existing" / "create new + bind" actions. Returns the updated item.
 *
 * WRITE — intentionally uses `loadPipelineItem`'s write-scoped default (no
 * `allowReadRoles`): a shared read-only Viewer must never be able to re-bind an
 * item, even though #2942 loosened the READ path for admins/members.
 */
export async function persistBinding(
  itemId: string,
  itemType: string | string[],
  tenantId: string,
  binding: {
    pipelineName: string;
    factory?: string;
    factorySubscriptionId?: string;
    factoryResourceGroup?: string;
    workspace?: string;
  },
): Promise<WorkspaceItem> {
  const item = await loadPipelineItem(itemId, itemType, tenantId);
  const primaryType = Array.isArray(itemType) ? itemType[0] : itemType;
  if (!item) throw new ItemNotFoundError(primaryType, itemId);
  if (!binding.pipelineName || !binding.pipelineName.trim()) {
    throw new Error('pipelineName is required to bind');
  }
  const nextState: Record<string, unknown> = {
    ...(item.state || {}),
    pipelineName: binding.pipelineName.trim(),
  };
  // Persist the SELECTED factory the item was bound against so per-item ops
  // (run/save/validate/triggers) target the same factory the tree + bind
  // dropdown listed from. A cleared (undefined) coord leaves any prior value in
  // place; an empty-string coord (deselect) removes it so the item re-follows
  // the env default.
  if (binding.factory !== undefined) {
    if (binding.factory.trim()) nextState.factory = binding.factory.trim();
    else delete nextState.factory;
  }
  if (binding.factorySubscriptionId !== undefined) {
    if (binding.factorySubscriptionId.trim()) nextState.factorySubscriptionId = binding.factorySubscriptionId.trim();
    else delete nextState.factorySubscriptionId;
  }
  if (binding.factoryResourceGroup !== undefined) {
    if (binding.factoryResourceGroup.trim()) nextState.factoryResourceGroup = binding.factoryResourceGroup.trim();
    else delete nextState.factoryResourceGroup;
  }
  if (binding.workspace) nextState.workspace = binding.workspace.trim();
  const next: WorkspaceItem = {
    ...item,
    state: nextState,
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource as WorkspaceItem;
}

/**
 * Build a backend-shaped pipeline definition (ADF / Synapse pipeline JSON:
 * `{ name?, properties: { activities, parameters, ... } }`) from a bundle's
 * stamped `state.content` (AdfPipelineContent / SynapsePipelineContent).
 *
 * Why this exists: when an app installs a pipeline item, the bundle's rich
 * activity graph is stamped into `state.content.activities`, but the editor
 * loads its canvas from the LIVE ADF/Synapse pipeline. When that live object
 * isn't present yet (unprovisioned / RBAC-gated / not-yet-created) the canvas
 * would open EMPTY. This maps the stamped content into the exact pipeline-JSON
 * shape `extractActivities()` / the designer expect, so the canvas renders
 * every activity + dependency + parameter even with no live backend object.
 *
 * The bundle's per-activity `config` is the activity body (it already carries
 * `typeProperties` / `policy` / `linkedServiceName` / `description` for normal
 * activities, or `expression` / `items` / child `activities` for control-flow
 * activities), so it is spread directly onto the activity. `dependsOn` is the
 * compact `string[]` form, expanded to ADF's `[{activity, dependencyConditions}]`.
 *
 * Returns null when `content` isn't a pipeline-shaped bundle content.
 */
export function pipelineDefinitionFromContent(
  content: unknown,
  pipelineName?: string,
): { name?: string; properties: { activities: unknown[]; parameters?: Record<string, unknown> } } | null {
  const c = content as
    | { kind?: string; activities?: Array<{ name: string; type: string; config?: any; dependsOn?: string[] }>; parameters?: Record<string, unknown> }
    | undefined;
  if (!c || (c.kind !== 'adf-pipeline' && c.kind !== 'synapse-pipeline')) return null;
  if (!Array.isArray(c.activities)) return null;

  const activities = c.activities.map((a) => {
    const { config, dependsOn } = a;
    const activity: Record<string, unknown> = {
      // `config` is the activity body (typeProperties/policy/linkedServiceName/
      // description, or control-flow expression/items/activities). Spread first
      // so the canonical name/type below always win.
      ...(config && typeof config === 'object' ? config : {}),
      name: a.name,
      type: a.type,
    };
    if (Array.isArray(dependsOn) && dependsOn.length) {
      activity.dependsOn = dependsOn.map((d) => ({ activity: d, dependencyConditions: ['Succeeded'] }));
    }
    return activity;
  });

  return {
    ...(pipelineName ? { name: pipelineName } : {}),
    properties: {
      activities,
      ...(c.parameters && typeof c.parameters === 'object' ? { parameters: c.parameters } : {}),
    },
  };
}

/**
 * Map a binding/lookup error to an HTTP status + structured body shape.
 * Routes use this so the editor always gets `{ ok:false, code, error }`.
 */
export function bindingErrorResponse(e: unknown): {
  status: number;
  body: { ok: false; code?: string; error: string; itemType?: string; itemId?: string };
} {
  if (e instanceof UnboundPipelineError) {
    return { status: 412, body: { ok: false, code: 'unbound', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  if (e instanceof ItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  const msg = (e as any)?.message || String(e);
  return { status: 502, body: { ok: false, error: msg } };
}
