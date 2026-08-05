/**
 * #2997 — item binding for the `databricks-job` route family.
 *
 * THE HOLE THIS CLOSES. `POST /api/items/databricks-job/[id]/run?jobId=` ran NO
 * authorization beyond `getSession()` and called `runJob` on a CALLER-SUPPLIED
 * `jobId`. Its handler signature was `POST(req)` — it did not accept
 * `ctx.params`, so `[id]` was not merely unenforced, it was never read. The
 * Console UAMI holds workspace-wide access to the ONE shared Databricks
 * workspace every Loom tenant sits on, so any signed-in user could execute any
 * tenant's job, as the Console. `[id]` GET/PUT/DELETE, `[id]/runs` and
 * `[id]/run-output` were identical.
 *
 * `databricksConfigGate()` is NOT a guard. It appears in this family and reads
 * like one; it checks whether a Databricks workspace is CONFIGURED, never
 * whether the caller is AUTHORIZED. Auditing this family by grepping for a
 * gate-shaped call marks these routes protected. They were not.
 *
 * TWO LAYERS, BOTH REQUIRED (the shape #2985/#2995 established for notebooks —
 * jobs are not notebooks, so those modules do not apply and this is the
 * job-specific sibling):
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the job ITEM.
 *     {@link authorizeDatabricksJobItem} runs the canonical
 *     `authorizeItemWorkspace` ladder (owner → tenant-admin → shared-ACL). The
 *     workspace is resolved FROM THE ITEM when the caller omits `workspaceId`,
 *     so authorization cannot be skipped by dropping a parameter. Write scope is
 *     the DEFAULT and read scope is opt-in per HANDLER BODY, not per verb —
 *     #2973 found three GETs in this family that mutate while polling.
 *
 *   LAYER 2 — BIND THE COORDINATE to that authorized item. Authorizing the
 *     caller is necessary and NOT sufficient: that is precisely the
 *     `[id]/schedule` defect #2995 fixed, where an authorized caller could
 *     schedule a job running another tenant's notebook. Here:
 *
 *       * `jobId` — {@link resolveAuthorizedJobId}. Omitted, it is DERIVED from
 *         the item's own recorded binding, so omission is not an escape hatch.
 *         Supplied, it must resolve to the job this item owns. Ownership is read
 *         from the job's own `settings.tags['loom_item_id']` — see
 *         `_lib/databricks-resource-binding.ts` for why the id recorded in
 *         Cosmos is a CLAIM and not an attestation.
 *
 *       * `runId` — {@link resolveAuthorizedRunId}. This is the job family's
 *         analogue of the `contextId` pivot #2995 found, and the issue does not
 *         name it: `[id]/run-output?runId=` accepts a run id with NO job
 *         coordinate at all and returns `runs/get-output` — the notebook return
 *         value, the stdout logs, and the error trace of that run. That is the
 *         OUTPUT of another tenant's execution, reachable without ever naming
 *         their job. A run id is therefore resolved to its parent job
 *         (`runs/get`) and that job must be the one this item owns.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { getJob, getJobRun, type JobSpec } from '@/lib/azure/databricks-client';
import { LOOM_OWNER_KEY, bindResourceToItem } from '@/app/api/items/_lib/databricks-resource-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The Cosmos `itemType` this module scopes. */
export const DBX_JOB_ITEM_TYPE = 'databricks-job';

/** The 404 wording these routes already use — kept so the editor's handling is unchanged. */
export const JOB_NOT_FOUND = 'databricks job not found';

/**
 * The Cosmos JSON paths where a `databricks-job` item records its Databricks job
 * id. IDENTICAL to `resource-teardown.ts`'s resolution for this item type
 * (`sid(item,'jobId') || resourceId(item)`), so the id this module authorizes is
 * the id the platform actually deletes. A divergence between the two would mean
 * we gate a job the platform does not use.
 */
const JOB_CLAIM_PATHS = [
  'c.state.provisioning.secondaryIds.jobId',
  'c.state.provisioning.resourceId',
];

// ── Layer 1: authorize the caller against the item ───────────────────────────

export type JobAuthz =
  | { item: WorkspaceItem; session: SessionPayload; denied?: undefined }
  | { item?: undefined; session?: undefined; denied: NextResponse };

