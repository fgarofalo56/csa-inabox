'use client';

/**
 * OutlinePane — Markdown-heading outline navigation for the Loom notebook
 * (R4-NB-6 / Fabric notebook B9). Parses `#`…`######` headings out of the
 * notebook's markdown cells and lists them (indented by level); clicking a
 * heading scrolls its cell into view. Code cells with no heading are omitted so
 * the outline reads like a document table of contents, exactly as Fabric's
 * notebook outline does.
 */

import { useMemo } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular, TextBulletListTree20Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import type { NotebookCell } from '@/lib/types/notebook-cell';

interface OutlineItem { cellId: string; level: number; text: string; }

/** Extract markdown headings (level 1-6) from the markdown cells, in order. */
export function buildOutline(cells: NotebookCell[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const c of cells) {
    if (c.type !== 'markdown') continue;
    for (const rawLine of (c.source || '').split('\n')) {
      const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(rawLine.trim());
      if (m) items.push({ cellId: c.id, level: m[1].length, text: m[2] });
    }
  }
  return items;
}

const useStyles = makeStyles({
  row: {
    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, border: 'none', background: 'transparent',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cells: NotebookCell[];
  /** Scroll the given cell into view (editor owns per-cell refs). */
  onJump: (cellId: string) => void;
}

export function OutlinePane({ open, onOpenChange, cells, onJump }: Props) {
  const s = useStyles();
  const outline = useMemo(() => buildOutline(cells), [cells]);

  return (
    <Drawer type="overlay" position="start" open={open} onOpenChange={(_, d) => onOpenChange(d.open)} size="small">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={() => onOpenChange(false)} />}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <TextBulletListTree20Regular /> Outline
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {outline.length === 0 ? (
          <EmptyState
            icon={<TextBulletListTree20Regular />}
            title="No headings yet"
            body="Add Markdown headings (# Title, ## Section) to your markdown cells and they appear here as a clickable table of contents."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
            {outline.map((it, i) => (
              <button
                key={`${it.cellId}-${i}`}
                className={s.row}
                style={{ paddingLeft: `calc(${tokens.spacingHorizontalS} + ${(it.level - 1) * 14}px)` }}
                onClick={() => { onJump(it.cellId); }}
                title={it.text}
              >
                <Caption1>{it.text}</Caption1>
              </button>
            ))}
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
