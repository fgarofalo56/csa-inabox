'use client';

// arrange-bar.tsx — ArrangeBar multi-select toolbar component.

import { Badge, Button, Tooltip, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroupHeader, MenuDivider } from '@fluentui/react-components';
import {
  LockClosed20Regular, LockOpen20Regular, Eye20Regular, EyeOff20Regular,
  AlignLeft20Regular, AlignCenterHorizontal20Regular, AlignRight20Regular,
  AlignTop20Regular, AlignCenterVertical20Regular, AlignBottom20Regular,
  AlignSpaceEvenlyHorizontal20Regular, AlignSpaceEvenlyVertical20Regular,
  ArrowExpand20Regular, PositionToFront20Regular, PositionToBack20Regular,
  Group20Regular, GroupDismiss20Regular,
} from '@fluentui/react-icons';
import type { AlignEdge, DistributeAxis } from '../report/use-canvas-layout';
import type { DVisual } from './types';
import type { Styles } from './styles';

export function ArrangeBar({ styles, targets, visuals, onLock, onHide, onMatch, onZ, onAlign, onDistribute, onGroup, onUngroup, onClear }: {
  styles: Styles; targets: string[]; visuals: DVisual[];
  onLock: (lock: boolean) => void; onHide: (hide: boolean) => void;
  onMatch: (dim: 'w' | 'h') => void; onZ: (dir: 'front' | 'back') => void;
  onAlign: (edge: AlignEdge) => void; onDistribute: (axis: DistributeAxis) => void;
  onGroup: () => void; onUngroup: () => void; onClear: () => void;
}) {
  const set = new Set(targets);
  const picked = visuals.filter((v) => set.has(v.id));
  const allLocked = picked.length > 0 && picked.every((v) => v.locked);
  const allHidden = picked.length > 0 && picked.every((v) => v.hidden);
  const anyGrouped = picked.some((v) => v.groupId);
  const multi = targets.length >= 2;
  const canDistribute = targets.length >= 3;
  return (
    <div className={styles.arrangeBar} role="toolbar" aria-label="Arrange selected visuals">
      <Badge appearance="tint" color="brand">{targets.length} selected</Badge>
      <Tooltip content={allLocked ? 'Unlock' : 'Lock'} relationship="label">
        <Button size="small" appearance="subtle" icon={allLocked ? <LockClosed20Regular /> : <LockOpen20Regular />}
          onClick={() => onLock(!allLocked)}>{allLocked ? 'Unlock' : 'Lock'}</Button>
      </Tooltip>
      <Tooltip content={allHidden ? 'Show' : 'Hide'} relationship="label">
        <Button size="small" appearance="subtle" icon={allHidden ? <EyeOff20Regular /> : <Eye20Regular />}
          onClick={() => onHide(!allHidden)}>{allHidden ? 'Show' : 'Hide'}</Button>
      </Tooltip>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button size="small" appearance="subtle" icon={<AlignLeft20Regular />} disabled={!multi}>Align</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroupHeader>Align</MenuGroupHeader>
            <MenuItem icon={<AlignLeft20Regular />} onClick={() => onAlign('left')}>Align left</MenuItem>
            <MenuItem icon={<AlignCenterHorizontal20Regular />} onClick={() => onAlign('center')}>Align center</MenuItem>
            <MenuItem icon={<AlignRight20Regular />} onClick={() => onAlign('right')}>Align right</MenuItem>
            <MenuDivider />
            <MenuItem icon={<AlignTop20Regular />} onClick={() => onAlign('top')}>Align top</MenuItem>
            <MenuItem icon={<AlignCenterVertical20Regular />} onClick={() => onAlign('middle')}>Align middle</MenuItem>
            <MenuItem icon={<AlignBottom20Regular />} onClick={() => onAlign('bottom')}>Align bottom</MenuItem>
            <MenuDivider />
            <MenuGroupHeader>Distribute</MenuGroupHeader>
            <MenuItem icon={<AlignSpaceEvenlyHorizontal20Regular />} disabled={!canDistribute} onClick={() => onDistribute('horizontal')}>Distribute horizontally</MenuItem>
            <MenuItem icon={<AlignSpaceEvenlyVertical20Regular />} disabled={!canDistribute} onClick={() => onDistribute('vertical')}>Distribute vertically</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <Tooltip content="Match width" relationship="label">
        <Button size="small" appearance="subtle" icon={<ArrowExpand20Regular />} disabled={!multi} onClick={() => onMatch('w')}>Match width</Button>
      </Tooltip>
      <Tooltip content="Match height" relationship="label">
        <Button size="small" appearance="subtle" disabled={!multi} onClick={() => onMatch('h')}>Match height</Button>
      </Tooltip>
      <Tooltip content="Bring to front" relationship="label">
        <Button size="small" appearance="subtle" icon={<PositionToFront20Regular />} onClick={() => onZ('front')} />
      </Tooltip>
      <Tooltip content="Send to back" relationship="label">
        <Button size="small" appearance="subtle" icon={<PositionToBack20Regular />} onClick={() => onZ('back')} />
      </Tooltip>
      <Tooltip content="Group" relationship="label">
        <Button size="small" appearance="subtle" icon={<Group20Regular />} disabled={!multi} onClick={onGroup}>Group</Button>
      </Tooltip>
      <Tooltip content="Ungroup" relationship="label">
        <Button size="small" appearance="subtle" icon={<GroupDismiss20Regular />} disabled={!anyGrouped} onClick={onUngroup}>Ungroup</Button>
      </Tooltip>
      <div className={styles.spacer} />
      <Button size="small" appearance="subtle" onClick={onClear}>Clear</Button>
    </div>
  );
}
