'use client';

/**
 * ViewToggle — a Tile | List segmented control.
 *
 * Fluent v9 (9.54) has no SegmentedControl, so this is a tight pair of
 * grouped ToggleButtons that read as one segmented control. Used at the top
 * of any collection surface to switch between the ItemTile grid and the
 * LoomDataTable list.
 *
 *   const [view, setView] = useState<LoomView>('tile');
 *   <ViewToggle value={view} onChange={setView} />
 */

import * as React from 'react';
import { ToggleButton, makeStyles, tokens } from '@fluentui/react-components';
import { Grid20Regular, AppsListDetail20Regular } from '@fluentui/react-icons';

export type LoomView = 'tile' | 'list';

export interface ViewToggleProps {
  value: LoomView;
  onChange: (value: LoomView) => void;
  /** Optional aria-label for the group. */
  ariaLabel?: string;
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

export function ViewToggle({
  value,
  onChange,
  ariaLabel = 'Switch view',
}: ViewToggleProps): React.ReactElement {
  const styles = useStyles();
  return (
    <div className={styles.group} role="group" aria-label={ariaLabel}>
      <ToggleButton
        className={styles.btn}
        appearance="subtle"
        checked={value === 'tile'}
        icon={<Grid20Regular />}
        aria-label="Tile view"
        aria-pressed={value === 'tile'}
        onClick={() => onChange('tile')}
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
        onClick={() => onChange('list')}
      >
        List
      </ToggleButton>
    </div>
  );
}

export default ViewToggle;
