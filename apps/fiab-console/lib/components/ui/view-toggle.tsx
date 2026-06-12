'use client';

/**
 * ViewToggle — a segmented control for switching collection views.
 *
 * Fluent v9 (9.54) has no SegmentedControl, so this is a tight row of grouped
 * ToggleButtons that read as one segmented control. Used at the top of any
 * collection surface to switch between the ItemTile grid and the LoomDataTable
 * list.
 *
 *   const [view, setView] = useState<LoomView>('tile');
 *   <ViewToggle value={view} onChange={setView} />
 *
 * Surfaces with a graph/canvas view (e.g. /thread lineage) opt into a third
 * "Graph" segment via `showGraph`; the value type widens to LoomGraphView and
 * the same buttons/aria-labels are reused, so a single primitive — and a single
 * set of test selectors ("Tile view" / "List view" / "Graph view") — covers
 * every collection surface.
 */

import * as React from 'react';
import { ToggleButton, makeStyles, tokens } from '@fluentui/react-components';
import {
  Grid20Regular, AppsListDetail20Regular, Flowchart20Regular,
} from '@fluentui/react-icons';

export type LoomView = 'tile' | 'list';
/** ViewToggle value when the graph segment is enabled (`showGraph`). */
export type LoomGraphView = LoomView | 'graph';

export interface ViewToggleProps<V extends LoomGraphView = LoomView> {
  value: V;
  onChange: (value: V) => void;
  /** Optional aria-label for the group. */
  ariaLabel?: string;
  /**
   * Render a leading "Graph" segment (for lineage/canvas surfaces). When set,
   * `value`/`onChange` should be typed `LoomGraphView`.
   */
  showGraph?: boolean;
}

const useStyles = makeStyles({
  group: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  btn: {
    border: 'none',
    borderRadius: 0,
    minWidth: '40px',
  },
  divider: {
    width: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
  },
});

export function ViewToggle<V extends LoomGraphView = LoomView>({
  value,
  onChange,
  ariaLabel = 'Switch view',
  showGraph = false,
}: ViewToggleProps<V>): React.ReactElement {
  const styles = useStyles();
  return (
    <div className={styles.group} role="group" aria-label={ariaLabel}>
      {showGraph && (
        <>
          <ToggleButton
            className={styles.btn}
            appearance="subtle"
            checked={value === 'graph'}
            icon={<Flowchart20Regular />}
            aria-label="Graph view"
            aria-pressed={value === 'graph'}
            onClick={() => onChange('graph' as V)}
          >
            Graph
          </ToggleButton>
          <div className={styles.divider} aria-hidden />
        </>
      )}
      <ToggleButton
        className={styles.btn}
        appearance="subtle"
        checked={value === 'tile'}
        icon={<Grid20Regular />}
        aria-label="Tile view"
        aria-pressed={value === 'tile'}
        onClick={() => onChange('tile' as V)}
      >
        Tiles
      </ToggleButton>
      <div className={styles.divider} aria-hidden />
      <ToggleButton
        className={styles.btn}
        appearance="subtle"
        checked={value === 'list'}
        icon={<AppsListDetail20Regular />}
        aria-label="List view"
        aria-pressed={value === 'list'}
        onClick={() => onChange('list' as V)}
      >
        List
      </ToggleButton>
    </div>
  );
}

export default ViewToggle;
