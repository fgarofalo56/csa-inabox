/**
 * Model-structure checkpoints (audit-T82) — point-in-time snapshots of a
 * semantic model's Loom-native structure (measures + relationships) so the
 * Copilot model-structure pane can apply NL edits with a safety net and the
 * user can restore a prior structure.
 *
 * The snapshots live on the existing Cosmos `items` container under
 * `item.state.modelCheckpoints = [...]` (newest first, capped). NO new Cosmos
 * container, NO new env var, NO Power BI / Fabric dependency: this is the
 * Azure-native DEFAULT and works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * The Loom model state (`item.state.model`) is the source of truth (same store
 * the DAX Copilot writes). A checkpoint captures that state verbatim; restore
 * writes it back. When an opt-in XMLA backend is configured the route also
 * mirrors edits to the live tabular model, but the checkpoint itself is
 * engine-independent — it always works.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { loadOwnedItem, updateOwnedItem } from './item-crud';
import type { LoomModelState } from './model-store';

/** Max checkpoints retained per model (oldest dropped beyond this). */
export const MAX_CHECKPOINTS = 25;

export interface ModelCheckpoint {
  id: string;
  /** ISO timestamp the checkpoint was captured. */
  createdAt: string;
  /** Human-readable label (e.g. "Before Copilot rename of [Sales]"). */
  label: string;
  /** What produced the checkpoint. */
  source: 'copilot' | 'manual' | 'pre-restore';
  /** Verbatim snapshot of the Loom-native model structure at capture time. */
  model: LoomModelState;
  /** Quick stats for the list UI (avoids deserializing the whole model). */
  stats: { measures: number; relationships: number };
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readModelFromItemState(state: Record<string, unknown> | undefined): LoomModelState {
  const raw = (state?.model as Partial<LoomModelState> | undefined) || undefined;
  return {
    measures: Array.isArray(raw?.measures) ? (raw!.measures as LoomModelState['measures']) : [],
    relationships: Array.isArray(raw?.relationships) ? (raw!.relationships as LoomModelState['relationships']) : [],
  };
}

function readCheckpointsFromItemState(state: Record<string, unknown> | undefined): ModelCheckpoint[] {
  const raw = state?.modelCheckpoints;
  return Array.isArray(raw) ? (raw as ModelCheckpoint[]) : [];
}

/** List checkpoints (newest first). Returns null when the item isn't owned. */
export async function listCheckpoints(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<ModelCheckpoint[] | null> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return null;
  // Strip the heavy `model` payload from list responses — the UI only needs
  // metadata + stats. Restore re-reads the full record.
  return readCheckpointsFromItemState(item.state as Record<string, unknown> | undefined)
    .map((c) => ({ ...c, model: undefined as unknown as LoomModelState }));
}

/**
 * Capture the model's CURRENT Loom-native structure as a new checkpoint and
 * persist it. Returns the new checkpoint (with its model stripped) or null when
 * the item isn't owned. Caps to MAX_CHECKPOINTS (drops oldest).
 */
export async function captureCheckpoint(
  itemId: string,
  itemType: string,
  tenantId: string,
  label: string,
  source: ModelCheckpoint['source'] = 'copilot',
): Promise<ModelCheckpoint | null> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return null;
  const state = (item.state || {}) as Record<string, unknown>;
  const model = readModelFromItemState(state);
  const checkpoint: ModelCheckpoint = {
    id: newId(),
    createdAt: new Date().toISOString(),
    label: label.trim() || `Checkpoint ${new Date().toISOString()}`,
    source,
    model,
    stats: { measures: model.measures.length, relationships: model.relationships.length },
  };
  const existing = readCheckpointsFromItemState(state);
  const next = [checkpoint, ...existing].slice(0, MAX_CHECKPOINTS);
  const updated = await updateOwnedItem(itemId, itemType, tenantId, {
    state: { ...state, modelCheckpoints: next },
  });
  if (!updated) return null;
  return { ...checkpoint, model: undefined as unknown as LoomModelState };
}

/**
 * Restore the model structure from a checkpoint. Before overwriting, it captures
 * the CURRENT state as a `pre-restore` checkpoint so the restore is itself
 * reversible. Returns the restored LoomModelState, or null when the item /
 * checkpoint isn't found.
 */
export async function restoreCheckpoint(
  itemId: string,
  itemType: string,
  tenantId: string,
  checkpointId: string,
): Promise<{ model: LoomModelState; restoredFrom: ModelCheckpoint } | null> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return null;
  const state = (item.state || {}) as Record<string, unknown>;
  const checkpoints = readCheckpointsFromItemState(state);
  const target = checkpoints.find((c) => c.id === checkpointId);
  if (!target || !target.model) return null;

  // Snapshot current state first (reversible restore), then write the target.
  const current = readModelFromItemState(state);
  const preRestore: ModelCheckpoint = {
    id: newId(),
    createdAt: new Date().toISOString(),
    label: `Auto-snapshot before restoring "${target.label}"`,
    source: 'pre-restore',
    model: current,
    stats: { measures: current.measures.length, relationships: current.relationships.length },
  };
  const nextCheckpoints = [preRestore, ...checkpoints].slice(0, MAX_CHECKPOINTS);
  const updated = await updateOwnedItem(itemId, itemType, tenantId, {
    state: { ...state, model: target.model, modelCheckpoints: nextCheckpoints },
  });
  if (!updated) return null;
  return { model: target.model, restoredFrom: { ...target, model: undefined as unknown as LoomModelState } };
}
