'use client';

/**
 * BrandedItemIcon — a rounded-square, brand-tinted tile carrying the Fluent
 * glyph for a Loom / Fabric / Azure item type.
 *
 * This is the shared presentational primitive behind the branded iconography
 * Fabric shows on every create-gallery card and list row. It resolves the glyph
 * + accent from the single icon source of truth (`itemTypeIcon`, which sits over
 * the `item-type-visual` registry) so a `lakehouse` tile here looks identical to
 * a `lakehouse` tile in Browse, the workspace tree, and the item header.
 *
 *   <BrandedItemIcon type="eventstream" size="md" />
 *   <BrandedItemIcon type="Microsoft.Batch/batchAccounts" size="sm" />  // restType ok
 *
 * Styling is Loom-token driven (radius, shadow, spacing). The per-type brand
 * color is DATA (from the icon registry) and applied as an inline tint — the
 * same established idiom as `item-tile.tsx`'s chip, so it reads identically in
 * light + dark.
 */

import * as React from 'react';
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components';
import { itemTypeIcon } from '@/lib/catalog/item-type-icon';

export type BrandedItemIconSize = 'sm' | 'md' | 'lg';

export interface BrandedItemIconProps {
  /** Item-type identifier — a route slug, a Fabric/ARM restType, or a category. */
  type: string;
  /** Tile size. Default 'md'. */
  size?: BrandedItemIconSize;
  /** Extra className on the tile (rarely needed). */
  className?: string;
  /** Accessible label. Default is decorative (aria-hidden). */
  ariaLabel?: string;
}

/** Icon glyph px per tile size (the Fluent icon renders inside the tile). */
const ICON_PX: Record<BrandedItemIconSize, number> = { sm: 16, md: 22, lg: 28 };

const useStyles = makeStyles({
  tile: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow2,
    // Hairline border keeps the tint tile crisp on any background.
    border: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  sm: { width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium },
  md: { width: '40px', height: '40px' },
  lg: { width: '52px', height: '52px' },
});

export function BrandedItemIcon({
  type,
  size = 'md',
  className,
  ariaLabel,
}: BrandedItemIconProps): React.ReactElement {
  const styles = useStyles();
  const { icon: Icon, accent } = itemTypeIcon(type);
  const px = ICON_PX[size];

  return (
    <span
      className={mergeClasses(styles.tile, styles[size], className)}
      style={{ backgroundColor: `${accent}1f` /* ~12% brand tint */ }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <Icon style={{ width: px, height: px, color: accent }} />
    </span>
  );
}

export default BrandedItemIcon;
