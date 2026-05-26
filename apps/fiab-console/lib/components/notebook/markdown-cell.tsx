'use client';

import { useState } from 'react';
import { Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Edit16Regular, Eye16Regular, Delete16Regular, ChevronUp16Regular, ChevronDown16Regular } from '@fluentui/react-icons';
import type { NotebookCell } from '@/lib/types/notebook-cell';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  shellActive: { border: `1px solid ${tokens.colorBrandStroke1}` },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px 4px 0 0',
  },
  spacer: { flex: 1 },
  editor: {
    width: '100%', minHeight: 80,
    fontFamily: 'Consolas, monospace', fontSize: 13, padding: 8,
    border: 'none', outline: 'none',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1, resize: 'vertical',
  },
  rendered: {
    padding: 12,
    fontSize: 14,
    lineHeight: 1.5,
    color: tokens.colorNeutralForeground1,
  },
  tag: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, fontSize: 11 },
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
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export function MarkdownCell({ cell, active, onFocus, onChange, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: MarkdownCellProps) {
  const s = useStyles();
  const [editing, setEditing] = useState(!cell.source);

  return (
    <div className={`${s.shell} ${active ? s.shellActive : ''}`} onClick={onFocus}>
      <div className={s.header}>
        <Caption1 className={s.tag}># md</Caption1>
        <Button size="small" appearance="subtle" icon={editing ? <Eye16Regular /> : <Edit16Regular />} onClick={(e) => { e.stopPropagation(); setEditing(!editing); }}>
          {editing ? 'View' : 'Edit'}
        </Button>
        <div className={s.spacer} />
        <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" />
        <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" />
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" />
      </div>
      {editing ? (
        <textarea
          className={s.editor}
          value={cell.source}
          spellCheck
          onChange={(e) => onChange({ ...cell, source: e.target.value })}
          onBlur={() => cell.source.trim() && setEditing(false)}
          aria-label={`Markdown cell ${cell.id}`}
        />
      ) : (
        <div
          className={s.rendered}
          onDoubleClick={() => setEditing(true)}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source || '_Empty markdown cell — double-click to edit._') }}
        />
      )}
    </div>
  );
}
