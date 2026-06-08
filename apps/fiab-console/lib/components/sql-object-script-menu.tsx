'use client';

/**
 * Shared Explorer affordances for SQL-family editors (Synapse Dedicated,
 * Fabric Warehouse → Synapse Dedicated, Databricks SQL Warehouse).
 *
 *  - <SqlObjectScriptMenu>  the per-node "…" context menu → Script as
 *    CREATE / ALTER / DROP. Each item invokes a callback that loads the real
 *    object definition (or a runnable DROP) into the editor via the engine's
 *    /script-out route. No dead controls — every menu item is wired.
 *
 *  - <SqlRowCountBadge>  a lazy row-count chip. It runs the supplied loader
 *    (a real SELECT COUNT(*) through the engine's /query route) the first time
 *    it mounts — i.e. when the parent tree branch is expanded — and renders the
 *    real count. Until the count resolves it renders nothing; it never
 *    fabricates a number, and on error it stays silent rather than lying.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Button, Tooltip, Caption1, Spinner,
} from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';

export interface SqlObjectScriptMenuProps {
  /** Display name (for aria-label only). */
  name: string;
  /** Script as CREATE → loads the real OBJECT_DEFINITION / SHOW CREATE body. */
  onScriptCreate: () => void;
  /** Script as ALTER → CREATE rewritten to CREATE OR ALTER. Omit where the
   *  engine has no ALTER (e.g. Databricks views use CREATE OR REPLACE). */
  onScriptAlter?: () => void;
  /** Script as DROP → a runnable DROP … IF EXISTS statement. */
  onScriptDrop: () => void;
}

export function SqlObjectScriptMenu({ name, onScriptCreate, onScriptAlter, onScriptDrop }: SqlObjectScriptMenuProps) {
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="Script as…" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<MoreHorizontal20Regular />}
            aria-label={`Script actions for ${name}`}
            onClick={(e) => e.stopPropagation()}
          />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={onScriptCreate}>Script as CREATE</MenuItem>
          {onScriptAlter && <MenuItem onClick={onScriptAlter}>Script as ALTER</MenuItem>}
          <MenuItem onClick={onScriptDrop}>Script as DROP</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export interface SqlRowCountBadgeProps {
  /** Stable key for the object — re-runs the loader when it changes. */
  cacheKey: string;
  /** Returns the real row count, or null if it could not be resolved. */
  load: () => Promise<number | null>;
}

export function SqlRowCountBadge({ cacheKey, load }: SqlRowCountBadgeProps) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCount(null);
    loadRef.current()
      .then((n) => { if (!cancelled) setCount(n); })
      .catch(() => { if (!cancelled) setCount(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cacheKey]);

  if (loading) return <Spinner size="extra-tiny" aria-label="Counting rows" />;
  if (count === null) return null;
  return <Caption1>· {count.toLocaleString()} rows</Caption1>;
}

export default SqlObjectScriptMenu;
