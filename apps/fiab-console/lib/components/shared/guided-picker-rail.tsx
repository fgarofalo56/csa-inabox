'use client';

/**
 * GuidedPickerRail — the shared, illustrated, categorized create / get-data
 * picker (UX-Fabric-A W3/W4). Fabric's create galleries and "Get data" flows
 * are not flat grids: they pair a categorized LEFT RAIL with a card grid of
 * branded, badged, guided cards (a "Recommended" hero on top, an auto-config
 * hint line under each card). This primitive ports that pattern one-for-one so
 * every Loom create / connect surface reads the same.
 *
 * It is PRESENTATIONAL only — the host owns the data, the search state, and the
 * filtering. Callers pass:
 *   • `categories`   — the left-rail entries (label + optional icon + count);
 *   • `items`        — the cards for the active category / search result;
 *   • `featured`     — optional brand-accented hero card(s) above the grid
 *                      (the Fabric "OneLake data hub / Recommended" analog);
 *   • `search`       — an optional search element rendered above the grid.
 *
 * Every card runs a REAL action via `onPick` (no dead tiles, per no-vaporware).
 * Branded iconography reuses the W1 `BrandedItemIcon` (single icon source of
 * truth) when `iconType` is given, else a supplied Fluent `icon`. All colour /
 * space / radius / shadow is a Fluent `tokens.*` value — no raw px, no raw hex
 * (web3-ui.md). No default export.
 */

