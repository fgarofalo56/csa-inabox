'use client';

/**
 * CanvasPowerToolbar — the shared undo/redo + align/distribute toolbar cluster
 * (PRP W1 buttons + W3 toolbar) dropped into any canvas host's React-Flow
 * `Panel`. Undo/redo show disabled states from the history hook; the
 * align/distribute menu appears only when ≥2 nodes are selected. Fluent v9 +
 * Loom tokens; every control is keyboard reachable.
 */

import {
  Button, Tooltip, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MenuDivider, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowUndo20Regular, ArrowRedo20Regular,
  AlignLeft20Regular, AlignCenterHorizontal20Regular, AlignRight20Regular,
  AlignTop20Regular, AlignCenterVertical20Regular, AlignBottom20Regular,
  AlignSpaceEvenlyHorizontal20Regular, AlignSpaceEvenlyVertical20Regular,
  AlignStretchHorizontal20Regular,
} from '@fluentui/react-icons';
import type { AlignMode, DistributeAxis } from './canvas-align';

const useStyles = makeStyles({
  group: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginLeft: tokens.spacingHorizontalXXS,
    marginRight: tokens.spacingHorizontalXXS,
    backgroundColor: tokens.colorNeutralStroke2,
  },
});

export interface CanvasPowerToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Number of currently selected nodes — gates the align/distribute menu. */
  selectionCount: number;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: DistributeAxis) => void;
}

export function CanvasPowerToolbar({
  canUndo, canRedo, onUndo, onRedo, selectionCount, onAlign, onDistribute,
}: CanvasPowerToolbarProps) {
  const s = useStyles();
  const canDistribute = selectionCount >= 3;
  return (
    <>
      <div className={s.group}>
        <Tooltip content="Undo (Ctrl+Z)" relationship="label">
          <Button
            size="small" appearance="subtle" icon={<ArrowUndo20Regular />}
            aria-label="Undo" disabled={!canUndo} onClick={onUndo}
          />
        </Tooltip>
        <Tooltip content="Redo (Ctrl+Shift+Z)" relationship="label">
          <Button
            size="small" appearance="subtle" icon={<ArrowRedo20Regular />}
            aria-label="Redo" disabled={!canRedo} onClick={onRedo}
          />
        </Tooltip>
      </div>
      {selectionCount >= 2 && (
        <>
          <span className={s.divider} aria-hidden="true" />
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Align & distribute selection" relationship="label">
                <Button
                  size="small" appearance="subtle" icon={<AlignStretchHorizontal20Regular />}
                  aria-label={`Align or distribute ${selectionCount} selected nodes`}
                >
                  Align
                </Button>
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<AlignLeft20Regular />} onClick={() => onAlign('left')}>Align left</MenuItem>
                <MenuItem icon={<AlignCenterHorizontal20Regular />} onClick={() => onAlign('center-h')}>Align horizontal centers</MenuItem>
                <MenuItem icon={<AlignRight20Regular />} onClick={() => onAlign('right')}>Align right</MenuItem>
                <MenuDivider />
                <MenuItem icon={<AlignTop20Regular />} onClick={() => onAlign('top')}>Align top</MenuItem>
                <MenuItem icon={<AlignCenterVertical20Regular />} onClick={() => onAlign('middle')}>Align vertical middles</MenuItem>
                <MenuItem icon={<AlignBottom20Regular />} onClick={() => onAlign('bottom')}>Align bottom</MenuItem>
                <MenuDivider />
                <MenuItem
                  icon={<AlignSpaceEvenlyHorizontal20Regular />}
                  disabled={!canDistribute}
                  onClick={() => onDistribute('h')}
                >
                  Distribute horizontally
                </MenuItem>
                <MenuItem
                  icon={<AlignSpaceEvenlyVertical20Regular />}
                  disabled={!canDistribute}
                  onClick={() => onDistribute('v')}
                >
                  Distribute vertically
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </>
      )}
    </>
  );
}
