/**
 * Workspaces / Items API client (BFF /api/* routes, Cosmos-backed).
 *
 * ── #3547: THE RAW-HTML LEAK ────────────────────────────────────────────────
 *
 * Every function here goes through one `fetchJson`, and it used to be a LOCAL
 * `fetch` wrapper that did, on any non-2xx:
 *
 *     detail = await res.text();
 *     throw new Error(`${res.status} ${res.statusText}: ${detail}`);
 *
 * Behind the deployment edge (Azure Front Door → Container Apps ingress) a
 * stalled or failed route answers with an HTML error PAGE, not JSON. So on
 * 2026-08-15, creating a `sql-server-2025-vector-index` item during a loaded V&V
 * pass, `res.text()` returned the 504 interstitial and the "Name your…" dialog
 * rendered the literal `<!DOCTYPE html …><style>body { font-family: Arial …`
 * into its error MessageBar. `lib/client-fetch.ts` carries the warning against
 * exactly this — and the ready-made helper, `describeNonJsonResponse` — but this
 * module never used either, because it had its own transport.
 *
 * It now uses `clientFetch` (bounded timeout, credentialed, session-refresh
 * retry, honest timeout copy) and maps a non-2xx through the JSON body when
 * there is one and `describeNonJsonResponse` when there is not. The raw body is
 * never concatenated into the message.
 *
 * Blast radius of the old shape, for the record: `listWorkspaces`,
 * `getWorkspace`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`,
 * `listItems`, `createItem`, `getItem`, `updateItem`, `deleteItem`,
 * `listFolders`, `createFolder` — every one of them.
 */
import { clientFetch, describeNonJsonResponse } from '@/lib/client-fetch';

export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
  /**
   * ARM resource id of the storage account bound to this workspace for OneLake
   * lifecycle management. Absent = use the deployment-default DLZ account.
   */
  storageAccountId?: string;
  /** Derived: LOOM_ONELAKE_BASE + name. Only present on GET /api/workspaces/[id]. */
  oneLake?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent open. Optional — older docs may lack it. */
  lastAccessedAt?: string;
  /** Aggregated item count. Only present on GET /api/workspaces?count=true. */
  itemCount?: number;
  /**
   * Custom workspace image metadata (Power BI-style avatar). Present when an
   * image has been uploaded; the bytes are served by
   * GET /api/workspaces/[id]/image. Absent = render the default initial glyph.
   */
  image?: {
    contentType: string;
    size: number;
    updatedAt: string;
    updatedBy: string;
  };
}

