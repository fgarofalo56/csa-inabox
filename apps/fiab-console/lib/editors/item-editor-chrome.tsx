'use client';

/**
 * Shared editor chrome — every per-type editor calls this with its
 * ribbon tabs + left/main content. Mirrors the Extensibility Toolkit
 * ItemEditor + ItemEditorDefaultView two-panel layout described in
 * docs/fiab/fabric-feature-inventory.md §3.
 */

import { ReactNode, useState } from 'react';
import { Badge, Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { PanelLeftContract20Regular, PanelLeftExpand20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Ribbon, type RibbonTab } from '@/lib/components/ribbon';
import { ItemSidePanel } from '@/lib/components/item-side-panel';
import { LineageDrawer } from '@/lib/components/onelake/lineage-drawer';
import { ThreadMenu } from '@/lib/components/thread/thread-menu';
import { BundleContentBar } from '@/lib/components/bundle-content-bar';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  meta: { display: 'flex', gap: '8px', alignItems: 'center' },
  // Fill the window: the editor body grows to the viewport instead of a fixed
  // 70vh / 400px, so the canvas gets the room ADF/Fabric give it.
  layout: { display: 'flex', flexDirection: 'column', gap: '8px', height: 'calc(100vh - 112px)', minHeight: '520px' },
  body: {
    display: 'grid',
    gap: '8px',
    flex: 1,
    minHeight: 0,
  },
  leftPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: 0,
  },
  rightPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: 0,
    padding: '8px',
  },
  // Thin rail shown when the left panel is collapsed — a single expand button.
  collapsedRail: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
  },
  collapseToggle: { alignSelf: 'flex-end' },
  mainPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  singlePanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    minHeight: 0,
    flex: 1,
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

export function ItemEditorChrome({ item, id, ribbon, leftPanel, main, rightPanel }: Props) {
  const styles = useStyles();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const isNew = id === 'new';
  const title = isNew ? `New ${item.displayName.toLowerCase()}` : `${item.displayName} (${id.substring(0, 8)})`;

  // When a left and/or right panel exists, lay the body out as a grid. The left
  // panel can collapse to a thin rail so the canvas gets the full width
  // (ADF/Fabric let you hide the factory-resources pane). The right rail hosts
  // properties / attribute panels (Fabric details-page right rail).
  const hasGrid = !!leftPanel || !!rightPanel;
  const bodyStyle: React.CSSProperties | undefined = hasGrid
    ? {
        gridTemplateColumns: [
          ...(leftPanel ? [leftCollapsed ? '32px' : 'minmax(220px, 280px)'] : []),
          '1fr',
          ...(rightPanel ? ['minmax(280px, 340px)'] : []),
        ].join(' '),
      }
    : undefined;

  return (
    <PageShell
      title={title}
      subtitle={item.description}
      actions={
        <div className={styles.meta}>
          <Badge appearance="outline">{item.category}</Badge>
          {item.preview && <Badge appearance="outline" color="warning">Preview</Badge>}
          {/* Loom Thread — weave this item into upstream/downstream Loom services. */}
          <ThreadMenu type={item.slug} id={id} name={title} />
          {/* OneLake item-to-item lineage drawer (upstream/downstream graph). */}
          {!isNew && <LineageDrawer type={item.slug} id={id} displayName={item.displayName} />}
          <ItemSidePanel type={item.slug} id={id} />
        </div>
      }
    >
      <div className={styles.layout}>
        <Ribbon tabs={ribbon} />
        <BundleContentBar itemType={item.slug} itemId={id} />
        <div className={hasGrid ? styles.body : ''} style={bodyStyle}>
          {leftPanel && (
            leftCollapsed ? (
              <div className={styles.collapsedRail}>
                <Tooltip content="Expand panel" relationship="label">
                  <Button appearance="subtle" size="small" icon={<PanelLeftExpand20Regular />}
                    aria-label="Expand panel" onClick={() => setLeftCollapsed(false)} />
                </Tooltip>
              </div>
            ) : (
              <div className={styles.leftPanel}>
                <Tooltip content="Collapse panel" relationship="label">
                  <Button className={styles.collapseToggle} appearance="subtle" size="small"
                    icon={<PanelLeftContract20Regular />} aria-label="Collapse panel"
                    onClick={() => setLeftCollapsed(true)} style={{ float: 'right', margin: 2 }} />
                </Tooltip>
                {leftPanel}
              </div>
            )
          )}
          {hasGrid ? <div className={styles.mainPanel}>{main}</div> : <div className={styles.singlePanel}>{main}</div>}
          {rightPanel && <div className={styles.rightPanel}>{rightPanel}</div>}
        </div>
      </div>
    </PageShell>
  );
}
