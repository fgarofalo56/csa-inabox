'use client';

/**
 * SqlConstraintsNode — the per-table **Keys & constraints** sub-node for the SQL
 * database object navigator. Lists the table's real PK / UNIQUE / FK / CHECK
 * constraints (`sys.key_constraints` / `sys.foreign_keys` / `sys.check_constraints`
 * via `/api/sqldb/constraints`) inside the navigator Tree, with a per-constraint
 * Fluent context menu (Script as ADD, Script as DROP, Enable/Disable for FK &
 * CHECK, Delete) and an "Add constraint" affordance that opens the
 * {@link SqlConstraintBuilder} designer. This replaces the former "Keys &
 * constraints — coming" honest-gate row.
 *
 * All identifiers in the generated "Script as ADD/DROP" come from the catalog
 * row (no extra round-trip, no string injection). Enable/Disable + Delete call
 * the BFF, which resolves the constraint by integer id before emitting DDL.
 */

import { useCallback } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Badge, Caption1, Spinner, Tooltip,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Code20Regular,
  Warning20Regular, MoreHorizontal20Regular, KeyMultiple20Regular,
  Link20Regular, Checkmark20Regular, ShieldCheckmark20Regular,
} from '@fluentui/react-icons';
import type { SqlConstraintRow } from './sqldb-constraint-builder';

const useStyles = makeStyles({
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  actions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  empty: { color: tokens.colorNeutralForeground3, flex: 1 },
});

const TYPE_LABEL: Record<SqlConstraintRow['constraintType'], string> = {
  PK: 'PK', UQ: 'UNIQUE', FK: 'FK', CK: 'CHECK',
};

function typeIcon(t: SqlConstraintRow['constraintType']) {
  switch (t) {
    case 'PK': return <KeyMultiple20Regular />;
    case 'UQ': return <ShieldCheckmark20Regular />;
    case 'FK': return <Link20Regular />;
    case 'CK': return <Checkmark20Regular />;
  }
}

function badgeColor(t: SqlConstraintRow['constraintType']): 'brand' | 'informative' | 'subtle' | 'success' {
  switch (t) {
    case 'PK': return 'brand';
    case 'FK': return 'informative';
    case 'CK': return 'subtle';
    case 'UQ': return 'success';
  }
}

/** Reconstruct the ALTER TABLE … ADD CONSTRAINT DDL from a catalog row. */
function scriptAddDdl(c: SqlConstraintRow, tableFullName: string): string {
  const cn = `[${c.name.replace(/]/g, ']]')}]`;
  if (c.constraintType === 'PK' || c.constraintType === 'UQ') {
    const kw = c.constraintType === 'PK' ? 'PRIMARY KEY' : 'UNIQUE';
    const clustered = (c.indexTypeDesc || '').toUpperCase().includes('NONCLUSTERED') ? 'NONCLUSTERED' : 'CLUSTERED';
    return `ALTER TABLE ${tableFullName} ADD CONSTRAINT ${cn} ${kw} ${clustered} (${c.columns});`;
  }
  if (c.constraintType === 'FK') {
    const onDelete = (c.onDelete || 'NO_ACTION').replace(/_/g, ' ');
    const onUpdate = (c.onUpdate || 'NO_ACTION').replace(/_/g, ' ');
    const trust = c.isTrusted ? 'WITH CHECK' : 'WITH NOCHECK';
    return `ALTER TABLE ${tableFullName} ${trust} ADD CONSTRAINT ${cn} `
      + `FOREIGN KEY (${c.columns}) REFERENCES ${c.refTableName} (${c.refColumns}) `
      + `ON DELETE ${onDelete} ON UPDATE ${onUpdate};`;
  }
  // CHECK
  const trust = c.isTrusted ? 'WITH CHECK' : 'WITH NOCHECK';
  return `ALTER TABLE ${tableFullName} ${trust} ADD CONSTRAINT ${cn} CHECK (${c.checkDefinition});`;
}

function scriptDropDdl(c: SqlConstraintRow, tableFullName: string): string {
  return `ALTER TABLE ${tableFullName} DROP CONSTRAINT [${c.name.replace(/]/g, ']]')}];`;
}

export interface SqlConstraintsNodeProps {
  tableObjectId: number;
  /** `[schema].[name]` for DDL + display. */
  tableFullName: string;
  /** Lazy-loaded constraints (or loading/error sentinel). */
  state: SqlConstraintRow[] | 'loading' | { error: string } | undefined;
  treeValuePrefix: string;
  busy: boolean;
  onLoad: () => void;
  onAdd: () => void;
  onOpenQuery?: (sql: string) => void;
  onDelete: (constraintId: number, label: string) => void;
  onToggle: (constraintId: number, enable: boolean, label: string) => void;
}