/**
 * Load the `databricks-job` Cosmos item by route `[id]` WITHOUT authorizing —
 * this only answers "which item is this, and what does it claim". Callers MUST
 * have already run `authorizeItemWorkspace`.
 *
 * Cross-partition by design: the item must be found even when it belongs to a
 * workspace the caller does not own, otherwise a foreign item would resolve to
 * "no item" and fall through unscoped.
 */
export async function loadJobItemRaw(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: DBX_JOB_ITEM_TYPE },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Session → workspace authorization → the resolved item.
 *
 * `read` is opt-in and must be decided from the HANDLER BODY: pass it only when
 * the handler performs no Databricks write. Every other consumer stays
 * write-scoped so a read-only Viewer cannot run, reset, or delete a job merely
 * because a read was made to work.
 *
 * `authorizeItemWorkspace`'s one permissive case — an `[id]` naming no item of
 * this type anywhere in the estate — is closed here rather than inherited: with
 * no item there is no scope to bind a jobId to, so we return the route's own 404
 * instead of proceeding to Databricks unbound. Fail closed, not fall through.
 */
export async function authorizeDatabricksJobItem(
  itemId: string,
  opts: { workspaceId?: string | null; read?: boolean } = {},
): Promise<JobAuthz> {
  const session = getSession();
  if (!session) {
    return { denied: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: opts.workspaceId ?? null,
    itemId,
    itemType: DBX_JOB_ITEM_TYPE,
    notFound: JOB_NOT_FOUND,
    ...(opts.read ? { allowReadRoles: true } : {}),
  });
  if (denied) return { denied };
  const item = await loadJobItemRaw(itemId);
  if (!item) {
    return { denied: NextResponse.json({ ok: false, error: JOB_NOT_FOUND }, { status: 404 }) };
  }
  return { item, session };
}

// ── Layer 2a: bind the jobId coordinate ──────────────────────────────────────

export type JobBinding =
  | { ok: true; jobId: number; stamp: boolean }
  | { ok: false; status: number; error: string };

/** The job id this item CLAIMS, resolved exactly as `resource-teardown.ts` does. */
export function claimedJobId(item: WorkspaceItem): number | null {
  const prov = (item.state as Record<string, unknown> | undefined)?.provisioning as
    | Record<string, unknown>
    | undefined;
  const sid = (prov?.secondaryIds as Record<string, unknown> | undefined)?.jobId;
  const rid = prov?.resourceId;
  for (const raw of [sid, rid]) {
    const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    // The teardown sibling excludes non-numeric `resourceId` for the same
    // reason: a provisioner stores a RUN id or a name there for other kinds.
    if (s && /^\d+$/.test(s)) return Number(s);
  }
  return null;
}

