'use client';

// helpers.tsx — pure helper functions for the semantic-model editor.
// Extracted byte-for-byte from ../semantic-model-editor.tsx (pure move).
// Has JSX (ColumnTypeIcon) so this file uses .tsx + 'use client'.

import { classifyColumnType } from '@/lib/components/shared/entity-diagram-sources';
import { SM_KIND_ICON } from './constants';
import type { StructureOp, PfaTableFlag, DatasetLite } from './types';

/**
 * Prefix the BFF list route stamps on a Cosmos-backed (not-yet-in-Power BI)
 * entry — `LOOM_ID_PREFIX` in app/api/items/_lib/pbi-content-fallback.ts.
 */
export const LOOM_DATASET_ID_PREFIX = 'loom:';

/**
 * Which dataset the semantic-model editor should bind to after the list loads.
 *
 * The list route returns the caller's Cosmos-backed semantic models (id
 * `loom:<cosmosItemId>`) merged with the LIVE Power BI datasets of whichever
 * Power BI workspace is bound — so `datasets[0]` is very often some OTHER
 * item entirely. Auto-selecting it made every tab (Aggregations / Incremental
 * refresh / Direct Lake / Security …) operate on a model the user never opened
 * while the breadcrumb still named theirs (#2649).
 *
 * So: when the editor was opened on a PERSISTED item, bind to THAT item —
 * matching the list entry when it is present (preferring the `loom:` form the
 * list actually carries, which the detail route resolves straight from Cosmos),
 * and otherwise still returning the opened id rather than a foreign model.
 * `datasets[0]` remains the default only for `/new`, where there is no opened
 * item and the auto-pick is what enables New measure / Refresh / Open in Power
 * BI without a manual pick.
 */
export function defaultDatasetId(datasets: DatasetLite[], openedItemId: string): string {
  if (!openedItemId || openedItemId === 'new') return datasets[0]?.id ?? '';
  const loomForm = `${LOOM_DATASET_ID_PREFIX}${openedItemId}`;
  if (datasets.some((d) => d.id === loomForm)) return loomForm;
  return openedItemId;
}

/** Type-differentiated icon for a column, keyed off its backend-native data type. */
export function ColumnTypeIcon({ dataType, className }: { dataType?: string; className?: string }) {
  return <span className={className} aria-hidden="true">{SM_KIND_ICON[classifyColumnType(dataType)]}</span>;
}

export function describeOp(op: StructureOp): string {
  if (op.kind === 'rename-measure') return `Rename measure [${op.from}] → [${op.to}]`;
  if (op.kind === 'set-measure-description') return `Describe [${op.measure}]: "${op.description}"`;
  return `Add relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] (${op.cardinality})${op.rationale ? ` — ${op.rationale}` : ''}`;
}

export const opBadgeColor = (k: StructureOp['kind']): 'brand' | 'success' | 'informative' =>
  k === 'rename-measure' ? 'brand' : k === 'set-measure-description' ? 'success' : 'informative';

/** Effective exposure for a table/column given the sparse persisted flags (default-ON). */
export function tableExposed(schema: PfaTableFlag[], table: string): boolean {
  const t = schema.find((x) => x.table === table);
  return t ? t.exposed !== false : true;
}
export function columnExposed(schema: PfaTableFlag[], table: string, column: string): boolean {
  const t = schema.find((x) => x.table === table);
  if (!t) return true;
  const c = t.columns.find((x) => x.column === column);
  return c ? c.exposed !== false : true;
}
