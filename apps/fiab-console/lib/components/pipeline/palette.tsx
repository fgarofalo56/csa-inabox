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
 *
 * Web-5.0 chrome: the palette REUSES the shared canvas-node-kit so every tile
 * carries the SAME per-type glyph + per-category accent the canvas nodes use
 * (`getActivityVisual`), section headers carry the kit's category glyph +
 * accent (`CATEGORY_ICON` / `CATEGORY_ACCENT`), and tiles get accent-tinted
 * icon chips + elevation-on-hover. Every colour/space/radius/shadow is a
 * Fluent v9 `tokens.*` value or a `--loom-accent-*` var combined via the kit's
 * token-only `accentTint` / `accentGradient` helpers — no raw px / hex /
 * hardcoded shadow. The empty-search pane uses the shared `EmptyState`.
 */

import { useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Tooltip, Input, makeStyles, mergeClasses, tokens, Badge,
} from '@fluentui/react-components';
import {
  Search16Regular, ChevronDown16Regular, ChevronRight16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import {
  ACTIVITY_CATALOG, byCategory, ACTIVITY_CATEGORY_ORDER, canvasCategoryForType,
  type ActivityCategory, type ActivityTypeDef,
} from './activity-catalog';
import {
  getActivityVisual, CATEGORY_ACCENT, CATEGORY_ICON,
  accentTint, accentGradient, type CanvasNodeCategory,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalS, minWidth: '248px', maxWidth: '288px',
    overflowY: 'auto', overflowX: 'hidden',
  },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    userSelect: 'none',
    transitionProperty: 'background-color, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  headerLeft: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  headerIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px',
    borderRadius: tokens.borderRadiusMedium,
  },
  chevron: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center',
    color: tokens.colorNeutralForeground3,
  },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  tile: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    cursor: 'grab', fontSize: tokens.fontSizeBase200,
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-1px)',
    },
    ':active': { cursor: 'grabbing' },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  tileBlocked: {
    cursor: 'not-allowed',
    opacity: 0.45,
    boxShadow: tokens.shadow2,
    ':hover': { boxShadow: tokens.shadow2, transform: 'none' },
  },
  iconChip: {
    flexShrink: 0,
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  labelCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  labelText: {
    fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  typeText: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  footer: { marginTop: 'auto', color: tokens.colorNeutralForeground3 },
});

export interface PaletteProps {
  /**
   * Click-to-insert callback. Receives the catalog entry; parent is
   * responsible for stamping a fresh activity with a unique name and
   * inserting it into the pipeline spec.
   */
  onInsert: (def: ActivityTypeDef) => void;
  /**
   * Optional per-type nesting gate. When the designer is drilled into a
   * container, some container types can't be added (ADF nesting limits):
   * If/Switch can't nest inside If/Switch; ForEach/Until can't nest inside
   * ForEach/Until. A disallowed tile is disabled (no drag, no click) and its
   * tooltip explains why. When omitted (or `allowed: true`), the tile is
   * fully interactive.
   */
  addRuleFor?: (type: string) => { allowed: boolean; reason?: string };
}

export function ActivityPalette({ onInsert, addRuleFor }: PaletteProps) {
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

  /** Resolve the kit's accent for a palette group from its first member's canvas category. */
  const groupAccent = (cat: ActivityCategory): string => {
    const first = byCategory(cat)[0];
    const canvasCat: CanvasNodeCategory = first ? canvasCategoryForType(first.type) : 'move';
    return CATEGORY_ACCENT[canvasCat];
  };

  const groupGlyph = (cat: ActivityCategory) => {
    const first = byCategory(cat)[0];
    const canvasCat: CanvasNodeCategory = first ? canvasCategoryForType(first.type) : 'move';
    return CATEGORY_ICON[canvasCat];
  };

  const renderGroup = (cat: ActivityCategory, title: string) => {
    const items = byCategory(cat).filter(matches);
    if (items.length === 0) return null;
    // When searching, force-expand every group so results are visible.
    const open = q ? true : !collapsed[cat];
    const accent = groupAccent(cat);
    return (
      <div className={s.group} key={cat}>
        <div className={s.header} role="button" tabIndex={0}
          onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((c) => ({ ...c, [cat]: !c[cat] })); } }}
          aria-expanded={open}
        >
          <span className={s.headerLeft}>
            <span
              className={s.headerIcon}
              style={{ background: accentTint(accent, 14), color: accent }}
              aria-hidden="true"
            >
              {groupGlyph(cat)}
            </span>
            <Subtitle2>{title}</Subtitle2>
          </span>
          <span className={s.chevron} aria-hidden="true">
            {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
        </div>
        {open && (
          <div className={s.list}>
            {items.map((d) => {
              const rule = addRuleFor?.(d.type);
              const blocked = rule ? !rule.allowed : false;
              const tip = blocked
                ? (rule?.reason || 'Not allowed at this nesting level')
                : d.description + (d.runnable ? '' : ` — ${d.remediation || 'not runnable on this backing'}`);
              // Reuse the SAME glyph + accent the canvas node uses for this type.
              const { icon, accent: tileAccent } = getActivityVisual(d.type);
              return (
                <Tooltip
                  key={d.key}
                  content={tip}
                  relationship="description"
                  positioning="after"
                >
                  <div
                    className={mergeClasses(s.tile, blocked && s.tileBlocked)}
                    draggable={!blocked}
                    role="button"
                    tabIndex={0}
                    aria-disabled={blocked || undefined}
                    data-palette-key={d.key}
                    data-runnable={d.runnable ? 'true' : 'false'}
                    data-blocked={blocked ? 'true' : 'false'}
                    onDragStart={(e) => {
                      if (blocked) { e.preventDefault(); return; }
                      e.dataTransfer.setData('application/x-fiab-activity', d.key);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => { if (!blocked) onInsert(d); }}
                    onKeyDown={(e) => {
                      if (blocked) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInsert(d); }
                    }}
                  >
                    <span
                      className={s.iconChip}
                      style={{
                        background: accentGradient(tileAccent),
                        color: tileAccent,
                        border: `1px solid ${accentTint(tileAccent, 24)}`,
                      }}
                      aria-hidden="true"
                    >
                      {icon}
                    </span>
                    <div className={s.labelCol}>
                      <span className={s.labelText}>{d.label}</span>
                      <Caption1 className={s.typeText}>{d.type}</Caption1>
                    </div>
                    {!d.runnable && (
                      <Tooltip
                        content={d.remediation || 'Save + validate only on this backing'}
                        relationship="label"
                      >
                        <Badge
                          size="small"
                          appearance="tint"
                          color="warning"
                          icon={<Warning16Regular />}
                          aria-label="Save only — not runnable on this backing"
                        />
                      </Tooltip>
                    )}
                  </div>
                </Tooltip>
              );
            })}
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
      {total === 0 && (
        <EmptyState
          icon={<Search16Regular />}
          title="No activities found"
          body={`Nothing matches “${query}”. Try a different name or activity type — e.g. “copy”, “notebook”, or “foreach”.`}
          primaryAction={{ label: 'Clear search', appearance: 'primary', onClick: () => setQuery('') }}
        />
      )}
      <Caption1 className={s.footer}>
        {ACTIVITY_CATALOG.length} activity types · drag to canvas or click to insert
      </Caption1>
    </div>
  );
}
