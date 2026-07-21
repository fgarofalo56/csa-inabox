'use client';

// pages-panel.tsx — Pages list panel (left rail) for the report designer.

import {
  Button, Caption1, Divider, Subtitle2, Text, Tooltip, Menu, MenuTrigger,
  MenuPopover, MenuList, MenuItem, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, DocumentMultiple20Regular, Edit20Regular,
  Copy20Regular, Eye16Regular, EyeOff16Regular, Delete20Regular,
} from '@fluentui/react-icons';
import type { DPage } from './types';
import type { Styles } from './styles';
import { RenamePageItem } from './rename-page-item';

export function PagesPanel({
  styles, pages, activePage, onSelectPage, onAddPage, onRenamePage, onDuplicatePage, onHidePage, onDeletePage,
}: {
  styles: Styles;
  pages: DPage[];
  activePage: number;
  onSelectPage: (i: number) => void;
  onAddPage: () => void;
  onRenamePage: (pid: string, name: string) => void;
  onDuplicatePage: (pid: string) => void;
  onHidePage: (pid: string) => void;
  onDeletePage: (pid: string) => void;
}) {
  return (
    <div className={styles.pane}>
      <div className={styles.wellHead}>
        <span className={styles.paneSectionIcon} aria-hidden><DocumentMultiple20Regular /></span>
        <Subtitle2>Pages</Subtitle2>
        <div className={styles.spacer} />
        <Tooltip content="Add page" relationship="label">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAddPage} aria-label="Add page" />
        </Tooltip>
      </div>
      <Divider />
      {pages.map((p, i) => (
        <div key={p.id} className={mergeClasses(styles.pageRow, i === activePage && styles.pageRowActive)}
          onClick={() => onSelectPage(i)}>
          <Text className={mergeClasses(styles.pageRowName, p.hidden && styles.muted)}>{p.name}</Text>
          {p.hidden && (
            <Tooltip content="Hidden from report viewers" relationship="label">
              <EyeOff16Regular />
            </Tooltip>
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label="page actions" onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <RenamePageItem name={p.name} onRename={(n) => onRenamePage(p.id, n)} />
                <MenuItem icon={<Copy20Regular />} onClick={() => onDuplicatePage(p.id)}>Duplicate page</MenuItem>
                <MenuItem icon={p.hidden ? <Eye16Regular /> : <EyeOff16Regular />} onClick={() => onHidePage(p.id)}>
                  {p.hidden ? 'Unhide page' : 'Hide page'}
                </MenuItem>
                <MenuItem icon={<Delete20Regular />} onClick={() => onDeletePage(p.id)}>Delete page</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ))}
      {pages.length === 0 && <Caption1 className={styles.muted}>No pages.</Caption1>}
    </div>
  );
}
