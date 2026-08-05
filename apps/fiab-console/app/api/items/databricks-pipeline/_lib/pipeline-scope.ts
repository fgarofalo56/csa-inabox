/**
 * #2996 — item binding for the `databricks-pipeline` (Lakeflow DLT) route
 * family.
 *
 * THE HOLE THIS CLOSES. `POST /api/items/databricks-pipeline/[id]/spec` ran NO
 * authorization beyond `getSession()`. It compiled a CALLER-SUPPLIED canvas
 * model to SQL, wrote it as a workspace notebook to `/Shared/loom-dlt/<name>`
 * with **`overwrite=true`**, and created a DLT pipeline from it. Two distinct
 * impacts, and the second is why this is critical rather than merely leaky:
 *
 *   1. ARBITRARY WRITE INTO A SHARED PATH, WITH CLOBBER. `/Shared/` is common
 *      ground in the ONE Databricks workspace every Loom tenant sits on, and the
 *      target file name came from `model.name` — a request field. `overwrite=true`
 *      means this was not "write your own file", it was "replace someone else's".
 *   2. THE PLANTED CODE THEN EXECUTES. A DLT pipeline is created over that
 *      notebook and runs it as the Console. Plant, then have the platform run it.
 *
 * `databricksConfigGate()` is NOT a guard. It appears throughout this family and
 * reads like one; it checks whether Databricks is CONFIGURED, never whether the
 * caller is AUTHORIZED.
 *
 * TWO LAYERS, BOTH REQUIRED:
 *
 *   LAYER 1 — {@link authorizeDatabricksPipelineItem}, the canonical
 *     `authorizeItemWorkspace` ladder with the workspace resolved FROM THE ITEM,
 *     so authorization cannot be skipped by omitting a parameter. Write-scoped
 *     by default; read scope is opt-in per HANDLER BODY, never per verb.
 *
 *   LAYER 2 — every coordinate bound to the authorized item:
 *
 *       * THE WRITE TARGET is no longer caller-influenced at all.
 *         {@link pipelineLibraryPath} derives it from the ITEM id —
 *         `/Shared/loom-dlt/<item>/<name>` — mirroring `notebook-path-scope.ts`'s
 *         `defaultNotebookRoot`, which gives every item a real, private,
 *         predictable home. See {@link pipelineLibraryPath} for why `overwrite`
 *         is KEPT rather than dropped.
 *
 *       * `pipelineId` — {@link resolveAuthorizedPipelineId}. Omitted, derived
 *         from the item's own binding; supplied, resolved against the PIPELINE'S
 *         OWN `spec.configuration['loom_item_id']` marker. The id recorded in
 *         Cosmos is a client-writable CLAIM, not an attestation — see
 *         `_lib/databricks-resource-binding.ts` for the full reasoning and the
 *         concrete bypass a state-only binding would have left open.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { getDltPipeline } from '@/lib/azure/databricks-client';
import { LOOM_OWNER_KEY, bindResourceToItem } from '@/app/api/items/_lib/databricks-resource-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The Cosmos `itemType` this module scopes. */
export const DBX_PIPELINE_ITEM_TYPE = 'databricks-pipeline';

/** The 404 wording these routes already use — kept so the editor's handling is unchanged. */
export const PIPELINE_NOT_FOUND = 'databricks pipeline not found';

/**
 * Where a `databricks-pipeline` item records its DLT pipeline id. This is the
 * path the pipeline editor persists to (`persistState({ pipelineId })` →
 * `state.content.pipelineId`), so the id this module authorizes is the id the
 * platform actually uses — the same discipline `notebook-path-scope.ts` applies
 * by mirroring `resource-teardown.ts`.
 *
 * (`databricks-pipeline` has no `resource-teardown.ts` case at all — DLT
 * pipelines created here are never torn down. Noted as a separate defect; it
 * does not change what this module must authorize.)
 */
const PIPELINE_CLAIM_PATHS = ['c.state.content.pipelineId'];

// ── Layer 1: authorize the caller against the item ───────────────────────────

export type PipelineAuthz =
  | { item: WorkspaceItem; denied?: undefined }
  | { item?: undefined; denied: NextResponse };

/**
 * Load the `databricks-pipeline` Cosmos item by route `[id]` WITHOUT
 * authorizing. Cross-partition by design — a foreign item must resolve, not
 * fall through unscoped.
 */
export async function loadPipelineItemRaw(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: DBX_PIPELINE_ITEM_TYPE },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Session → workspace authorization → the resolved item.
 *
 * Fails closed when `[id]` names no item: with no item there is no scope to bind
 * a pipeline id or a write path to, so proceeding to Databricks unbound is
 * exactly the fall-through this fix exists to remove.
 */
