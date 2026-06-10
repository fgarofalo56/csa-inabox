/**
 * Shared persistence + projection helpers for the Loom Model view
 * (relationships + measures) across the warehouse / Synapse Dedicated SQL pool
 * / Databricks SQL warehouse engines.
 *
 * The model metadata lives on the existing Cosmos `items` container under
 * `item.state.model = { relationships: [...], measures: [...] }`. NO new Cosmos
 * container, NO new env var, NO Power BI / Fabric dependency: relationships and
 * measures are persisted Azure-native (Cosmos) and — where the engine supports
 * it — materialized as real backend objects (Unity Catalog FK constraints,
 * Synapse inline TVFs).
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { loadOwnedItem, updateOwnedItem } from './item-crud';

export type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
export type CrossFilter = 'single' | 'both';
export type MeasureKind = 'tvf' | 'scalar' | 'cosmos';

export interface StoredRelationship {
  id: string;
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  crossFilter: CrossFilter;
  active: boolean;
  source: 'cosmos' | 'uc';
  createdAt: string;
  updatedAt: string;
}

export interface StoredMeasure {
  id: string;
  name: string;
  schema?: string;
  expression: string;
  kind: MeasureKind;
  /** Business-friendly description. Authored by the DAX Copilot (dax_save_descriptions)
   *  or by hand; persisted Azure-native in Cosmos — no Power BI / Fabric dependency. */
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoomModelState {
  relationships: StoredRelationship[];
  measures: StoredMeasure[];
}

/**
 * A point-in-time snapshot of the model structure (measures + relationships).
 * Snapshots are stored Azure-native on `item.state.modelCheckpoints` so the
 * model-structure Copilot can take a checkpoint before a bulk change and the
 * operator can restore it — no Power BI / Fabric required.
 */
export interface ModelCheckpoint {
  id: string;
  label: string;
  /** Who/what produced it — e.g. 'copilot:rename' or 'manual'. */
  reason: string;
  createdAt: string;
  measureCount: number;
  relationshipCount: number;
  state: LoomModelState;
}

const MAX_CHECKPOINTS = 20;

const CARDINALITIES: Cardinality[] = ['one-to-many', 'many-to-one', 'one-to-one', 'many-to-many'];
const CROSS_FILTERS: CrossFilter[] = ['single', 'both'];

/** Read the persisted model sub-state for an owned item (empty when absent). */
export async function readModelState(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<{ state: LoomModelState; itemFound: boolean }> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return { state: { relationships: [], measures: [] }, itemFound: false };
  const raw = (item.state as Record<string, unknown> | undefined)?.model as Partial<LoomModelState> | undefined;
  return {
    itemFound: true,
    state: {
      relationships: Array.isArray(raw?.relationships) ? (raw!.relationships as StoredRelationship[]) : [],
      measures: Array.isArray(raw?.measures) ? (raw!.measures as StoredMeasure[]) : [],
    },
  };
}

/** Replace the model sub-state on an owned item, preserving the rest of `state`. */
export async function writeModelState(
  itemId: string,
  itemType: string,
  tenantId: string,
  model: LoomModelState,
): Promise<boolean> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return false;
  const nextState = { ...(item.state || {}), model };
  const updated = await updateOwnedItem(itemId, itemType, tenantId, { state: nextState });
  return !!updated;
}

/**
 * Validate + normalize an incoming relationship payload from the canvas. Throws
 * a plain Error (message becomes the 400 body) on invalid input.
 */
