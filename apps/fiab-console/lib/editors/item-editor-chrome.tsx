'use client';

/**
 * Shared editor chrome — every per-type editor calls this with its
 * ribbon tabs + left/main content. Mirrors the Extensibility Toolkit
 * ItemEditor + ItemEditorDefaultView two-panel layout described in
 * docs/fiab/fabric-feature-inventory.md §3.
 */

import { ReactNode } from 'react';
import { Badge, makeStyles, tokens } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { Ribbon, type RibbonTab } from '@/lib/components/ribbon';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  meta: { display: 'flex', gap: '8px', alignItems: 'center' },
  layout: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '70vh' },
  body: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 280px) 1fr',
    gap: '12px',
    flex: 1,
    minHeight: 0,
  },
  leftPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: '400px',
  },
  mainPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: '400px',
    display: 'flex',
    flexDirection: 'column',
  },
  singlePanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: '400px',
    padding: '16px',
  },
});

interface Props {
  item: FabricItemType;
  id: string;
  ribbon: RibbonTab[];
  /** Optional left-pane content (tree, explorer, etc.). Omit for full-width editors. */
  leftPanel?: ReactNode;
  /** Main content area. */
  main: ReactNode;
  /** Right rail (Copilot, properties, etc.). Phase 6 wires this in across all editors. */
  rightPanel?: ReactNode;
}

export function ItemEditorChrome({ item, id, ribbon, leftPanel, main }: Props) {
  const styles = useStyles();
  const isNew = id === 'new';
  const title = isNew ? `New ${item.displayName.toLowerCase()}` : `${item.displayName} (${id.substring(0, 8)})`;

  return (
    <PageShell
      title={title}
      subtitle={item.description}
      actions={
        <div className={styles.meta}>
          <Badge appearance="outline">{item.category}</Badge>
          {item.preview && <Badge appearance="outline" color="warning">Preview</Badge>}
        </div>
      }
    >
      <div className={styles.layout}>
        <Ribbon tabs={ribbon} />
        <div className={leftPanel ? styles.body : ''}>
          {leftPanel && <div className={styles.leftPanel}>{leftPanel}</div>}
          {leftPanel ? <div className={styles.mainPanel}>{main}</div> : <div className={styles.singlePanel}>{main}</div>}
        </div>
      </div>
    </PageShell>
  );
}
