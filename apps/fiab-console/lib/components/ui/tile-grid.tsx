'use client';

/**
 * TileGrid — responsive auto-fill CSS-grid wrapper for ItemTiles (or any
 * cards). Supplies the gap so tiles never touch each other or the edges.
 *
 *   <TileGrid>
 *     {items.map((it) => (
 *       <ItemTile key={it.id} type={it.type} title={it.name} ... />
 *     ))}
 *   </TileGrid>
 */

import * as React from 'react';
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components';

export interface TileGridProps {
  children: React.ReactNode;
  /** Min tile width before wrapping. Default 260px. */
  minTileWidth?: number;
  className?: string;
}

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: tokens.spacingHorizontalL,
    width: '100%',
    // ensure tiles never sit flush against a container edge
    paddingTop: '2px',
    paddingBottom: '2px',
  },
});

export function TileGrid({
  children,
  minTileWidth = 260,
  className,
}: TileGridProps): React.ReactElement {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(styles.grid, className)}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(${minTileWidth}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

export default TileGrid;
