'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Caption1, Select, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Play16Regular, Delete16Regular, ChevronUp16Regular, ChevronDown16Regular,
  ChevronRight16Regular, LockClosed16Regular, LockClosed16Filled, Copy16Regular,
  ArrowMaximize16Regular, ArrowMinimize16Regular,
  Stop16Filled, ArrowSwap16Regular, ReOrderDotsVertical16Regular,
} from '@fluentui/react-icons';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';

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
  shellMaximized: {
    position: 'fixed',
    top: '64px',
    right: '16px',
    bottom: '16px',
    left: '16px',
    zIndex: 1000,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    zIndex: 999,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px 4px 0 0',
  },
  spacer: { flex: 1 },
  dragHandle: {
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'grab',
    color: tokens.colorNeutralForeground3,
    padding: '2px',
    ':active': { cursor: 'grabbing' },
  },
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
  editorLocked: {
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    cursor: 'not-allowed',
  },
  editorMaximized: {
    flex: 1,
    minHeight: 0,
    resize: 'none',
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
  outputBoxMaximized: {
    maxHeight: '40%',
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

/**
 * Pure, client-safe detection of a leading Synapse language magic on the first
 * non-empty line (mirrors synapse-livy-client.parseMagicKind, re-implemented
 * here so this 'use client' component never bundles the Azure SDK). Returns the
 * resolved routing kind, or null when there's no magic.
 */
const MAGIC_ROUTING: Record<string, 'pyspark' | 'spark' | 'sql' | 'sparkr'> = {
  '%%pyspark': 'pyspark', '%%python': 'pyspark',
  '%%spark': 'spark', '%%scala': 'spark',
  '%%sql': 'sql', '%%sparksql': 'sql',
  '%%sparkr': 'sparkr', '%%r': 'sparkr',
};
function detectCellMagic(source: string): 'pyspark' | 'spark' | 'sql' | 'sparkr' | null {
  const line = source.split('\n').find(l => l.trim() !== '');
  if (!line) return null;
  const token = line.trim().toLowerCase().split(/\s+/)[0];
  return MAGIC_ROUTING[token] ?? null;
}

export interface CodeCellProps {
  cell: NotebookCell;
  active?: boolean;
  onFocus?: () => void;
  onChange: (next: NotebookCell) => void;
  onRun?: (cell: NotebookCell) => Promise<void>;
  onStop?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  onConvertToMarkdown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Native HTML5 drag handle wiring supplied by the editor for reorder. */
  dragHandleProps?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
}

export function CodeCell({ cell, active, onFocus, onChange, onRun, onStop, onDelete, onMoveUp, onMoveDown, onDuplicate, onConvertToMarkdown, canMoveUp, canMoveDown, dragHandleProps }: CodeCellProps) {
  const s = useStyles();
  const [running, setRunning] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // ESC dismisses the maximized state.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const handleRun = useCallback(async () => {
    if (!onRun) return;
    setRunning(true);
    try { await onRun(cell); }
    finally { setRunning(false); }
  }, [cell, onRun]);

  const setLang = (lang: NotebookCellLang) => onChange({ ...cell, lang });
  const setSource = (source: string) => onChange({ ...cell, source });
  const toggleLock = () => onChange({ ...cell, locked: !cell.locked });
  const toggleCollapsed = () => onChange({ ...cell, collapsed: !cell.collapsed });

  const exec = cell.executionCount ? `[${cell.executionCount}]` : '[ ]';
  const locked = !!cell.locked;
  const collapsed = !!cell.collapsed;
  const lineCount = cell.source ? cell.source.split('\n').length : 0;
  const magic = detectCellMagic(cell.source);

  const shell = (
    <div
      className={mergeClasses(
        s.shell,
        active && s.shellActive,
        maximized && s.shellMaximized,
      )}
      onClick={onFocus}
    >
      <div className={s.header}>
        {dragHandleProps && (
          <span
            className={s.dragHandle}
            draggable={dragHandleProps.draggable}
            onDragStart={dragHandleProps.onDragStart}
            onDragEnd={dragHandleProps.onDragEnd}
            onClick={(e) => e.stopPropagation()}
            role="button"
            aria-label="Drag to reorder cell"
            title="Drag to reorder"
          >
            <ReOrderDotsVertical16Regular />
          </span>
        )}
        <Button
          size="small"
          appearance="subtle"
          icon={collapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
          onClick={(e) => { e.stopPropagation(); toggleCollapsed(); }}
          aria-label={collapsed ? 'Expand cell' : 'Collapse cell'}
          title={collapsed ? 'Expand cell' : 'Collapse cell'}
        />
        <Caption1 className={s.badgeCount}>{exec}</Caption1>
        {running ? (
          <Button size="small" appearance="subtle" icon={<Stop16Filled />} disabled={!onStop} onClick={(e) => { e.stopPropagation(); onStop?.(); }}>
            Stop
          </Button>
        ) : (
          <Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={!onRun || locked} onClick={(e) => { e.stopPropagation(); handleRun(); }}>
            Run cell
          </Button>
        )}
        <Select size="small" value={cell.lang || 'pyspark'} onChange={(_, d) => setLang(d.value as NotebookCellLang)} onClick={(e) => e.stopPropagation()} disabled={locked}>
          {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {magic && (
          <Badge appearance="tint" color="brand" size="small" title={`%%${magic} routes this cell to the Spark backend`}>
            %%{magic} → Spark
          </Badge>
        )}
        {collapsed && <Badge appearance="outline" size="small">{lineCount} line{lineCount === 1 ? '' : 's'} hidden</Badge>}
        {locked && <Badge appearance="outline" color="warning" size="small">locked</Badge>}
        <div className={s.spacer} />
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowSwap16Regular />}
          disabled={!onConvertToMarkdown}
          onClick={(e) => { e.stopPropagation(); onConvertToMarkdown?.(); }}
          aria-label="Convert to markdown cell"
          title="Convert to markdown cell"
        />
        <Button
          size="small"
          appearance={locked ? 'primary' : 'subtle'}
          icon={locked ? <LockClosed16Filled /> : <LockClosed16Regular />}
          onClick={(e) => { e.stopPropagation(); toggleLock(); }}
          aria-label={locked ? 'Unlock cell' : 'Lock cell'}
          title={locked ? 'Unlock cell' : 'Lock cell'}
        />
        <Button size="small" appearance="subtle" icon={<Copy16Regular />} disabled={!onDuplicate} onClick={(e) => { e.stopPropagation(); onDuplicate?.(); }} aria-label="Duplicate cell" title="Duplicate cell" />
        <Button
          size="small"
          appearance="subtle"
          icon={maximized ? <ArrowMinimize16Regular /> : <ArrowMaximize16Regular />}
          onClick={(e) => { e.stopPropagation(); setMaximized(m => !m); }}
          aria-label={maximized ? 'Restore cell' : 'Maximize cell'}
          title={maximized ? 'Restore cell (Esc)' : 'Maximize cell'}
        />
        <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" />
        <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" />
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" />
      </div>
      {!collapsed && (
        <MonacoTextarea
          value={cell.source}
          onChange={setSource}
          language={(cell.lang || 'pyspark') as MonacoLanguage}
          readOnly={locked}
          height={maximized ? 'calc(100% - 200px)' : 160}
          minHeight={80}
          ariaLabel={`Code cell ${cell.id}`}
          className={mergeClasses(locked && s.editorLocked)}
        />
      )}
      {!collapsed && cell.output && (
        <div className={mergeClasses(
          s.outputBox,
          maximized && s.outputBoxMaximized,
          cell.output.status === 'error' && s.outputError,
        )}>
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

  if (maximized) {
    return (
      <>
        <div className={s.backdrop} onClick={() => setMaximized(false)} aria-hidden="true" />
        {shell}
      </>
    );
  }
  return shell;
}