/** The expandable "Keys & constraints" sub-node rendered under a table. */
export function SqlConstraintsNode(props: SqlConstraintsNodeProps) {
  const { tableObjectId, tableFullName, state, treeValuePrefix, busy, onLoad, onAdd, onOpenQuery, onDelete, onToggle } = props;
  const s = useStyles();

  const script = useCallback((sql: string) => { onOpenQuery?.(sql); }, [onOpenQuery]);

  const count = Array.isArray(state) ? state.length : undefined;

  return (
    <TreeItem
      itemType="branch"
      value={`${treeValuePrefix}-cons`}
      onOpenChange={(_, data) => { if (data.open && state === undefined) onLoad(); }}
    >
      <TreeItemLayout iconBefore={<KeyMultiple20Regular />}>
        <span className={s.groupLayout}>
          <span>Keys &amp; constraints{count != null ? ` (${count})` : ''}</span>
          <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
            <Tooltip content="Add constraint" relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={`Add constraint to ${tableFullName}`} />
            </Tooltip>
            <Tooltip content="Refresh constraints" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={onLoad} disabled={busy} aria-label={`Refresh constraints for ${tableFullName}`} />
            </Tooltip>
          </span>
        </span>
      </TreeItemLayout>
      <Tree>
        {state === undefined && (
          <TreeItem itemType="leaf" value={`${treeValuePrefix}-cons-load`}><TreeItemLayout><Caption1>Expand to load…</Caption1></TreeItemLayout></TreeItem>
        )}
        {state === 'loading' && (
          <TreeItem itemType="leaf" value={`${treeValuePrefix}-cons-spin`}><TreeItemLayout><Spinner size="tiny" label="Loading constraints…" /></TreeItemLayout></TreeItem>
        )}
        {state && typeof state === 'object' && 'error' in state && (
          <TreeItem itemType="leaf" value={`${treeValuePrefix}-cons-err`}><TreeItemLayout iconBefore={<Warning20Regular />}><Caption1>{state.error}</Caption1></TreeItemLayout></TreeItem>
        )}
        {Array.isArray(state) && state.length === 0 && (
          <TreeItem itemType="leaf" value={`${treeValuePrefix}-cons-none`}>
            <TreeItemLayout>
              <span className={s.row}>
                <Caption1 className={s.empty}>No keys or constraints defined on this table.</Caption1>
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy}>Add constraint</Button>
              </span>
            </TreeItemLayout>
          </TreeItem>
        )}
        {Array.isArray(state) && state.map((c) => {
          const togglable = c.constraintType === 'FK' || c.constraintType === 'CK';
          const cols = c.constraintType === 'CK' ? (c.checkDefinition || '') : c.columns;
          const colsShort = cols.length > 44 ? `${cols.slice(0, 44)}…` : cols;
          return (
            <TreeItem key={c.constraintId} itemType="leaf" value={`${treeValuePrefix}-cons-${c.constraintId}`}>
              <TreeItemLayout iconBefore={typeIcon(c.constraintType)}>
                <span className={s.row}>
                  <span>{c.name}</span>
                  <Badge size="small" appearance="tint" color={badgeColor(c.constraintType)}>{TYPE_LABEL[c.constraintType]}</Badge>
                  {colsShort && (
                    cols.length > 44
                      ? <Tooltip content={cols} relationship="label"><Caption1 className={s.mono}>({colsShort})</Caption1></Tooltip>
                      : <Caption1 className={s.mono}>({colsShort})</Caption1>
                  )}
                  {c.constraintType === 'FK' && c.refTableName && <Caption1 className={s.mono}>→ {c.refTableName}</Caption1>}
                  {!c.isTrusted && <Badge size="small" appearance="tint" color="warning">not trusted</Badge>}
                  {c.isDisabled && <Badge size="small" appearance="outline">disabled</Badge>}
                  <span className={s.actions} onClick={(e) => e.stopPropagation()}>
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Tooltip content="More actions" relationship="label">
                          <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`${c.name} actions`} disabled={busy} />
                        </Tooltip>
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {onOpenQuery && <MenuItem icon={<Code20Regular />} onClick={() => script(scriptAddDdl(c, tableFullName))}>Script as ADD</MenuItem>}
                          {onOpenQuery && <MenuItem icon={<Code20Regular />} onClick={() => script(scriptDropDdl(c, tableFullName))}>Script as DROP</MenuItem>}
                          {togglable && (
                            <>
                              <MenuDivider />
                              {c.isDisabled
                                ? <MenuItem icon={<Checkmark20Regular />} onClick={() => onToggle(c.constraintId, true, c.name)}>Enable</MenuItem>
                                : <MenuItem icon={<Warning20Regular />} onClick={() => onToggle(c.constraintId, false, c.name)}>Disable</MenuItem>}
                            </>
                          )}
                          <MenuDivider />
                          <MenuItem icon={<Delete16Regular />} onClick={() => onDelete(c.constraintId, `${TYPE_LABEL[c.constraintType]} ${c.name}`)}>Delete</MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </span>
                </span>
              </TreeItemLayout>
            </TreeItem>
          );
        })}
      </Tree>
    </TreeItem>
  );
}