export async function authorizeDatabricksPipelineItem(
  itemId: string,
  opts: { workspaceId?: string | null; read?: boolean } = {},
): Promise<PipelineAuthz> {
  const session = getSession();
  if (!session) {
    return { denied: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: opts.workspaceId ?? null,
    itemId,
    itemType: DBX_PIPELINE_ITEM_TYPE,
    notFound: PIPELINE_NOT_FOUND,
    ...(opts.read ? { allowReadRoles: true } : {}),
  });
  if (denied) return { denied };
  const item = await loadPipelineItemRaw(itemId);
  if (!item) {
    return { denied: NextResponse.json({ ok: false, error: PIPELINE_NOT_FOUND }, { status: 404 }) };
  }
  return { item };
}

// ── Layer 2a: bind the WRITE TARGET ──────────────────────────────────────────

/** The per-item DLT folder. Every pipeline notebook this item compiles lives here. */
export function pipelineLibraryRoot(itemId: string): string {
  return `/Shared/loom-dlt/${cosmosIdFromLoomId(itemId)}`;
}

/**
 * The workspace path this item's compiled DLT SQL is imported to.
 *
 * WHAT CHANGED AND WHY. The shipped path was `/Shared/loom-dlt/<model.name>` —
 * derived entirely from the REQUEST. Two tenants naming a pipeline
 * `sales_pipeline` collided on one file, and with `overwrite=true` the second
 * write silently replaced the first's code, which the platform then executed.
 * Interposing the item id makes the target un-collidable ACROSS items while
 * staying deterministic and inspectable.
 *
 * WHY `overwrite` IS KEPT. #2996 asks that clobbering a shared artifact be
 * reconsidered "even for an authorized caller". The hazard was never overwrite
 * itself — it was overwrite on a path OTHER TENANTS could address. Re-compiling
 * your own pipeline must replace your own previous SQL (that is what Save
 * means), and dropping overwrite would break every second save with a
 * RESOURCE_ALREADY_EXISTS. With the path scoped to the item the only thing a
 * caller can now clobber is their own previous compile, so overwrite is retained
 * and the shared-path hazard is removed at its actual source.
 *
 * `model.name` still contributes the leaf so the workspace stays readable, but it
 * is sanitised and can no longer escape the item's folder.
 */
export function pipelineLibraryPath(itemId: string, modelName: unknown): string {
  const raw = typeof modelName === 'string' ? modelName : '';
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'pipeline';
  return `${pipelineLibraryRoot(itemId)}/${safe}`;
}

/** The `configuration` block stamping Loom's ownership onto a created pipeline. */
export function ownerConfiguration(itemId: string, base?: Record<string, string>): Record<string, string> {
  return { ...(base || {}), [LOOM_OWNER_KEY]: cosmosIdFromLoomId(itemId) };
}

// ── Layer 2b: bind the pipelineId coordinate ─────────────────────────────────

export type PipelineBinding =
  | { ok: true; pipelineId: string }
  | { ok: false; status: number; error: string };

/** The pipeline id this item CLAIMS (client-writable — never trusted alone). */
export function claimedPipelineId(item: WorkspaceItem): string | null {
  const content = (item.state as Record<string, unknown> | undefined)?.content as
    | Record<string, unknown>
    | undefined;
  const v = content?.pipelineId;
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/** Read Loom's ownership marker off a DLT pipeline's spec configuration. */
export function pipelineOwnerMarker(pipeline: unknown): string | undefined {
  const spec = (pipeline as { spec?: Record<string, unknown> } | undefined)?.spec;
  const config = spec?.configuration ?? (pipeline as Record<string, unknown> | undefined)?.configuration;
  if (!config || typeof config !== 'object') return undefined;
  const v = (config as Record<string, unknown>)[LOOM_OWNER_KEY];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve the DLT pipeline this request may act on.
 *
 * OMITTED → the item's own claimed pipeline (omission is not an escape hatch).
 * SUPPLIED → resolved against the PIPELINE's own ownership marker, so the
 * editor's picker keeps working for pipelines this item owns and refuses every
 * other tenant's.
 */
export async function resolveAuthorizedPipelineId(
  item: WorkspaceItem,
  itemId: string,
  requested: unknown,
): Promise<PipelineBinding> {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  let pipelineId: string;
  if (!asked) {
    const claimed = claimedPipelineId(item);
    if (!claimed) {
      return {
        ok: false,
        status: 409,
        error: 'this pipeline item is not bound to a Databricks pipeline yet — create it first.',
      };
    }
    pipelineId = claimed;
  } else {
    pipelineId = asked;
  }

  let marker: string | undefined;
  try {
    marker = pipelineOwnerMarker(await getDltPipeline(pipelineId));
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : 502;
    return {
      ok: false,
      status,
      error: status === 404 ? PIPELINE_NOT_FOUND : 'could not resolve that Databricks pipeline.',
    };
  }

  const verdict = await bindResourceToItem({
    itemType: DBX_PIPELINE_ITEM_TYPE,
    itemId,
    resourceId: pipelineId,
    marker,
    paths: PIPELINE_CLAIM_PATHS,
  });
  if (!verdict.ok) return verdict;
  return { ok: true, pipelineId };
}
