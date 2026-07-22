'use client';

// helpers.tsx — pure helper functions for the semantic-model editor.
// Extracted byte-for-byte from ../semantic-model-editor.tsx (pure move).
// Has JSX (ColumnTypeIcon) so this file uses .tsx + 'use client'.

import { classifyColumnType } from '@/lib/components/shared/entity-diagram-sources';
import { SM_KIND_ICON } from './constants';
import type { StructureOp, PfaTableFlag } from './types';

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
