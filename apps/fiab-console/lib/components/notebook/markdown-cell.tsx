'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Toolbar, ToolbarButton, ToolbarDivider, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Edit16Regular, Eye16Regular, Delete16Regular,
  ChevronUp16Regular, ChevronDown16Regular,
  LockClosed16Regular, LockClosed16Filled, Copy16Regular,
  ArrowMaximize16Regular, ArrowMinimize16Regular,
  ArrowSwap16Regular, ReOrderDotsVertical16Regular,
  TextBold16Regular, TextItalic16Regular, TextHeader1Regular, TextHeader2Regular,
  TextBulletList16Regular, TextNumberListLtr16Regular, TextQuote16Regular, Code16Regular, Link16Regular,
} from '@fluentui/react-icons';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { renderMarkdown } from '@/lib/notebook/render-markdown';
import { applyMarkdownFormat, type MarkdownFormat } from '@/lib/editors/synapse-notebook-cell-adapter';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    // Fabric cell anatomy — teal left accent rail marks markdown cells
    // (distinct from the brand-blue code-cell rail).
    borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    // Secondary actions reveal on hover / keyboard focus (Fabric hover toolbar).
    '& .nb-cell-actions': { opacity: 0, transitionProperty: 'opacity', transitionDuration: tokens.durationFaster },
    ':hover .nb-cell-actions': { opacity: 1 },
    ':focus-within .nb-cell-actions': { opacity: 1 },
  },
  shellActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderLeft: `3px solid ${tokens.colorPaletteTealForeground2}`,
    '& .nb-cell-actions': { opacity: 1 },
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
    overflowX: 'auto',
    // GFM tables — bordered, padded, header-tinted so they actually look like tables.
    '& table.md-table': {
      borderCollapse: 'collapse',
      width: 'auto',
      maxWidth: '100%',
      margin: `${tokens.spacingVerticalS} 0`,
      fontSize: tokens.fontSizeBase200,
    },
    '& table.md-table th, & table.md-table td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    '& table.md-table th': {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
    '& table.md-table tr:nth-child(even) td': { backgroundColor: tokens.colorNeutralBackground2 },
    // fenced code blocks + inline code
    '& pre.md-code': {
      backgroundColor: tokens.colorNeutralBackground3,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: tokens.borderRadiusMedium,
      padding: tokens.spacingHorizontalM,
      overflowX: 'auto',
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
    },
    '& code': { fontFamily: tokens.fontFamilyMonospace, fontSize: '0.92em' },
    '& blockquote': {
      margin: `${tokens.spacingVerticalS} 0`,
      paddingLeft: tokens.spacingHorizontalM,
      borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
      color: tokens.colorNeutralForeground2,
    },
    '& h1, & h2, & h3, & h4': { marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalXS },
    '& ul, & ol': { paddingLeft: tokens.spacingHorizontalXL, margin: `${tokens.spacingVerticalXS} 0` },
    '& img': { maxWidth: '100%', borderRadius: tokens.borderRadiusSmall },
    '& a': { color: tokens.colorBrandForegroundLink },
  },
  renderedMaximized: {
    flex: 1,
    overflow: 'auto',
  },
  tag: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, fontSize: '11px' },
  hoverActions: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  // WYSIWYG markdown formatting toolbar (R4-SYN-11) — sits above the editor
  // when editing, styled like the rest of the notebook chrome.
  fmtBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minHeight: 'auto',
  },
});

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
  // Captured Monaco instance so the formatting toolbar can act on the live
  // selection; falls back to a whole-source transform when unavailable.
  const editorRef = useRef<any>(null);

  const locked = !!cell.locked;

  // Apply a WYSIWYG markdown format to the current selection (R4-SYN-11). Uses
  // the live Monaco selection when the editor is mounted; otherwise formats the
  // full source. The pure transform lives in applyMarkdownFormat.
  const applyFormat = useCallback((fmt: MarkdownFormat) => {
    if (locked) return;
    const ed = editorRef.current;
    const model = ed?.getModel?.();
    let selStart = cell.source.length;
    let selEnd = cell.source.length;
    if (ed && model) {
      const sel = ed.getSelection?.();
      if (sel) {
        selStart = model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn });
        selEnd = model.getOffsetAt({ lineNumber: sel.endLineNumber, column: sel.endColumn });
      }
    }
    const next = applyMarkdownFormat(cell.source, selStart, selEnd, fmt);
    onChange({ ...cell, source: next.source });
    // Restore selection on the next tick once the model re-renders.
    if (ed && model) {
      requestAnimationFrame(() => {
        const m2 = ed.getModel?.();
        if (!m2) return;
        const startPos = m2.getPositionAt(next.selStart);
        const endPos = m2.getPositionAt(next.selEnd);
        ed.setSelection?.({
          startLineNumber: startPos.lineNumber, startColumn: startPos.column,
          endLineNumber: endPos.lineNumber, endColumn: endPos.column,
        });
        ed.focus?.();
      });
    }
  }, [cell, locked, onChange]);

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
        {/* Cell-type badge — teal Markdown chip (Fabric cell-type parity). */}
        <Badge
          appearance="tint"
          size="small"
          icon={<TextHeader1Regular />}
          style={{ color: tokens.colorPaletteTealForeground2, flexShrink: 0 }}
          title="Markdown cell"
        >
          Markdown
        </Badge>
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
        {/* Secondary actions — hover-only (revealed via `.nb-cell-actions` on
            shell hover / focus-within / active), Fabric hover-toolbar density. */}
        <span className={mergeClasses(s.hoverActions, 'nb-cell-actions')}>
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
          <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" title="Move cell up" />
          <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" title="Move cell down" />
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" title="Delete cell" />
        </span>
      </div>
      {editing ? (
        <>
          {!locked && (
            <Toolbar size="small" className={s.fmtBar} aria-label="Markdown formatting">
              <Tooltip content="Bold" relationship="label">
                <ToolbarButton icon={<TextBold16Regular />} aria-label="Bold" onClick={(e) => { e.stopPropagation(); applyFormat('bold'); }} />
              </Tooltip>
              <Tooltip content="Italic" relationship="label">
                <ToolbarButton icon={<TextItalic16Regular />} aria-label="Italic" onClick={(e) => { e.stopPropagation(); applyFormat('italic'); }} />
              </Tooltip>
              <ToolbarDivider />
              <Tooltip content="Heading 1" relationship="label">
                <ToolbarButton icon={<TextHeader1Regular />} aria-label="Heading 1" onClick={(e) => { e.stopPropagation(); applyFormat('h1'); }} />
              </Tooltip>
              <Tooltip content="Heading 2" relationship="label">
                <ToolbarButton icon={<TextHeader2Regular />} aria-label="Heading 2" onClick={(e) => { e.stopPropagation(); applyFormat('h2'); }} />
              </Tooltip>
              <ToolbarDivider />
              <Tooltip content="Bulleted list" relationship="label">
                <ToolbarButton icon={<TextBulletList16Regular />} aria-label="Bulleted list" onClick={(e) => { e.stopPropagation(); applyFormat('ul'); }} />
              </Tooltip>
              <Tooltip content="Numbered list" relationship="label">
                <ToolbarButton icon={<TextNumberListLtr16Regular />} aria-label="Numbered list" onClick={(e) => { e.stopPropagation(); applyFormat('ol'); }} />
              </Tooltip>
              <Tooltip content="Quote" relationship="label">
                <ToolbarButton icon={<TextQuote16Regular />} aria-label="Quote" onClick={(e) => { e.stopPropagation(); applyFormat('quote'); }} />
              </Tooltip>
              <ToolbarDivider />
              <Tooltip content="Code" relationship="label">
                <ToolbarButton icon={<Code16Regular />} aria-label="Code" onClick={(e) => { e.stopPropagation(); applyFormat('code'); }} />
              </Tooltip>
              <Tooltip content="Link" relationship="label">
                <ToolbarButton icon={<Link16Regular />} aria-label="Link" onClick={(e) => { e.stopPropagation(); applyFormat('link'); }} />
              </Tooltip>
            </Toolbar>
          )}
          <MonacoTextarea
            value={cell.source}
            onChange={(next) => onChange({ ...cell, source: next })}
            language="markdown"
            readOnly={locked}
            height={maximized ? 'calc(100% - 56px)' : 160}
            minHeight={80}
            autoHeight={!maximized}
            ariaLabel={`Markdown cell ${cell.id}`}
            className={mergeClasses(locked && s.editorLocked)}
            onReady={(editor) => { editorRef.current = editor; }}
          />
        </>
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