export interface WorkspaceItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  /** Optional folder this item lives in (null = workspace root). */
  folderId?: string | null;
  state?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFolder {
  id: string;
  workspaceId: string;
  name: string;
  parent?: string | null;
  createdBy: string;
  createdAt: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

/** The label `describeNonJsonResponse` puts in front of its gateway copy. */
const SERVICE_LABEL = 'The workspaces service';

/**
 * Turn a non-2xx into a message a MessageBar can show.
 *
 * The body is READ ONCE and PARSED — never concatenated. A JSON error envelope
 * is the BFF's own words and is the best available reason, so it wins; anything
 * else (an HTML interstitial, an empty body, a truncated stream) is the edge
 * talking, and gets the status-mapped sentence from `client-fetch` instead.
 *
 * Note what this deliberately does NOT do: it never says WHY the gateway failed.
 * `describeNonJsonResponse` states only what the status establishes
 * (deploy-integrity.md R7) — the same reason `client-fetch`'s timeout copy stopped
 * blaming cross-subscription fan-out (#3546).
 */
async function errorFromResponse(res: Response): Promise<Error> {
  let raw = '';
  try { raw = await res.text(); } catch { /* body unreadable — treated as non-JSON */ }
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const reason = typeof o.error === 'string' && o.error
      ? o.error
      : typeof o.message === 'string' && o.message ? o.message : '';
    if (reason) return new Error(`${reason} (HTTP ${res.status})`);
  }
  // Not JSON — an HTML error page or an empty body. NEVER echo it.
  return new Error(describeNonJsonResponse(res.status, SERVICE_LABEL));
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  // `API_BASE` is empty in every shipped configuration (nothing sets
  // NEXT_PUBLIC_API_BASE), but the concatenation is preserved so this module's
  // behaviour does not change with the transport. A computed string is a wide
  // `string` to `ValidateApiPath`, which is the documented pass-through.
  const url = `${API_BASE}${path}`;
  const res = await clientFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw await errorFromResponse(res);
  // A 2xx can be non-JSON too — the edge can answer 200 with an interstitial.
  // `res.json()` would then throw a SyntaxError quoting the HTML, which is the
  // same leak by another door.
  try {
    return await res.json() as T;
  } catch {
    throw new Error(describeNonJsonResponse(res.status, SERVICE_LABEL));
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return fetchJson<Workspace[]>('/api/workspaces');
}

/**
 * List workspaces enriched with `itemCount` per workspace. Uses a single
 * cross-partition aggregate on the items container. If the aggregate fails,
 * the BFF gracefully falls back to the un-enriched list (no `itemCount`).
 */
export async function listWorkspacesWithCounts(): Promise<Workspace[]> {
  return fetchJson<Workspace[]>('/api/workspaces?count=true');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`);
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
}): Promise<Workspace> {
  return fetchJson<Workspace>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'capacity' | 'domain' | 'storageAccountId'>>): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// --- Workspace-delete cascade (Azure backend teardown) --------------------

export type TeardownResourceStatus = 'deleted' | 'not_found' | 'skipped' | 'error';

export interface TeardownResourceResult {
  kind: string;
  ref: string;
  result: TeardownResourceStatus;
  error?: string;
}

export interface TeardownOutcome {
  itemId: string;
  itemType: string;
  displayName: string;
  resources: TeardownResourceResult[];
}

/**
 * Delete a workspace. By default this is catalog-only — the underlying Azure
 * resources are retained. Pass `{ cascade: true }` to ALSO delete each item's
 * provisioned Azure backend; the returned `teardown` receipt lists the outcome
 * per resource.
 */
export async function deleteWorkspace(
  id: string,
  opts?: { cascade?: boolean },
): Promise<{ ok: boolean; teardown?: TeardownOutcome[] }> {
  const qs = opts?.cascade ? '?cascade=true' : '';
  return fetchJson<{ ok: boolean; teardown?: TeardownOutcome[] }>(`/api/workspaces/${id}${qs}`, {
    method: 'DELETE',
  });
}

export interface BulkDeleteResult {
  ok: boolean;
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
  /** Per-workspace-id teardown receipts (only present when cascade was set). */
  teardown?: Record<string, TeardownOutcome[]>;
}

/** Multi-delete. The server authorizes per workspace: tenant admins delete
 * anything; every caller can delete the workspaces they OWN. Non-owned ids come
 * back as per-id `forbidden`/`not_found` failures. Pass `{ cascade: true }` to
 * also delete each item's provisioned Azure backend. */
export async function bulkDeleteWorkspaces(
  ids: string[],
  opts?: { cascade?: boolean },
): Promise<BulkDeleteResult> {
  return fetchJson<BulkDeleteResult>('/api/workspaces/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids, cascade: opts?.cascade === true }),
  });
}

/** Probe bulk-delete affordances. `canBulkDelete` is true for any authenticated
 * user (they can delete their own workspaces); `isAdmin` marks tenant admins. */
export async function getWorkspaceAdminStatus(): Promise<{ ok: boolean; isAdmin: boolean; canBulkDelete: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/workspaces/bulk-delete`, { credentials: 'include' });
    if (!res.ok) return { ok: false, isAdmin: false, canBulkDelete: false };
    const j = await res.json();
    return { ok: !!j.ok, isAdmin: !!j.isAdmin, canBulkDelete: j.canBulkDelete !== false };
  } catch {
    return { ok: false, isAdmin: false, canBulkDelete: false };
  }
}

export async function listItems(workspaceId: string): Promise<WorkspaceItem[]> {
  return fetchJson<WorkspaceItem[]>(`/api/workspaces/${workspaceId}/items`);
}

export async function createItem(workspaceId: string, input: {
  itemType: string;
  displayName: string;
  description?: string;
  /** F17 custom-attribute values, keyed by attribute id. Stored on the item's state. */
  customAttributes?: Record<string, unknown>;
}): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/workspaces/${workspaceId}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getItem(type: string, id: string): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/cosmos-items/${type}/${id}`);
}

export async function updateItem(type: string, id: string, patch: Partial<Pick<WorkspaceItem, 'displayName' | 'description' | 'state'>>): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/cosmos-items/${type}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteItem(type: string, id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/cosmos-items/${type}/${id}`, { method: 'DELETE' });
}

// --- Folders --------------------------------------------------------------

export async function listFolders(workspaceId: string): Promise<WorkspaceFolder[]> {
  const res = await fetchJson<{ ok: boolean; folders: WorkspaceFolder[] }>(
    `/api/workspaces/${workspaceId}/folders`,
  );
  return res.folders ?? [];
}

