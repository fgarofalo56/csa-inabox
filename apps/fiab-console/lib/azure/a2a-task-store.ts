/**
 * a2a-task-store — Cosmos persistence for WS-5.2 A2A delegated tasks.
 *
 * The pure A2A dispatcher (a2a-protocol.ts) is store-agnostic: it calls injected
 * `saveTask` / `loadTask` closures. This module provides the REAL Cosmos-backed
 * implementation (the `a2a-tasks` container, PK /tenantId, TTL 7 days), scoped to
 * the delegating caller's tenant so `tasks/get` only ever returns a task from the
 * caller's own tenant — never another tenant's delegated work.
 *
 * A stored doc wraps the A2A `Task` with the partition key + the acting caller so
 * the trail shows who delegated it. No mocks — real Cosmos point-reads/writes
 * (no-vaporware.md). Azure-native (Cosmos DB); no Fabric.
 */

import { a2aTasksContainer } from '@/lib/azure/cosmos-client';
import type { A2aTask } from '@/lib/copilot/a2a-protocol';

interface StoredA2aTask {
  id: string;
  tenantId: string;
  /** oid of the caller who delegated the task (owner-scoping the read). */
  actorOid: string;
  task: A2aTask;
  updatedAt: string;
}

/** Persist (upsert) a delegated task for a tenant. Never throws to the caller
 *  path beyond the Cosmos error — the dispatcher wraps saves in try/catch. */
export async function saveA2aTask(task: A2aTask, tenantId: string, actorOid: string): Promise<void> {
  const c = await a2aTasksContainer();
  const doc: StoredA2aTask = {
    id: task.id,
    tenantId,
    actorOid,
    task,
    updatedAt: new Date().toISOString(),
  };
  await c.items.upsert(doc);
}

/** Load a delegated task by id, tenant-scoped. Returns null when unknown. */
export async function loadA2aTask(id: string, tenantId: string): Promise<A2aTask | null> {
  const c = await a2aTasksContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<StoredA2aTask>();
    return resource?.task ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}
