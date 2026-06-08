'use client';

/**
 * ItemTile — a rounded, spaced card for one Loom item.
 *
 * A color-tinted icon chip (from item-type-visual) + title + subtitle/metadata.
 * Hover elevation, generous padding, never touching its siblings (the
 * TileGrid wrapper supplies the gap). Keyboard-activatable when `onClick`
 * is set.
 *
 *   <ItemTile
 *     type="lakehouse"
 *     title="sales_lakehouse"
 *     subtitle="Data Engineering"
 *     meta="Modified 2h ago"
 *     onClick={() => open(item)}
 *   />
 */

import * as React from 'react';
import { Text, makeStyles, tokens, mergeClasses } from '@fluentui/react-components';
import { itemVisual } from './item-type-visual';

export interface ItemTileProps {
  /** Item-type slug — drives icon + color. */
  type: string;
  title: string;
  /** Secondary line (e.g. the item-type label or category). */
  subtitle?: string;
  /** Tertiary metadata line (e.g. "Modified 2h ago"). */
  meta?: React.ReactNode;
  /** Optional trailing badge node (Preview tag, status pill, etc.). */
  badge?: React.ReactNode;
  /**
   * Optional overflow menu node (e.g. a Fluent `<Menu>…</Menu>`). Rendered
   * top-right of the tile head. Clicks inside it are stopped from bubbling to
   * the tile's own `onClick`, so the kebab opens its menu without "opening"
   * the item. Coexists with `badge` (badge sits to its left).
   */
  overflowMenu?: React.ReactNode;
  onClick?: () => void;
  /** Render the icon chip larger (default 'md'). */
  size?: 'md' | 'lg';
}

const useStyles = makeStyles({
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform, border-color',
    minWidth: 0,
  },
  clickable: {
    cursor: 'pointer',
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
    },
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  chip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
  },
  chipMd: { width: '40px', height: '40px' },
  chipLg: { width: '52px', height: '52px' },
  titleWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground4,
  },
  badge: {
    marginLeft: 'auto',
    flexShrink: 0,
  },
  overflow: {
    flexShrink: 0,
    display: 'inline-flex',
  },
  headTrailing: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
});

export function ItemTile({
  type,
  title,
  subtitle,
  meta,
  badge,
  overflowMenu,
  onClick,
  size = 'md',
}: ItemTileProps): React.ReactElement {
  const styles = useStyles();
  const visual = itemVisual(type);
  const Icon = visual.icon;
  const iconPx = size === 'lg' ? 28 : 22;

  return (
    <div
      className={mergeClasses(styles.tile, onClick ? styles.clickable : undefined)}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className={styles.head}>
        <span
          className={mergeClasses(
            styles.chip,
            size === 'lg' ? styles.chipLg : styles.chipMd,
          )}
          style={{
            backgroundColor: `${visual.color}1f`, // ~12% tint
            color: visual.color,
          }}
          aria-hidden
        >
          <Icon style={{ width: iconPx, height: iconPx, color: visual.color }} />
        </span>
        <span className={styles.titleWrap}>
          <Text className={styles.title} title={title}>
            {title}
          </Text>
          {subtitle != null && (
            <Text size={200} className={styles.subtitle} title={String(subtitle)}>
              {subtitle}
            </Text>
          )}
        </span>
        {(badge != null || overflowMenu != null) && (
          <span className={styles.headTrailing}>
            {badge != null && <span className={styles.badge}>{badge}</span>}
            {overflowMenu != null && (
              <span
                className={styles.overflow}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="presentation"
              >
                {overflowMenu}
              </span>
            )}
          </span>
        )}
      </div>
      {meta != null && (
        <Text size={200} className={styles.meta}>
          {meta}
        </Text>
      )}
    </div>
  );
}

export default ItemTile;
