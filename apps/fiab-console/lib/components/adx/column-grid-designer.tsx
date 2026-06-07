'use client';

/**
 * ColumnGridDesigner — a visual table-schema designer for Kusto / ADX tables.
 *
 * Renders one row per column: a name <Input> + a scalar-type <Select> +
 * a delete button, with an "Add column" footer and a live CSL-schema preview.
 * This is the Loom equivalent of the ADX web UI / Fabric KQL-database
 * "Create table" column grid (Name + Data type), themed with Fluent v9.
 *
 * The component is controlled: the parent owns the `ColumnDef[]` and the
 * designer calls `onChange` on every edit. Helpers serialize to / parse from
 * the Kusto CSL schema string (`col:type, col:type`) that the `.create table`
 * / `.alter-merge table` control commands accept — so callers that already
 * hold a CSL string (e.g. the navigator's create dialog) can round-trip
 * through `parseKustoSchema` / `toKustoSchema` without changing their payload.
 *
 * No mocks: this is pure UI over real schema definitions; the backend call
 * lives in the route the parent submits to (`/api/adx/tables`).
 */

import { useMemo } from 'react';
import {
  Button, Input, Select, Caption1, Tooltip,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import {
  KUSTO_TYPES, toKustoSchema, validateColumns,
  type KustoScalarType, type ColumnDef,
} from './column-grid-schema';

// Re-export the pure schema helpers so existing imports from this module keep
// working (the helpers live in column-grid-schema.ts so they can be unit
// tested without pulling in React / Fluent).
export {
  KUSTO_TYPES, toKustoSchema, parseKustoSchema, validateColumns,
} from './column-grid-schema';
export type { KustoScalarType, ColumnDef } from './column-grid-schema';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' },
  headRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 150px 32px',
    gap: '8px',
    alignItems: 'center',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    paddingRight: '4px',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 150px 32px',
    gap: '8px',
    alignItems: 'center',
  },
  preview: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: '6px 8px',
    overflowX: 'auto',
    whiteSpace: 'nowrap',
  },
});

export interface ColumnGridDesignerProps {
  columns: ColumnDef[];
  onChange: (cols: ColumnDef[]) => void;
  disabled?: boolean;
  /** Override the empty-state caption (e.g. for the additive alter flow). */
  emptyHint?: string;
}

/** A visual Name + Data-type column grid for Kusto table schemas. */
export function ColumnGridDesigner({ columns, onChange, disabled, emptyHint }: ColumnGridDesignerProps) {
  const s = useStyles();
  const error = useMemo(() => (columns.length ? validateColumns(columns) : null), [columns]);
  const preview = useMemo(() => toKustoSchema(columns), [columns]);

  const update = (i: number, patch: Partial<ColumnDef>) => {
    onChange(columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };
  const remove = (i: number) => onChange(columns.filter((_, idx) => idx !== i));
  const add = () => onChange([...columns, { name: '', type: 'string' }]);

  return (
    <div className={s.root}>
      {columns.length > 0 && (
        <div className={s.headRow}>
          <span>Column name</span>
          <span>Data type</span>
          <span aria-hidden />
        </div>
      )}
      {columns.length === 0 && (
        <Caption1>{emptyHint || 'No columns yet — add one to define the schema.'}</Caption1>
      )}
      {columns.map((col, i) => (
        <div className={s.row} key={i}>
          <Input
            value={col.name}
            disabled={disabled}
            placeholder="column_name"
            aria-label={`Column ${i + 1} name`}
            onChange={(_, d) => update(i, { name: d.value })}
          />
          <Select
            value={col.type}
            disabled={disabled}
            aria-label={`Column ${i + 1} data type`}
            onChange={(_, d) => update(i, { type: d.value as KustoScalarType })}
          >
            {KUSTO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <Tooltip content="Remove column" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Delete20Regular />}
              disabled={disabled}
              aria-label={`Remove column ${i + 1}`}
              onClick={() => remove(i)}
            />
          </Tooltip>
        </div>
      ))}
      <div>
        <Button
          size="small"
          appearance="secondary"
          icon={<Add20Regular />}
          disabled={disabled}
          onClick={add}
        >
          Add column
        </Button>
      </div>
      {preview && (
        <Caption1 className={s.preview} aria-label="CSL schema preview">{preview}</Caption1>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}
    </div>
  );
}
