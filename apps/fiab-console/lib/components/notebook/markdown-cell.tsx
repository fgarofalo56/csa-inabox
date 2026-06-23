'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Edit16Regular, Eye16Regular, Delete16Regular,
  ChevronUp16Regular, ChevronDown16Regular,
  LockClosed16Regular, LockClosed16Filled, Copy16Regular,
  ArrowMaximize16Regular, ArrowMinimize16Regular,
  ArrowSwap16Regular, ReOrderDotsVertical16Regular,
} from '@fluentui/react-icons';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  shellActive: { border: `1px solid ${tokens.colorBrandStroke1}` },
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
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
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
    width: '100%', minHeight: '80px',
    fontFamily: 'Consolas, monospace', fontSize: '13px', padding: tokens.spacingHorizontalS,
    border: 'none', outline: 'none',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1, resize: 'vertical',
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
  rendered: {
    padding: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase300,
    lineHeight: 1.5,
    color: tokens.colorNeutralForeground1,
  },
  renderedMaximized: {
    flex: 1,
    overflow: 'auto',
  },
  tag: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, fontSize: '11px' },
});

// Minimal markdown renderer: headings (#/##/###), bold (**x**), italic (*x*), code (`x`), bullet lists (-), links [t](u).
// Good enough for v1 — defer react-markdown until N+3 polish.
function renderMarkdown(src: string): string {
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold / italic / inline code
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // Bullet lists
  html = html.replace(/^(?:- (.+)(?:\n|$))+/gm, (block) => {
    const lis = block.split('\n').filter(Boolean).map(l => '<li>' + l.replace(/^- /, '') + '</li>').join('');
    return '<ul>' + lis + '</ul>';
  });
  // Paragraph breaks
  html = html.split(/\n\n+/).map(p => /<\/(h\d|ul|ol|pre)>/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br/>') + '</p>').join('');
  return html;
}

export interface MarkdownCellProps {
  cell: NotebookCell;
  active?: boolean;
  onFocus?: () => void;
  onChange: (next: NotebookCell) => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  onConvertToCode?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  dragHandleProps?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
}

export function MarkdownCell({ cell, active, onFocus, onChange, onDelete, onMoveUp, onMoveDown, onDuplicate, onConvertToCode, canMoveUp, canMoveDown, dragHandleProps }: MarkdownCellProps) {
  const s = useStyles();
  const [editing, setEditing] = useState(!cell.source);
  const [maximized, setMaximized] = useState(false);

  const locked = !!cell.locked;

  // ESC dismisses the maximized state.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const toggleLock = () => onChange({ ...cell, locked: !cell.locked });

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
        <Caption1 className={s.tag}># md</Caption1>
        <Button
          size="small"
          appearance="subtle"
          icon={editing ? <Eye16Regular /> : <Edit16Regular />}
          onClick={(e) => { e.stopPropagation(); if (locked && !editing) return; setEditing(!editing); }}
          disabled={locked && !editing}
        >
          {editing ? 'View' : 'Edit'}
        </Button>
        {locked && <Badge appearance="outline" color="warning" size="small">locked</Badge>}
        <div className={s.spacer} />
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowSwap16Regular />}
          disabled={!onConvertToCode}
          onClick={(e) => { e.stopPropagation(); onConvertToCode?.(); }}
          aria-label="Convert to code cell"
          title="Convert to code cell"
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
      {editing ? (
        <MonacoTextarea
          value={cell.source}
          onChange={(next) => onChange({ ...cell, source: next })}
          language="markdown"
          readOnly={locked}
          height={maximized ? 'calc(100% - 56px)' : 160}
          minHeight={80}
          ariaLabel={`Markdown cell ${cell.id}`}
          className={mergeClasses(locked && s.editorLocked)}
        />
      ) : (
        <div
          className={mergeClasses(s.rendered, maximized && s.renderedMaximized)}
          onDoubleClick={() => { if (!locked) setEditing(true); }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source || '_Empty markdown cell — double-click to edit._') }}
        />
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
