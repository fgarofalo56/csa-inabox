'use client';

/**
 * Pipeline activity palette — Fabric's left-rail "Activities" sidebar.
 *
 * Two collapsible groups: "Move & transform" + "Activities". Each entry is
 * a Fluent UI Card that:
 *   - drag-starts with mime type `application/x-fiab-activity` carrying the
 *     palette key (so canvas.tsx can drop+instantiate)
 *   - clicks to insert at canvas-center (keyboard-accessible alternative)
 */

import { useState } from 'react';
import {
  Caption1, Subtitle2, Tooltip, makeStyles, tokens, Badge,
} from '@fluentui/react-components';
import { ACTIVITY_CATALOG, byCategory, type ActivityTypeDef } from './activity-catalog';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: 8,
    padding: 8, minWidth: 240, maxWidth: 280,
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
  const [openMT, setOpenMT] = useState(true);
  const [openAct, setOpenAct] = useState(true);

  const renderGroup = (
    title: string,
    open: boolean,
    onToggle: () => void,
    items: ActivityTypeDef[],
  ) => (
    <div className={s.group}>
      <div className={s.header} role="button" tabIndex={0} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
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

  return (
    <div className={s.root} role="navigation" aria-label="Pipeline activity palette">
      {renderGroup('Move & transform', openMT, () => setOpenMT((v) => !v), byCategory('move-transform'))}
      {renderGroup('Activities', openAct, () => setOpenAct((v) => !v), byCategory('activities'))}
      <Caption1 style={{ marginTop: 'auto', color: tokens.colorNeutralForeground3 }}>
        {ACTIVITY_CATALOG.length} activity types · drag to canvas or click to insert
      </Caption1>
    </div>
  );
}