import type { ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { ChevronRight20Regular, type FluentIcon } from '@fluentui/react-icons';
import { BrandedItemIcon } from '@/lib/components/ui/branded-item-icon';
import { EmptyState } from '@/lib/components/empty-state';

/** Badge shown on a picker card (Preview / Recommended / UI only / …). */
export interface GuidedPickerBadge {
  label: string;
  /** Fluent Badge color. Default 'brand'. */
  color?: 'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning';
  /** Fluent Badge appearance. Default 'tint'. */
  appearance?: 'filled' | 'ghost' | 'outline' | 'tint';
}

/** One card in the picker grid (or a featured hero). */
export interface GuidedPickerItem {
  key: string;
  title: string;
  description?: string;
  /** Item-type slug → BrandedItemIcon (W1 registry). Preferred. */
  iconType?: string;
  /** Fallback Fluent icon when no `iconType` is given. */
  icon?: FluentIcon;
  /** Category / auto-config hint shown as a muted caption at the card foot. */
  footer?: string;
  /** Extra badges (Preview, UI only, Deprecated, …). */
  badges?: GuidedPickerBadge[];
  /** Marks the card (and any hero) as recommended — adds a Recommended badge. */
  recommended?: boolean;
  /** Real click action. */
  onPick: () => void;
}

/** A left-rail category entry. */
export interface GuidedPickerCategory {
  key: string;
  label: string;
  icon?: FluentIcon;
  /** Optional count pill. */
  count?: number;
}

export interface GuidedPickerRailProps {
  categories: GuidedPickerCategory[];
  /** Active category key (or '' / a sentinel when searching → none highlighted). */
  activeCategory: string;
  onCategoryChange: (key: string) => void;
  /** Cards for the active category / current search result. */
  items: GuidedPickerItem[];
  /** Optional brand-accented hero card(s) above the grid (Recommended sources). */
  featured?: GuidedPickerItem[];
  /** Optional search element rendered above the grid. */
  search?: ReactNode;
  /** Empty-grid copy. */
  emptyTitle?: string;
  emptyBody?: string;
  /** Hide the left rail (search-only / single-category mode). */
  hideRail?: boolean;
  /** Accessible label for the rail region. */
  railAriaLabel?: string;
  /** Min card width in px-equivalent for the responsive grid. Default 220. */
  minCardWidth?: number;
}

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '208px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    minWidth: 0,
    minHeight: 0,
    '@media (max-width: 640px)': { gridTemplateColumns: '1fr' },
  },
  layoutNoRail: { gridTemplateColumns: 'minmax(0, 1fr)' },

  // Left rail — categorized, selectable, active-state.
  rail: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalS,
    minWidth: 0,
    '@media (max-width: 640px)': {
      borderRight: 'none',
      flexDirection: 'row', flexWrap: 'wrap',
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      paddingRight: 0, paddingBottom: tokens.spacingVerticalS,
    },
  },
  railItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    textAlign: 'left', width: '100%', minWidth: 0,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyBase, fontSize: tokens.fontSizeBase300,
    transitionProperty: 'background-color, color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' },
  },
  railItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  railIcon: { flexShrink: 0, display: 'inline-flex', fontSize: '20px' },
  railLabel: {
    flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  railCount: { flexShrink: 0 },

  // Right column — search slot + hero(es) + card grid.
  right: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, minHeight: 0 },

  // Featured hero (Recommended source) — brand-accented, full width.
  hero: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorBrandStroke2}`, borderRadius: tokens.borderRadiusLarge,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 72%)`,
    boxShadow: tokens.shadow4, cursor: 'pointer', textAlign: 'left', width: '100%', minWidth: 0,
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'box-shadow, border-color, transform', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}`, transform: 'translateY(-1px)' },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms', ':hover': { transform: 'none' } },
  },
  heroText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  heroTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  heroChevron: { flexShrink: 0, color: tokens.colorBrandForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },

  // Card grid.
  grid: {
    display: 'grid',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    alignContent: 'start',
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    textAlign: 'left', alignItems: 'flex-start',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    cursor: 'pointer', width: '100%', height: '100%', minWidth: 0,
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'box-shadow, border-color, transform', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}`, transform: 'translateY(-1px)' },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms', ':hover': { transform: 'none' } },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, width: '100%', minWidth: 0 },
  cardTitle: { minWidth: 0, overflowWrap: 'anywhere', flex: 1 },
  cardFallbackIcon: {
    flexShrink: 0, width: '40px', height: '40px', borderRadius: tokens.borderRadiusLarge,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '22px', color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2, boxShadow: tokens.shadow2,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  cardDesc: {
    color: tokens.colorNeutralForeground2, minWidth: 0, overflowWrap: 'anywhere',
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  cardFooter: { color: tokens.colorNeutralForeground3, marginTop: 'auto' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
});

/** A single guided card (used both in the grid and — inline — for heroes). */
function CardIcon({ item }: { item: GuidedPickerItem }) {
  const s = useStyles();
  if (item.iconType) return <BrandedItemIcon type={item.iconType} size="md" />;
  const Icon = item.icon;
  if (Icon) return <span className={s.cardFallbackIcon} aria-hidden><Icon /></span>;
  return null;
}

function ItemBadges({ item }: { item: GuidedPickerItem }) {
  const s = useStyles();
  const hasAny = item.recommended || (item.badges && item.badges.length > 0);
  if (!hasAny) return null;
  return (
    <div className={s.badges}>
      {item.recommended && <Badge appearance="tint" color="brand" size="small">Recommended</Badge>}
      {(item.badges ?? []).map((b) => (
        <Badge key={b.label} appearance={b.appearance ?? 'tint'} color={b.color ?? 'brand'} size="small">
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

export function GuidedPickerRail({
  categories, activeCategory, onCategoryChange, items, featured,
  search, emptyTitle = 'Nothing to show', emptyBody = 'Try a different category or search term.',
  hideRail = false, railAriaLabel = 'Categories', minCardWidth = 220,
}: GuidedPickerRailProps) {
  const s = useStyles();

  const grid = (
    <div className={s.right}>
      {search}

      {/* Featured heroes — Recommended sources (Fabric OneLake-data-hub analog). */}
      {(featured ?? []).map((f) => (
        <button key={f.key} type="button" className={s.hero} onClick={f.onPick}
          aria-label={f.title} data-guided-hero={f.key}>
          <CardIcon item={f} />
          <span className={s.heroText}>
            <span className={s.heroTitleRow}>
              <Subtitle2>{f.title}</Subtitle2>
              {f.recommended && <Badge appearance="tint" color="brand" size="small">Recommended</Badge>}
            </span>
            {f.description && <Caption1 className={s.muted}>{f.description}</Caption1>}
          </span>
          <span className={s.heroChevron} aria-hidden><ChevronRight20Regular /></span>
        </button>
      ))}

      {items.length === 0 ? (
        <EmptyState title={emptyTitle} body={emptyBody} />
      ) : (
        <div
          className={s.grid}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))` }}
          role="list"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="listitem"
              className={s.card}
              onClick={it.onPick}
              data-guided-card={it.key}
              aria-label={it.title}
            >
              <div className={s.cardHead}>
                <CardIcon item={it} />
                <Subtitle2 className={s.cardTitle}>{it.title}</Subtitle2>
              </div>
              {it.description && <Body1 className={s.cardDesc}>{it.description}</Body1>}
              <ItemBadges item={it} />
              {it.footer && <Caption1 className={s.cardFooter}>{it.footer}</Caption1>}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (hideRail) return grid;

  return (
    <div className={s.layout}>
      <div className={s.rail} role="tablist" aria-label={railAriaLabel}>
        {categories.map((c) => {
          const Icon = c.icon;
          const active = c.key === activeCategory;
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={mergeClasses(s.railItem, active && s.railItemActive)}
              onClick={() => onCategoryChange(c.key)}
              data-guided-category={c.key}
            >
              {Icon && <span className={s.railIcon} aria-hidden><Icon /></span>}
              <span className={s.railLabel}>{c.label}</span>
              {typeof c.count === 'number' && (
                <Badge className={s.railCount} appearance="tint"
                  color={active ? 'brand' : 'informative'} size="small">
                  {c.count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
      {grid}
    </div>
  );
}
