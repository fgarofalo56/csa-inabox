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
  createdAt: string;
  updatedAt: string;
}

export interface LoomModelState {
  relationships: StoredRelationship[];
  measures: StoredMeasure[];
}

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