export function normalizeRelationship(
  input: unknown,
  source: 'cosmos' | 'uc',
  existing?: StoredRelationship,
): StoredRelationship {
  const r = (input || {}) as Record<string, unknown>;
  const fromTable = String(r.fromTable || '').trim();
  const fromColumn = String(r.fromColumn || '').trim();
  const toTable = String(r.toTable || '').trim();
  const toColumn = String(r.toColumn || '').trim();
  if (!fromTable || !fromColumn || !toTable || !toColumn) {
    throw new Error('fromTable, fromColumn, toTable and toColumn are all required');
  }
  const cardinality = CARDINALITIES.includes(r.cardinality as Cardinality) ? (r.cardinality as Cardinality) : 'many-to-one';
  const crossFilter = CROSS_FILTERS.includes(r.crossFilter as CrossFilter) ? (r.crossFilter as CrossFilter) : 'single';
  const now = new Date().toISOString();
  const name = String(r.name || `FK_${fromTable.split('.').pop()}_${toTable.split('.').pop()}`).replace(/[^A-Za-z0-9_]/g, '_');
  return {
    id: existing?.id || (globalThis.crypto?.randomUUID?.() ?? `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name,
    fromTable, fromColumn, toTable, toColumn,
    cardinality, crossFilter,
    active: r.active === undefined ? true : !!r.active,
    source,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

/** Upsert a relationship into a model state by id (mutates a copy, returns it). */
export function upsertRelationship(model: LoomModelState, rel: StoredRelationship): LoomModelState {
  const relationships = model.relationships.filter((x) => x.id !== rel.id);
  relationships.push(rel);
  return { ...model, relationships };
}

/** Remove a relationship by id. */
export function removeRelationship(model: LoomModelState, relId: string): LoomModelState {
  return { ...model, relationships: model.relationships.filter((x) => x.id !== relId) };
}

/** Validate + normalize an incoming measure payload. Throws on invalid input. */
export function normalizeMeasure(input: unknown, defaultKind: MeasureKind): StoredMeasure {
  const m = (input || {}) as Record<string, unknown>;
  const name = String(m.name || '').trim();
  const expression = String(m.expression || '').trim();
  if (!name) throw new Error('measure name is required');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('measure name must be a valid identifier');
  if (!expression) throw new Error('measure expression is required');
  const kind = (['tvf', 'scalar', 'cosmos'] as MeasureKind[]).includes(m.kind as MeasureKind) ? (m.kind as MeasureKind) : defaultKind;
  const now = new Date().toISOString();
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    schema: kind === 'tvf' || kind === 'scalar' ? String(m.schema || 'dbo').trim() || 'dbo' : undefined,
    expression,
    kind,
    createdAt: now,
    updatedAt: now,
  };
}

/** Upsert a measure by (schema,name) identity. */
export function upsertMeasure(model: LoomModelState, measure: StoredMeasure): LoomModelState {
  const measures = model.measures.filter(
    (x) => !(x.name === measure.name && (x.schema || '') === (measure.schema || '')),
  );
  measures.push(measure);
  return { ...model, measures };
}

/**
 * Build the `CREATE OR ALTER FUNCTION … RETURNS TABLE` DDL for a Synapse /
 * Warehouse inline table-valued-function measure. The user's expression is the
 * SELECT body. We do not interpolate untrusted identifiers beyond schema/name,
 * which are validated above.
 */
export function tvfDdl(measure: StoredMeasure): string {
  const schema = (measure.schema || 'dbo').replace(/[[\]]/g, '');
  const name = measure.name.replace(/[[\]]/g, '');
  const body = measure.expression.trim().replace(/;+\s*$/, '');
  return `CREATE OR ALTER FUNCTION [${schema}].[${name}]()\nRETURNS TABLE\nAS RETURN (\n${body}\n);`;
}

/**
 * Rename a measure by its current name (validated identifier). Returns the
 * mutated model state plus the resolved old/new pair, or null when the source
 * name is not found or the target collides with another measure. Renaming only
 * changes the metadata name — the expression is preserved verbatim.
 */
export function renameMeasureInState(
  model: LoomModelState,
  fromName: string,
  toName: string,
): { model: LoomModelState; from: string; to: string } | { error: string } {
  const from = String(fromName || '').trim();
  const to = String(toName || '').trim();
  if (!from || !to) return { error: 'both the current and new measure name are required' };
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(to)) {
    return { error: `"${to}" is not a valid measure name (letters, digits, spaces and underscores; must not start with a digit)` };
  }
  const target = model.measures.find((m) => m.name === from);
  if (!target) return { error: `measure "${from}" was not found on this model` };
  if (from !== to && model.measures.some((m) => m.name === to)) {
    return { error: `a measure named "${to}" already exists` };
  }
  const now = new Date().toISOString();
  const measures = model.measures.map((m) => (m.name === from ? { ...m, name: to, updatedAt: now } : m));
  return { model: { ...model, measures }, from, to };
}

// ---------- model checkpoints (snapshot / restore) ----------

/** Read the persisted checkpoints for an owned item (newest first). */
export async function readModelCheckpoints(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<{ checkpoints: ModelCheckpoint[]; itemFound: boolean }> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return { checkpoints: [], itemFound: false };
  const raw = (item.state as Record<string, unknown> | undefined)?.modelCheckpoints;
  const checkpoints = Array.isArray(raw) ? (raw as ModelCheckpoint[]) : [];
  return { itemFound: true, checkpoints: [...checkpoints].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) };
}

/**
 * Capture a checkpoint of the CURRENT model state (measures + relationships).
 * Trims the ring to MAX_CHECKPOINTS (drops the oldest). Returns the new
 * checkpoint, or null when the item is not found / not owned.
 */
export async function captureModelCheckpoint(
  itemId: string,
  itemType: string,
  tenantId: string,
  meta: { label?: string; reason?: string },
): Promise<ModelCheckpoint | null> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return null;
  const existingState = (item.state as Record<string, unknown> | undefined)?.model as Partial<LoomModelState> | undefined;
  const state: LoomModelState = {
    relationships: Array.isArray(existingState?.relationships) ? (existingState!.relationships as StoredRelationship[]) : [],
    measures: Array.isArray(existingState?.measures) ? (existingState!.measures as StoredMeasure[]) : [],
  };
  const now = new Date().toISOString();
  const checkpoint: ModelCheckpoint = {
    id: globalThis.crypto?.randomUUID?.() ?? `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: String(meta.label || `Checkpoint ${now}`).slice(0, 120),
    reason: String(meta.reason || 'manual').slice(0, 60),
    createdAt: now,
    measureCount: state.measures.length,
    relationshipCount: state.relationships.length,
    state,
  };
  const prior = Array.isArray((item.state as Record<string, unknown> | undefined)?.modelCheckpoints)
    ? ((item.state as Record<string, unknown>).modelCheckpoints as ModelCheckpoint[])
    : [];
  const next = [checkpoint, ...prior].slice(0, MAX_CHECKPOINTS);
  const nextState = { ...(item.state || {}), modelCheckpoints: next };
  const ok = await updateOwnedItem(itemId, itemType, tenantId, { state: nextState });
  return ok ? checkpoint : null;
}

/**
 * Restore a checkpoint by id: overwrite `item.state.model` with the snapshot
 * (taking a fresh "pre-restore" checkpoint first so the restore is itself
 * undoable). Returns the restored model state, or null when not found.
 */
export async function restoreModelCheckpoint(
  itemId: string,
  itemType: string,
  tenantId: string,
  checkpointId: string,
): Promise<{ model: LoomModelState; checkpoint: ModelCheckpoint } | null | { error: string }> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return null;
  const prior = Array.isArray((item.state as Record<string, unknown> | undefined)?.modelCheckpoints)
    ? ((item.state as Record<string, unknown>).modelCheckpoints as ModelCheckpoint[])
    : [];
  const target = prior.find((c) => c.id === checkpointId);
  if (!target) return { error: `checkpoint "${checkpointId}" was not found` };

  // Snapshot the current state so restore is undoable, then trim the ring.
  const currentState = (item.state as Record<string, unknown> | undefined)?.model as Partial<LoomModelState> | undefined;
  const beforeState: LoomModelState = {
    relationships: Array.isArray(currentState?.relationships) ? (currentState!.relationships as StoredRelationship[]) : [],
    measures: Array.isArray(currentState?.measures) ? (currentState!.measures as StoredMeasure[]) : [],
  };
  const now = new Date().toISOString();
  const beforeCheckpoint: ModelCheckpoint = {
    id: globalThis.crypto?.randomUUID?.() ?? `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: `Before restore of "${target.label}"`,
    reason: 'copilot:pre-restore',
    createdAt: now,
    measureCount: beforeState.measures.length,
    relationshipCount: beforeState.relationships.length,
    state: beforeState,
  };
  const nextCheckpoints = [beforeCheckpoint, ...prior].slice(0, MAX_CHECKPOINTS);
  const nextState = {
    ...(item.state || {}),
    model: target.state,
    modelCheckpoints: nextCheckpoints,
  };
  const ok = await updateOwnedItem(itemId, itemType, tenantId, { state: nextState });
  return ok ? { model: target.state, checkpoint: target } : { error: 'failed to persist the restored model state' };
}
