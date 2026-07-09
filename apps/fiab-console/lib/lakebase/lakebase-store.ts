/**
 * Lakebase (lakebase-postgres) — per-item persistence (DBX-4).
 *
 * The item's bound Flexible Server, working database, backend selection, and
 * the branch/snapshot history are stored on the item's `state.lakebase` in
 * Cosmos (partition = workspaceId). This is the single source of truth the
 * editor + BFF routes read/write. All writes go through resolveItemAccessByOid
 * at the route layer, so only a caller with write access can mutate the item.
 *
 * Mirrors lib/apps/runtime-store.ts (DBX-1).
 */

import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const LAKEBASE_ITEM_TYPE = 'lakebase-postgres';

export type LakebaseBackend = 'postgres' | 'databricks';

/** A recorded point-in-time snapshot marker (drives a real PITR branch). */
export interface LakebaseSnapshot {
  id: string;
  label: string;
  /** ISO-8601 UTC point-in-time captured. */
  pointInTimeUTC: string;
  createdAt: string;
  by?: string;
}

/** A branch = a real PITR restore into a NEW flexible server. */
export interface LakebaseBranch {
  id: string;
  name: string;
  /** Restored-to point-in-time (ISO UTC). */
  pointInTimeUTC: string;
  /** ARM resource id of the branch server. */
  serverId?: string;
  provisioningState?: string;
  createdAt: string;
  by?: string;
}

export interface LakebaseBoundServer {
  name: string;
  id: string;
  fqdn: string;
  resourceGroup?: string;
  location?: string;
}

export interface LakebaseState {
  /** Selected backend — Azure-native Flexible Server is the DEFAULT. */
  backend?: LakebaseBackend;
  /** The bound Flexible Server (Azure-native backend). */
  server?: LakebaseBoundServer;
  /** For the Databricks backend: the bound Lakebase instance name. */
  databricksInstance?: string;
  /** Working database name (defaults to 'postgres'). */
  database?: string;
  /** True once pgvector is allowlisted + CREATE EXTENSION has run. */
  pgvectorEnabled?: boolean;
  /** Point-in-time snapshot markers (newest first, capped). */
  snapshots?: LakebaseSnapshot[];
  /** PITR branch history (newest first, capped). */
  branches?: LakebaseBranch[];
  updatedAt?: string;
}

const MAX_HISTORY = 50;

/** Read the lakebase slice off an item (empty object when never configured). */
export function readLakebase(item: WorkspaceItem): LakebaseState {
  const s = (item.state as any)?.lakebase;
  return (s && typeof s === 'object') ? (s as LakebaseState) : {};
}

/** The effective backend for an item — Azure-native Postgres is the default. */
export function effectiveBackend(item: WorkspaceItem): LakebaseBackend {
  return readLakebase(item).backend === 'databricks' ? 'databricks' : 'postgres';
}

/**
 * Merge a patch into state.lakebase and persist. Caps branch/snapshot history.
 * Caller MUST have already authorized write (resolveItemAccessByOid → canWrite).
 */
export async function saveLakebase(item: WorkspaceItem, patch: Partial<LakebaseState>): Promise<WorkspaceItem> {
  const current = readLakebase(item);
  const merged: LakebaseState = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (merged.snapshots && merged.snapshots.length > MAX_HISTORY) merged.snapshots = merged.snapshots.slice(0, MAX_HISTORY);
  if (merged.branches && merged.branches.length > MAX_HISTORY) merged.branches = merged.branches.slice(0, MAX_HISTORY);
  const next: WorkspaceItem = {
    ...item,
    state: { ...(item.state || {}), lakebase: merged },
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource ?? next;
}

/** Prepend a snapshot marker (capped). */
export async function recordSnapshot(item: WorkspaceItem, snap: LakebaseSnapshot): Promise<WorkspaceItem> {
  const current = readLakebase(item);
  const snapshots = [snap, ...(current.snapshots || [])].slice(0, MAX_HISTORY);
  return saveLakebase(item, { snapshots });
}

/** Prepend a branch record (capped). */
export async function recordBranch(item: WorkspaceItem, branch: LakebaseBranch): Promise<WorkspaceItem> {
  const current = readLakebase(item);
  const branches = [branch, ...(current.branches || [])].slice(0, MAX_HISTORY);
  return saveLakebase(item, { branches });
}