export async function createFolder(
  workspaceId: string,
  input: { name: string; parent?: string | null },
): Promise<WorkspaceFolder> {
  const res = await fetchJson<{ ok: boolean; folder: WorkspaceFolder }>(
    `/api/workspaces/${workspaceId}/folders`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return res.folder;
}

export async function renameFolder(
  workspaceId: string,
  folderId: string,
  name: string,
): Promise<WorkspaceFolder> {
  const res = await fetchJson<{ ok: boolean; folder: WorkspaceFolder }>(
    `/api/workspaces/${workspaceId}/folders`,
    { method: 'PATCH', body: JSON.stringify({ id: folderId, name }) },
  );
  return res.folder;
}

export async function deleteFolder(workspaceId: string, folderId: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/folders?id=${encodeURIComponent(folderId)}`,
    { method: 'DELETE' },
  );
}

// --- Item-in-workspace ops (move / rename / delete) ----------------------

export async function patchWorkspaceItem(
  workspaceId: string,
  itemId: string,
  patch: { folderId?: string | null; displayName?: string },
): Promise<WorkspaceItem> {
  const res = await fetchJson<{ ok: boolean; item: WorkspaceItem }>(
    `/api/workspaces/${workspaceId}/items/${itemId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return res.item;
}

export async function deleteWorkspaceItem(workspaceId: string, itemId: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/items/${itemId}`,
    { method: 'DELETE' },
  );
}

// --- Task flows (F11) -----------------------------------------------------

export interface TaskFlowStep {
  id: string;
  label: string;
  /** Optional ref to a real WorkspaceItem.id this step represents. */
  itemId?: string | null;
  itemType?: string | null;
  note?: string;
  /** @xyflow/react canvas position. */
  x: number;
  y: number;
}

export interface TaskFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface TaskFlow {
  id: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  steps: TaskFlowStep[];
  edges: TaskFlowEdge[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function listTaskFlows(workspaceId: string): Promise<TaskFlow[]> {
  const res = await fetchJson<{ ok: boolean; flows: TaskFlow[] }>(
    `/api/workspaces/${workspaceId}/task-flows`,
  );
  return res.flows ?? [];
}

export async function createTaskFlow(
  workspaceId: string,
  input: { displayName: string; description?: string },
): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return res.flow;
}

export async function getTaskFlow(workspaceId: string, id: string): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
  );
  return res.flow;
}

export async function saveTaskFlow(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<TaskFlow, 'steps' | 'edges' | 'displayName' | 'description'>>,
): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
    { method: 'PUT', body: JSON.stringify(patch) },
  );
  return res.flow;
}

export async function deleteTaskFlow(workspaceId: string, id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
    { method: 'DELETE' },
  );
}

// --- Task-flow execution (F11 run) ----------------------------------------
// The persisted run-doc shape is owned by lib/taskflow/step-runner (FlowRunDoc);
// the client re-exports the pieces it renders as a light structural type so it
// need not import the server module's transitive graph.

export interface TaskFlowRunItem {
  itemId: string;
  itemType: string;
  itemLabel?: string;
  runId: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  reason?: string;
  detail?: string;
}
export interface TaskFlowRunStep {
  stepId: string;
  label: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  itemRuns: TaskFlowRunItem[];
}
export interface TaskFlowRun {
  id: string;
  runId: string;
  flowId: string;
  workspaceId: string;
  flowName: string;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  steps: TaskFlowRunStep[];
  startedAt: string;
  finishedAt?: string;
  startedBy?: string;
  error?: string;
}

/** Kick off a run of the flow. Returns immediately with the new runId. */
export async function runTaskFlow(workspaceId: string, flowId: string): Promise<string> {
  const res = await fetchJson<{ ok: boolean; runId: string }>(
    `/api/workspaces/${workspaceId}/task-flows/${flowId}/run`,
    { method: 'POST' },
  );
  return res.runId;
}

/** Poll a single run document. */
export async function getTaskFlowRun(
  workspaceId: string,
  flowId: string,
  runId: string,
): Promise<TaskFlowRun> {
  const res = await fetchJson<{ ok: boolean; run: TaskFlowRun }>(
    `/api/workspaces/${workspaceId}/task-flows/${flowId}/run?runId=${encodeURIComponent(runId)}`,
  );
  return res.run;
}

/** List the last 20 runs of a flow (history flyout). */
export async function listTaskFlowRuns(
  workspaceId: string,
  flowId: string,
): Promise<TaskFlowRun[]> {
  const res = await fetchJson<{ ok: boolean; runs: TaskFlowRun[] }>(
    `/api/workspaces/${workspaceId}/task-flows/${flowId}/run`,
  );
  return res.runs ?? [];
}
