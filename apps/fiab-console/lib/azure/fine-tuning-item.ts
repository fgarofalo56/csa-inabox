/**
 * fine-tuning-item — load/persist helper for the `fine-tuning-job` Loom item,
 * scoped to the caller's tenant (same RBAC pattern as model-serving-item.ts).
 * `[id]` is the Cosmos GUID, NEVER an AOAI fine-tuning-job id.
 *
 * The item's `state` holds:
 *   state.backend         — 'aoai' | 'databricks' display hint (active backend is
 *                           resolved from env, never persisted authoritatively).
 *   state.jobId           — the bound AOAI fine-tuning job id.
 *   state.baseModel       — the base model the job fine-tunes.
 *   state.fineTunedModel  — the resulting model id once the job succeeds.
 *   state.deploymentName  — the AOAI deployment serving the fine-tuned model.
 *   state.deployable      — true only after the safety-eval gate PASSED.
 *   state.safetyEval      — the last safety-eval decision (JSON snapshot).
 *
 * No mocks — a real Cosmos query bound to the caller's tenant.
 */
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const FINE_TUNING_ITEM_TYPE = 'fine-tuning-job';

export class FineTuningItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemId: string) {
    super(`Item ${itemId} (${FINE_TUNING_ITEM_TYPE}) not found in this tenant.`);
    this.name = 'FineTuningItemNotFoundError';
  }
}

export interface FineTuningItemBinding {
  backend?: string;
  jobId?: string;
  baseModel?: string;
  fineTunedModel?: string;
  deploymentName?: string;
  deployable?: boolean;
  safetyEval?: Record<string, unknown>;
  item: WorkspaceItem;
}

/** Load a fine-tuning-job item by id, tenant-scoped via the caller's oid. */
export async function loadFineTuningItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: FINE_TUNING_ITEM_TYPE },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/** Resolve the binding for a fine-tuning-job item (throws not-found). */
export async function resolveFineTuningItem(itemId: string, tenantId: string): Promise<FineTuningItemBinding> {
  const item = await loadFineTuningItem(itemId, tenantId);
  if (!item) throw new FineTuningItemNotFoundError(itemId);
  const state = (item.state || {}) as Record<string, unknown>;
  const str = (k: string) => (typeof state[k] === 'string' ? (state[k] as string).trim() || undefined : undefined);
  return {
    backend: str('backend'),
    jobId: str('jobId'),
    baseModel: str('baseModel'),
    fineTunedModel: str('fineTunedModel'),
    deploymentName: str('deploymentName'),
    deployable: state.deployable === true,
    safetyEval: (state.safetyEval && typeof state.safetyEval === 'object') ? (state.safetyEval as Record<string, unknown>) : undefined,
    item,
  };
}

export interface FineTuningItemPatch {
  backend?: string;
  jobId?: string;
  baseModel?: string;
  fineTunedModel?: string;
  deploymentName?: string;
  deployable?: boolean;
  safetyEval?: Record<string, unknown> | null;
}

/** Persist fine-tuning-item state onto the Cosmos item. Empty string clears a key. */
export async function persistFineTuningItem(
  itemId: string,
  tenantId: string,
  patch: FineTuningItemPatch,
): Promise<WorkspaceItem> {
  const item = await loadFineTuningItem(itemId, tenantId);
  if (!item) throw new FineTuningItemNotFoundError(itemId);
  const nextState: Record<string, unknown> = { ...(item.state || {}) };
  for (const k of ['backend', 'jobId', 'baseModel', 'fineTunedModel', 'deploymentName'] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === '') delete nextState[k];
    else nextState[k] = v;
  }
  if (patch.deployable !== undefined) nextState.deployable = patch.deployable;
  if (patch.safetyEval !== undefined) {
    if (patch.safetyEval === null) delete nextState.safetyEval;
    else nextState.safetyEval = patch.safetyEval;
  }
  const next: WorkspaceItem = { ...item, state: nextState, updatedAt: new Date().toISOString() };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource as WorkspaceItem;
}

/** Map a lookup error to an HTTP status + structured body. */
export function fineTuningItemErrorResponse(e: unknown): { status: number; body: { ok: false; code?: string; error: string } } {
  if (e instanceof FineTuningItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message } };
  }
  return { status: 502, body: { ok: false, error: (e as any)?.message || String(e) } };
}
