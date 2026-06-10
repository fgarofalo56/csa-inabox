/**
 * Task-flow service layer (F11) — pure Cosmos CRUD for the visual task-flow
 * step-sequence canvases, factored out so BOTH the owner route
 * (`app/api/workspaces/[id]/task-flows`) and the tenant-admin route
 * (`app/api/admin/workspaces/[id]/task-flows`) call the SAME validated ops.
 *
 * A task flow is a Loom-native object (Fabric parity with the Fabric workspace
 * "task flow" canvas) — NO Fabric dependency. It's backed entirely by the
 * Cosmos `task-flows` container (PK /workspaceId, see cosmos-client.ts). Steps
 * carry @xyflow/react canvas positions and optional refs to real WorkspaceItem
 * ids; edges are the directed links between steps. Real Cosmos data-plane (per
 * no-vaporware.md); no mocks.
 *
 * Pattern mirrors jupyter-server-client.ts: pure functions, no HTTP, no
 * session — the caller authorizes, this layer just talks to Cosmos.
 */
import crypto from 'node:crypto';
import { taskFlowsContainer } from '@/lib/azure/cosmos-client';

/** A single node on the task-flow canvas. */
export interface TaskFlowStep {
  id: string;
  label: string;
  /** Optional ref to a real WorkspaceItem.id that this step represents. */
  itemId?: string | null;
  /** Cached item type for icon rendering (the item is the source of truth). */
  itemType?: string | null;
  /** Free-text note shown on the step card / detail. */
  note?: string;
  /** @xyflow/react canvas position. */
  x: number;
  y: number;
}

/** A directed link between two steps on the canvas. */
export interface TaskFlowEdge {
  id: string;
  source: string; // TaskFlowStep.id
  target: string; // TaskFlowStep.id
  label?: string;
}

/** A workspace task flow (one Cosmos doc, PK /workspaceId). */
export interface TaskFlow {
  id: string;
  workspaceId: string; // partition key
  displayName: string;
  description?: string;
  steps: TaskFlowStep[];
  edges: TaskFlowEdge[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** List task flows in a workspace, newest-updated first. */
export async function dbListTaskFlows(workspaceId: string): Promise<TaskFlow[]> {
  const c = await taskFlowsContainer();
  const { resources } = await c.items
    .query<TaskFlow>(
      {
        query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.updatedAt DESC',
        parameters: [{ name: '@w', value: workspaceId }],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  return resources;
}

/** Point-read a single task flow. Returns null on 404. */
export async function dbGetTaskFlow(workspaceId: string, id: string): Promise<TaskFlow | null> {
  const c = await taskFlowsContainer();
  try {
    const { resource } = await c.item(id, workspaceId).read<TaskFlow>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Create an empty task flow (no steps/edges yet). */
export async function dbCreateTaskFlow(
  workspaceId: string,
  input: Pick<TaskFlow, 'displayName' | 'description'>,
  createdBy: string,
): Promise<TaskFlow> {
  const name = (input.displayName || '').trim();
  if (!name) throw new Error('displayName required');
  const now = new Date().toISOString();
  const doc: TaskFlow = {
    id: crypto.randomUUID(),
    workspaceId,
    displayName: name,
    description: (input.description || '').trim() || undefined,
    steps: [],
    edges: [],
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const c = await taskFlowsContainer();
  const { resource } = await c.items.create(doc);
  return resource as TaskFlow;
}

/**
 * Patch a task flow (full-canvas save or metadata edit). Point-reads the
 * existing doc then replaces — standard Cosmos optimistic upsert. Only the
 * supplied keys are merged; createdBy/createdAt/id/workspaceId are preserved.
 * Throws 'task flow not found' on 404.
 */
export async function dbUpsertTaskFlow(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<TaskFlow, 'displayName' | 'description' | 'steps' | 'edges'>>,
  updatedAt: string,
): Promise<TaskFlow> {
  const c = await taskFlowsContainer();
  const existing = await dbGetTaskFlow(workspaceId, id);
  if (!existing) throw new Error('task flow not found');
  const next: TaskFlow = {
    ...existing,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() || existing.displayName } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
    ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
    ...(patch.edges !== undefined ? { edges: patch.edges } : {}),
    updatedAt,
  };
  const { resource } = await c.item(id, workspaceId).replace(next);
  return resource as TaskFlow;
}

/** Delete a task flow. A 404 is swallowed (idempotent delete). */
export async function dbDeleteTaskFlow(workspaceId: string, id: string): Promise<void> {
  const c = await taskFlowsContainer();
  try {
    await c.item(id, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}
