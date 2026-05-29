'use client';

/**
 * Pipeline activity palette — Fabric's left-rail "Activities" sidebar.
 *
 * Three collapsible groups matching Fabric / ADF Studio exactly:
 * "Move & transform", "Orchestration", "Control flow". A search box filters
 * the whole palette (Fabric's "Search activities"). Each entry is a tile that:
 *   - drag-starts with mime type `application/x-fiab-activity` carrying the
 *     palette key (so canvas.tsx can drop+instantiate)
 *   - clicks to insert at canvas-center (keyboard-accessible alternative)
 */

import { useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Tooltip, Input, makeStyles, tokens, Badge,
} from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import {
  ACTIVITY_CATALOG, byCategory, ACTIVITY_CATEGORY_ORDER,
  type ActivityCategory, type ActivityTypeDef,
} from './activity-catalog';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: 8,
    padding: 8, minWidth: 248, maxWidth: 288,
    overflowY: 'auto', overflowX: 'hidden',
  },
  group: { display: 'flex', flexDirection: 'column', gap: 4 },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '4px 6px', cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: 4,
    userSelect: 'none',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  tile: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 8px', borderRadius: 4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'grab', fontSize: 12,
    transitionProperty: 'background-color, border-color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      borderColor: tokens.colorBrandStroke1,
    },
    ':active': { cursor: 'grabbing' },
  },
  swatch: { width: 10, height: 24, borderRadius: 2, flexShrink: 0 },
  labelCol: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
  labelText: { fontWeight: 500, color: tokens.colorNeutralForeground1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: '8px 6px', color: tokens.colorNeutralForeground3 },
});

export interface PaletteProps {
  /**
   * Click-to-insert callback. Receives the catalog entry; parent is
   * responsible for stamping a fresh activity with a unique name and
   * inserting it into the pipeline spec.
   */
  onInsert: (def: ActivityTypeDef) => void;
}

export function ActivityPalette({ onInsert }: PaletteProps) {
  const s = useStyles();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<ActivityCategory, boolean>>({
    'move-transform': false,
    'orchestration': false,
    'control-flow': false,
  });

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (d: ActivityTypeDef) =>
    !q || d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q) || d.key.toLowerCase().includes(q),
  [q]);

  const total = ACTIVITY_CATALOG.filter(matches).length;

  const renderGroup = (cat: ActivityCategory, title: string) => {
    const items = byCategory(cat).filter(matches);
    if (items.length === 0) return null;
    // When searching, force-expand every group so results are visible.
    const open = q ? true : !collapsed[cat];
    return (
      <div className={s.group} key={cat}>
        <div className={s.header} role="button" tabIndex={0}
          onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((c) => ({ ...c, [cat]: !c[cat] })); } }}
          aria-expanded={open}
        >
          <Subtitle2>{title}</Subtitle2>
          <Caption1>{open ? '▾' : '▸'}</Caption1>
        </div>
        {open && (
          <div className={s.list}>
            {items.map((d) => (
              <Tooltip
                key={d.key}
                content={d.description + (d.runnable ? '' : ` — ${d.remediation || 'not runnable on this backing'}`)}
                relationship="description"
                positioning="after"
              >
                <div
                  className={s.tile}
                  draggable
                  role="button"
                  tabIndex={0}
                  data-palette-key={d.key}
                  data-runnable={d.runnable ? 'true' : 'false'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-fiab-activity', d.key);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onInsert(d)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInsert(d); }
                  }}
                >
                  <div className={s.swatch} style={{ backgroundColor: d.color }} />
                  <div className={s.labelCol}>
                    <span className={s.labelText}>{d.label}</span>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.type}</Caption1>
                  </div>
                  {!d.runnable && (
                    <Badge size="small" appearance="outline" color="warning">!</Badge>
                  )}
                </div>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={s.root} role="navigation" aria-label="Pipeline activity palette" data-palette="activities">
      <Input
        size="small"
        contentBefore={<Search16Regular />}
        placeholder="Search activities"
        value={query}
        onChange={(_, d) => setQuery(d.value)}
        aria-label="Search activities"
      />
      {ACTIVITY_CATEGORY_ORDER.map((g) => renderGroup(g.id, g.label))}
      {total === 0 && <Caption1 className={s.empty}>No activities match “{query}”.</Caption1>}
      <Caption1 style={{ marginTop: 'auto', color: tokens.colorNeutralForeground3 }}>
        {ACTIVITY_CATALOG.length} activity types · drag to canvas or click to insert
      </Caption1>
    </div>
  );
}
