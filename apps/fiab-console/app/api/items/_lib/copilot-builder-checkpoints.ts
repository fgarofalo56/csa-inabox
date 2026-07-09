/**
 * copilot-builder-checkpoints.ts — GENERIC point-in-time snapshots of an item's
 * Loom-native authoring doc, so any Copilot builder pane can apply NL edits with
 * a safety net (checkpoint → apply → restore).
 *
 * This is the surface-agnostic generalization of the semantic-model
 * `semantic-model-checkpoints.ts` helper (audit-T82). Instead of hard-coding the
 * `model` + `modelCheckpoints` state keys, each caller names WHICH `item.state`
 * keys hold its authoring doc (e.g. eventstream → ['topology'], mirrored-database
 * → ['mirrorConfig']). The snapshots live on the SAME Cosmos `items` container
 * under `item.state.<checkpointsKey>` — NO new Cosmos container, NO new env var,
 * NO Power BI / Fabric dependency (works with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset). The Loom-native item.state is the source of truth.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { loadOwnedItem, updateOwnedItem } from './item-crud';

/** Max checkpoints retained per item (oldest dropped beyond this). */
export const MAX_BUILDER_CHECKPOINTS = 25;

export type BuilderCheckpointSource = 'copilot' | 'manual' | 'pre-restore';

export interface BuilderCheckpoint {
  id: string;
  /** ISO timestamp the checkpoint was captured. */
  createdAt: string;
  /** Human-readable label (e.g. "Before Copilot: add ADX destination"). */
  label: string;
  /** What produced the checkpoint. */
  source: BuilderCheckpointSource;
  /**
   * Verbatim snapshot of the configured doc keys from item.state at capture
   * time. Stripped from list responses (list only needs metadata).
   */
  doc?: Record<string, unknown>;
  /** Small stat map for the list UI (e.g. { sources: 2, destinations: 1 }). */
  stats: Record<string, number>;
}

/** JS prototype-pollution guard for the (config-supplied, but defensive) keys. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pick the configured doc keys out of item.state (defensive against proto keys). */
function pickDoc(state: Record<string, unknown> | undefined, docKeys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!state) return out;
  for (const k of docKeys) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(state, k)) out[k] = state[k];
  }
  return out;
}

function readCheckpoints(state: Record<string, unknown> | undefined, checkpointsKey: string): BuilderCheckpoint[] {
  if (!state || FORBIDDEN_KEYS.has(checkpointsKey)) return [];
  const raw = Object.prototype.hasOwnProperty.call(state, checkpointsKey) ? state[checkpointsKey] : undefined;
  return Array.isArray(raw) ? (raw as BuilderCheckpoint[]) : [];
}

export interface CheckpointStoreConfig {
  itemType: string;
  /** item.state keys whose values ARE the authoring doc (snapshotted/restored). */
  docKeys: readonly string[];
  /** item.state key that holds the checkpoint array. */
  checkpointsKey: string;
  /** Derive the small stat map for the list UI from a doc snapshot. */
  computeStats: (doc: Record<string, unknown>) => Record<string, number>;
}

/** List checkpoints (newest first, doc stripped). Returns null when not owned. */
export async function listBuilderCheckpoints(
  cfg: CheckpointStoreConfig,
  itemId: string,
  tenantId: string,
): Promise<BuilderCheckpoint[] | null> {
  const item = await loadOwnedItem(itemId, cfg.itemType, tenantId);
  if (!item) return null;
  return readCheckpoints(item.state as Record<string, unknown> | undefined, cfg.checkpointsKey)
    .map((c) => ({ ...c, doc: undefined }));
}

/**
 * Capture the item's CURRENT authoring doc as a new checkpoint and persist it.
 * Returns the new checkpoint (doc stripped) or null when the item isn't owned.
 */
export async function captureBuilderCheckpoint(
  cfg: CheckpointStoreConfig,
  itemId: string,
  tenantId: string,
  label: string,
  source: BuilderCheckpointSource = 'copilot',
): Promise<BuilderCheckpoint | null> {
  const item = await loadOwnedItem(itemId, cfg.itemType, tenantId);
  if (!item) return null;
  const state = (item.state || {}) as Record<string, unknown>;
  const doc = pickDoc(state, cfg.docKeys);
  const checkpoint: BuilderCheckpoint = {
    id: newId(),
    createdAt: new Date().toISOString(),
    label: label.trim() || `Checkpoint ${new Date().toISOString()}`,
    source,
    doc,
    stats: cfg.computeStats(doc),
  };
  const existing = readCheckpoints(state, cfg.checkpointsKey);
  const next = [checkpoint, ...existing].slice(0, MAX_BUILDER_CHECKPOINTS);
  const updated = await updateOwnedItem(itemId, cfg.itemType, tenantId, {
    state: { ...state, [cfg.checkpointsKey]: next },
  });
  if (!updated) return null;
  return { ...checkpoint, doc: undefined };
}

/**
 * Restore the authoring doc from a checkpoint. Snapshots the CURRENT doc as a
 * `pre-restore` checkpoint first so the restore is itself reversible. Returns
 * the restored doc keys, or null when the item / checkpoint isn't found.
 */
export async function restoreBuilderCheckpoint(
  cfg: CheckpointStoreConfig,
  itemId: string,
  tenantId: string,
  checkpointId: string,
): Promise<{ restoredFrom: BuilderCheckpoint } | null> {
  const item = await loadOwnedItem(itemId, cfg.itemType, tenantId);
  if (!item) return null;
  const state = (item.state || {}) as Record<string, unknown>;
  const checkpoints = readCheckpoints(state, cfg.checkpointsKey);
  const target = checkpoints.find((c) => c.id === checkpointId);
  if (!target || !target.doc) return null;

  const currentDoc = pickDoc(state, cfg.docKeys);
  const preRestore: BuilderCheckpoint = {
    id: newId(),
    createdAt: new Date().toISOString(),
    label: `Auto-snapshot before restoring "${target.label}"`,
    source: 'pre-restore',
    doc: currentDoc,
    stats: cfg.computeStats(currentDoc),
  };
  const nextCheckpoints = [preRestore, ...checkpoints].slice(0, MAX_BUILDER_CHECKPOINTS);
  // Write the target doc keys back verbatim + append the pre-restore snapshot.
  const restoredKeys: Record<string, unknown> = {};
  for (const k of cfg.docKeys) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(target.doc, k)) restoredKeys[k] = target.doc[k];
  }
  const updated = await updateOwnedItem(itemId, cfg.itemType, tenantId, {
    state: { ...state, ...restoredKeys, [cfg.checkpointsKey]: nextCheckpoints },
  });
  if (!updated) return null;
  return { restoredFrom: { ...target, doc: undefined } };
}
