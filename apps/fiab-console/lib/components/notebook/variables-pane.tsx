'use client';

/**
 * VariablesPane — right-side OverlayDrawer that lists the live Python
 * variables in the notebook's active Spark (Livy) session.
 *
 * Parity target: the Synapse Studio / Fabric notebook **Variable explorer**
 * (View ribbon → Variables). Microsoft Learn:
 *   - Synapse: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks#run-a-notebook
 *   - Fabric:  https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook#run-notebooks
 *
 * Both render a table with Name / Type / Length / Value columns, sort on
 * every column header, and support **Python only**. This pane matches that
 * one-for-one with the Loom theme applied.
 *
 * No mocks. `onInspect` submits a real introspection statement to the live
 * Livy session via the Task-3 execute path (POST /run + poll /runs/[runId])
 * and returns parsed rows. If the kernel isn't Python, or no compute/session
 * is available, the pane surfaces an honest gate / verbatim error — per
 * no-vaporware.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Badge, Button, Caption1, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, ArrowSync20Regular,
  ArrowSortUp16Regular, ArrowSortDown16Regular,
} from '@fluentui/react-icons';
import { sortVarRows, type VarRow, type VarSortCol, type VarSortDir } from './variables-sort';

export type { VarRow } from './variables-sort';

/** Languages the variable explorer supports — Python only, like Azure/Fabric. */
const PYTHON_LANGS = ['pyspark', 'python'];

export interface VariablesPaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Async: submits the introspection snippet to the live kernel and returns
   * the parsed rows, or throws with a human-readable message.
   */
  onInspect: () => Promise<VarRow[]>;
  /** Current notebook default cell language — drives the Python-only gate. */
  defaultLang: string;
}

type SortCol = VarSortCol;
type SortDir = VarSortDir;

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  headerCell: { cursor: 'pointer', userSelect: 'none' },
  headerInner: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  nameCell: { fontFamily: 'Consolas, monospace', fontWeight: tokens.fontWeightSemibold },
  typeCell: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground2 },
  valueCell: {
    fontFamily: 'Consolas, monospace',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '220px',
    cursor: 'default',
  },
});

const VALUE_PREVIEW = 60;

export function VariablesPane({ open, onOpenChange, onInspect, defaultLang }: VariablesPaneProps) {
  const s = useStyles();
  const [rows, setRows] = useState<VarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const isPython = PYTHON_LANGS.includes(defaultLang);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const next = await onInspect();
      setRows(next);
      setLoaded(true);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [onInspect]);

  // Auto-load once when the drawer opens on a Python kernel.
  useEffect(() => {
    if (open && isPython && !loaded && !loading) refresh();
  }, [open, isPython, loaded, loading, refresh]);

  const toggleSort = useCallback((col: SortCol) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return col;
    });
  }, []);

  const sortedRows = useMemo(
    () => sortVarRows(rows, sortCol, sortDir),
    [rows, sortCol, sortDir],
  );

  const sortIcon = (col: SortCol) =>
    sortCol === col
      ? (sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />)
      : null;

  const headerCell = (col: SortCol, label: string) => (
    <TableHeaderCell
      className={s.headerCell}
      onClick={() => toggleSort(col)}
      role="columnheader"
      aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(col); } }}
      tabIndex={0}
    >
      <span className={s.headerInner}>{label}{sortIcon(col)}</span>
    </TableHeaderCell>
  );

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      position="end"
      size="medium"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => onOpenChange(false)} aria-label="Close variables pane" />
          }
        >
          <span className={s.titleRow}>
            Variables
            <Badge appearance="outline" color="informative" size="small">Python</Badge>
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.body}>
          <div className={s.toolbar}>
            <Caption1>{loaded ? `${rows.length} variable${rows.length === 1 ? '' : 's'}` : '—'}</Caption1>
            <div className={s.spacer} />
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowSync20Regular />}
              onClick={refresh}
              disabled={loading || !isPython}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          {!isPython && (
            <MessageBar intent="info">
              <MessageBarBody>
                The variable explorer supports Python (PySpark) only — the current cell
                language is <code>{defaultLang}</code>. Switch the notebook default
                language to PySpark or Python to inspect variables.
              </MessageBarBody>
            </MessageBar>
          )}

          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          {isPython && loading && rows.length === 0 && (
            <Spinner size="tiny" label="Inspecting kernel…" />
          )}

          {isPython && loaded && rows.length === 0 && !loading && !error && (
            <Caption1>
              No user variables defined yet. Run a cell that assigns a variable
              (e.g. <code>x = [1, 2, 3]</code>), then click Refresh.
            </Caption1>
          )}

          {isPython && rows.length > 0 && (
            <Table size="small" aria-label="Variables">
              <TableHeader>
                <TableRow>
                  {headerCell('name', 'Name')}
                  {headerCell('type', 'Type')}
                  {headerCell('len', 'Length')}
                  <TableHeaderCell>Value</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((r) => {
                  const preview = r.repr.length > VALUE_PREVIEW
                    ? `${r.repr.slice(0, VALUE_PREVIEW)}…`
                    : r.repr;
                  return (
                    <TableRow key={r.name}>
                      <TableCell className={s.nameCell}>{r.name}</TableCell>
                      <TableCell className={s.typeCell}>{r.type}</TableCell>
                      <TableCell>{r.len == null ? '—' : r.len}</TableCell>
                      <TableCell>
                        <Tooltip content={r.repr} relationship="label" withArrow>
                          <span className={s.valueCell}>{preview}</span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
