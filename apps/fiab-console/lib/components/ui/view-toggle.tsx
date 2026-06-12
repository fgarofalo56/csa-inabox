'use client';

/**
 * ViewToggle — a segmented control for switching collection views.
 *
 * Fluent v9 (9.54) has no SegmentedControl, so this is a row of grouped
 * ToggleButtons inside a tinted track; the active segment renders as a raised
 * "pill" (the modern segmented-control affordance) so the current view is
 * unambiguous. Used at the top of any collection surface to switch between the
 * ItemTile grid and the LoomDataTable list.
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
import { ToggleButton, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
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
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '2px',
    gap: '2px',
  },
  btn: {
    border: 'none',
    borderRadius: tokens.borderRadiusSmall,
    minWidth: '64px',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightRegular,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  // Selected segment reads as a raised "pill" inside the track — the modern
  // segmented-control affordance (cf. Fluent/SwiftUI), clearer than the default
  // subtle ToggleButton checked state.
  btnChecked: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: tokens.shadow2,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1,
      color: tokens.colorNeutralForeground1,
    },
  },
});

export function ViewToggle<V extends LoomGraphView = LoomView>({
  value,
  onChange,
  ariaLabel = 'Switch view',
  showGraph = false,
}: ViewToggleProps<V>): React.ReactElement {
  const styles = useStyles();
  const seg = (checked: boolean) => mergeClasses(styles.btn, checked && styles.btnChecked);
  return (
    <div className={styles.group} role="group" aria-label={ariaLabel}>
      {showGraph && (
        <ToggleButton
          className={seg(value === 'graph')}
          appearance="subtle"
          checked={value === 'graph'}
          icon={<Flowchart20Regular />}
          aria-label="Graph view"
          aria-pressed={value === 'graph'}
          onClick={() => onChange('graph' as V)}
        >
          Graph
        </ToggleButton>
      )}
      <ToggleButton
        className={seg(value === 'tile')}
        appearance="subtle"
        checked={value === 'tile'}
        icon={<Grid20Regular />}
        aria-label="Tile view"
        aria-pressed={value === 'tile'}
        onClick={() => onChange('tile' as V)}
      >
        Tiles
      </ToggleButton>
      <ToggleButton
        className={seg(value === 'list')}
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
