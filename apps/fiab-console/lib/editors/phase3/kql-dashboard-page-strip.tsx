'use client';

/**
 * DashboardPageStrip — the KQL dashboard's multi-page tile-container strip
 * (U8 depth; Fabric Real-Time Dashboard "Pages" parity —
 * https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create).
 *
 * A dashboard with no authored pages is the back-compat single-page canvas:
 * the strip shows one implicit "Page 1" tab plus "Add page" (adding the first
 * extra page materializes real page records — existing tiles stay on page 1
 * because `resolveTilePageId` maps unknown/absent `pageId` to the first page).
 * Rename is inline (Input in place of the tab, Enter/blur commits); Delete
 * moves the page's tiles to the first remaining page — nothing is destroyed.
 *
 * Pure presentation + callbacks: the editor owns pages/activePageId state and
 * persists them through PUT /api/items/kql-dashboard/[id] (Cosmos model).
 */

import { useState } from 'react';
import {
  Badge, Button, Caption1, Input, Tab, TabList, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Rename20Regular } from '@fluentui/react-icons';

export interface DashPage { id: string; name: string; }

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
});

export function DashboardPageStrip({
  pages, activePageId, tileCounts, onSelect, onAdd, onRename, onDelete,
}: {
  pages: DashPage[];
  /** '' selects the implicit single page when no pages are authored. */
  activePageId: string;
  /** Tile count per page id ('' = the implicit single page). */
  tileCounts: Record<string, number>;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onRename: (pageId: string, name: string) => void;
  onDelete: (pageId: string) => void;
}) {
  const s = useStyles();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Single-page mode renders one implicit tab so the strip reads the same
  // whether or not pages have been authored yet (clean first-open).
  const effective: DashPage[] = pages.length > 0 ? pages : [{ id: '', name: 'Page 1' }];
  const active = effective.some((p) => p.id === activePageId) ? activePageId : effective[0].id;
  const activePage = effective.find((p) => p.id === active);

  const commitRename = () => {
    if (renamingId !== null && renameDraft.trim()) onRename(renamingId, renameDraft.trim());
    setRenamingId(null);
  };

  return (
    <div className={s.strip} role="navigation" aria-label="Dashboard pages">
      <TabList
        size="small"
        selectedValue={active}
        onTabSelect={(_: unknown, d: { value: unknown }) => onSelect(String(d.value ?? ''))}
      >
        {effective.map((p) => (
          <Tab key={p.id || '__single__'} value={p.id} aria-label={`Page ${p.name}`}>
            {renamingId !== null && renamingId === p.id ? (
              <Input
                size="small"
                value={renameDraft}
                aria-label={`Rename page ${p.name}`}
                autoFocus
                onChange={(_: unknown, d: { value: string }) => setRenameDraft(d.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={s.tabLabel}>
                {p.name}
                <Badge size="small" appearance="tint" color="informative">{tileCounts[p.id] ?? 0}</Badge>
              </span>
            )}
          </Tab>
        ))}
      </TabList>
      <div className={s.actions}>
        {pages.length > 0 && activePage && (
          <>
            <Tooltip content={`Rename "${activePage.name}"`} relationship="label">
              <Button
                size="small" appearance="subtle" icon={<Rename20Regular />}
                aria-label={`Rename page ${activePage.name}`}
                onClick={() => { setRenamingId(active); setRenameDraft(activePage.name); }}
              />
            </Tooltip>
            {pages.length > 1 && (
              <Tooltip content={`Delete "${activePage.name}" — its tiles move to the first remaining page`} relationship="label">
                <Button
                  size="small" appearance="subtle" icon={<Delete20Regular />}
                  aria-label={`Delete page ${activePage.name}`}
                  onClick={() => onDelete(active)}
                />
              </Tooltip>
            )}
          </>
        )}
        <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd}>Add page</Button>
        {pages.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Single-page dashboard — add a page to organize tiles into containers.
          </Caption1>
        )}
      </div>
    </div>
  );
}
