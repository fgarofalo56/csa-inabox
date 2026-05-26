'use client';

import { useCallback, useState } from 'react';
import { Badge, Button, Caption1, Select, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { Play16Regular, Delete16Regular, ChevronUp16Regular, ChevronDown16Regular } from '@fluentui/react-icons';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  shellActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px 4px 0 0',
  },
  spacer: { flex: 1 },
  editor: {
    width: '100%',
    minHeight: 80,
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: 13, padding: 8,
    border: 'none',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
    outline: 'none',
  },
  outputBox: {
    padding: 8,
    fontFamily: 'Consolas, monospace',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: 240,
    overflow: 'auto',
  },
  outputError: {
    color: tokens.colorPaletteRedForeground1,
  },
  badgeCount: {
    fontFamily: 'Consolas, monospace',
    color: tokens.colorNeutralForeground3,
    fontSize: 11,
    minWidth: 32,
    textAlign: 'right',
  },
});

const LANG_OPTIONS: { value: NotebookCellLang; label: string }[] = [
  { value: 'pyspark', label: 'PySpark (Python)' },
  { value: 'spark', label: 'Spark (Scala)' },
  { value: 'sparksql', label: 'Spark SQL' },
  { value: 'sparkr', label: 'SparkR (R)' },
  { value: 'python', label: 'Python' },
  { value: 'tsql', label: 'T-SQL' },
];

export interface CodeCellProps {
  cell: NotebookCell;
  active?: boolean;
  onFocus?: () => void;
  onChange: (next: NotebookCell) => void;
  onRun?: (cell: NotebookCell) => Promise<void>;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export function CodeCell({ cell, active, onFocus, onChange, onRun, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: CodeCellProps) {
  const s = useStyles();
  const [running, setRunning] = useState(false);

  const handleRun = useCallback(async () => {
    if (!onRun) return;
    setRunning(true);
    try { await onRun(cell); }
    finally { setRunning(false); }
  }, [cell, onRun]);

  const setLang = (lang: NotebookCellLang) => onChange({ ...cell, lang });
  const setSource = (source: string) => onChange({ ...cell, source });

  const exec = cell.executionCount ? `[${cell.executionCount}]` : '[ ]';

  return (
    <div className={`${s.shell} ${active ? s.shellActive : ''}`} onClick={onFocus}>
      <div className={s.header}>
        <Caption1 className={s.badgeCount}>{exec}</Caption1>
        <Button size="small" appearance="subtle" icon={running ? <Spinner size="tiny" /> : <Play16Regular />} disabled={running || !onRun} onClick={(e) => { e.stopPropagation(); handleRun(); }}>
          {running ? 'Running…' : 'Run cell'}
        </Button>
        <Select size="small" value={cell.lang || 'pyspark'} onChange={(_, d) => setLang(d.value as NotebookCellLang)} onClick={(e) => e.stopPropagation()}>
          {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <div className={s.spacer} />
        <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" />
        <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" />
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" />
      </div>
      <textarea
        className={s.editor}
        value={cell.source}
        spellCheck={false}
        onChange={(e) => setSource(e.target.value)}
        aria-label={`Code cell ${cell.id}`}
      />
      {cell.output && (
        <div className={`${s.outputBox} ${cell.output.status === 'error' ? s.outputError : ''}`}>
          {cell.output.status === 'error' && (
            <Badge appearance="filled" color="danger" size="small" style={{ marginBottom: 4 }}>
              {cell.output.ename || 'Error'}
            </Badge>
          )}
          {cell.output.status === 'error' ? (
            <>
              {cell.output.evalue}
              {cell.output.traceback && '\n' + (Array.isArray(cell.output.traceback) ? cell.output.traceback.join('\n') : cell.output.traceback)}
            </>
          ) : (
            cell.output.textPlain || JSON.stringify(cell.output.data, null, 2)
          )}
        </div>
      )}
    </div>
  );
}