/** Read Loom's ownership marker off a Databricks job's settings. */
export function jobOwnerMarker(settings: JobSpec | undefined): string | undefined {
  const tags = (settings as Record<string, unknown> | undefined)?.tags;
  if (!tags || typeof tags !== 'object') return undefined;
  const v = (tags as Record<string, unknown>)[LOOM_OWNER_KEY];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve the Databricks job this request may act on.
 *
 * OMITTED → the item's own claimed job. Deriving rather than 400-ing matters:
 * per `auto-bind-by-default.md` the platform resolves the binding, not the user,
 * and a required-parameter error is a shape a caller can probe around whereas a
 * derived value is not caller-influenced at all. An item that claims nothing has
 * nothing to run — that is a precise 409, not a fall-through.
 *
 * SUPPLIED → still fully bound. The supplied id is NOT trusted because it
 * matches the item's claim (the claim is client-writable); it is resolved
 * against the JOB'S OWN ownership marker. The editor's "pick a different job"
 * affordance therefore keeps working for jobs this item owns and refuses for
 * every other tenant's.
 */
export async function resolveAuthorizedJobId(
  item: WorkspaceItem,
  itemId: string,
  requested: unknown,
): Promise<JobBinding> {
  const askedRaw =
    typeof requested === 'string' ? requested.trim() : typeof requested === 'number' ? String(requested) : '';
  let jobId: number;
  if (!askedRaw) {
    const claimed = claimedJobId(item);
    if (claimed === null) {
      return {
        ok: false,
        status: 409,
        error: 'this job item is not bound to a Databricks job yet — save the job to create it.',
      };
    }
    jobId = claimed;
  } else {
    if (!/^\d+$/.test(askedRaw)) {
      return { ok: false, status: 400, error: 'jobId must be numeric.' };
    }
    jobId = Number(askedRaw);
  }

  let marker: string | undefined;
  try {
    const job = await getJob(jobId);
    marker = jobOwnerMarker(job.settings);
  } catch (e: any) {
    // A job the workspace cannot resolve is not an authorized one. 404 is
    // preserved so we never confirm the existence of another tenant's job.
    const status = e?.status === 404 ? 404 : 502;
    return {
      ok: false,
      status,
      error: status === 404 ? JOB_NOT_FOUND : 'could not resolve that Databricks job.',
    };
  }

  const verdict = await bindResourceToItem({
    itemType: DBX_JOB_ITEM_TYPE,
    itemId,
    resourceId: String(jobId),
    marker,
    paths: JOB_CLAIM_PATHS,
  });
  if (!verdict.ok) return verdict;
  return { ok: true, jobId, stamp: verdict.stamp };
}

// ── Layer 2b: bind the runId coordinate (the live-output pivot) ──────────────

export type RunBinding =
  | { ok: true; runId: number; jobId: number }
  | { ok: false; status: number; error: string };

/**
 * Resolve a caller-supplied `runId` to its parent job and require that job to be
 * this item's.
 *
 * A run id is a SEPARATE pivot from a job id, which is why binding `jobId` alone
 * would have left `[id]/run-output` open: that route never accepted a job
 * coordinate at all. `runs/get-output` returns the notebook return value, the
 * stdout logs, and the error trace — another tenant's execution OUTPUT, which is
 * frequently the data itself. The same reasoning #2995 applied to `contextId`
 * (live state reachable without naming the resource that produced it) applies
 * here.
 */
export async function resolveAuthorizedRunId(
  item: WorkspaceItem,
  itemId: string,
  requested: unknown,
): Promise<RunBinding> {
  const raw =
    typeof requested === 'string' ? requested.trim() : typeof requested === 'number' ? String(requested) : '';
  if (!raw || !/^\d+$/.test(raw)) {
    return { ok: false, status: 400, error: 'runId is required.' };
  }
  const runId = Number(raw);

  let parentJobId: number | null = null;
  try {
    const run = await getJobRun(runId);
    parentJobId = typeof run?.job_id === 'number' ? run.job_id : null;
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : 502;
    return {
      ok: false,
      status,
      error: status === 404 ? 'run not found' : 'could not resolve that Databricks run.',
    };
  }
  if (parentJobId === null) {
    // A run with no parent job is a one-time `runs/submit` — it belongs to no
    // job, so no item owns it and there is nothing to authorize it against.
    return { ok: false, status: 403, error: 'that run is not owned by this job item.' };
  }

  const bound = await resolveAuthorizedJobId(item, itemId, String(parentJobId));
  if (!bound.ok) {
    return { ok: false, status: bound.status === 404 ? 404 : 403, error: 'that run is not owned by this job item.' };
  }
  return { ok: true, runId, jobId: bound.jobId };
}

// ── Stamping: record ownership on the Databricks side ────────────────────────

/**
 * Merge Loom's ownership marker into a job spec. Applied on every WRITE path
 * (create + reset) so ownership is established at birth and cannot be dropped by
 * a later save — `jobs/reset` replaces settings wholesale, so a spec that simply
 * omitted `tags` would silently un-own the job and re-open legacy adoption.
 *
 * Never called from a read-only handler: #2973 found three GETs in this family
 * mutating while polling, and this must not become a fourth.
 */
export function withOwnerTag(spec: JobSpec, itemId: string): JobSpec {
  const existing = (spec as Record<string, unknown>).tags;
  const tags: Record<string, unknown> =
    existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
  tags[LOOM_OWNER_KEY] = cosmosIdFromLoomId(itemId);
  return { ...spec, tags } as JobSpec;
}
