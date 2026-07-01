'use client';

/**
 * Shared editor chrome — every per-type editor calls this with its
 * ribbon tabs + left/main content. Mirrors the Extensibility Toolkit
 * ItemEditor + ItemEditorDefaultView two-panel layout described in
 * docs/fiab/fabric-feature-inventory.md §3.
 */

import { ReactNode, useState } from 'react';
import { Badge, Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { PanelLeftContract20Regular, PanelLeftExpand20Regular, Sparkle20Regular, Share20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { openCopilot } from '@/lib/components/copilot-pane';
import { Ribbon, type RibbonTab } from '@/lib/components/ribbon';
import { ItemSidePanel } from '@/lib/components/item-side-panel';
import { useCollapsibleState, CollapsedRail, CollapseToggle, RAIL_WIDTH } from '@/lib/components/collapsible-side-panel';
import { LineageDrawer } from '@/lib/components/onelake/lineage-drawer';
import { ThreadMenu } from '@/lib/components/thread/thread-menu';
import { BundleContentBar } from '@/lib/components/bundle-content-bar';
import { ShareItemDialog } from '@/lib/dialogs/share-item-dialog';
import { EndorsementControl } from '@/lib/editors/endorsement-control';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  meta: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  // Fill the window: the editor body grows to the viewport instead of a fixed
  // 70vh / 400px, so the canvas gets the room ADF/Fabric give it.
  layout: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, height: 'calc(100vh - 112px)', minHeight: '520px' },
  body: {
    display: 'grid',
    gap: tokens.spacingHorizontalS,
    flex: 1,
    minHeight: 0,
    // Smoothly animate the column resize when a side panel collapses/expands.
    transitionProperty: 'grid-template-columns',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  leftPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    minHeight: 0,
    minWidth: 0,
  },
  rightPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    minHeight: 0,
    minWidth: 0,
    padding: tokens.spacingVerticalS,
  },
  // Thin rail shown when the left panel is collapsed — a single expand button.
  collapsedRail: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  collapseToggle: { alignSelf: 'flex-end' },
  mainPanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  singlePanel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    minHeight: 0,
    minWidth: 0,
    flex: 1,
    padding: tokens.spacingVerticalL,
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
  /**
   * Label for the right rail's collapse/expand affordance + collapsed vertical
   * rail caption. Defaults to "Copilot" (most rightPanels are a Copilot pane);
   * pass e.g. "Properties" for an attribute/details rail.
   */
  rightPanelLabel?: string;
}

export function ItemEditorChrome({ item, id, ribbon, leftPanel, main, rightPanel, rightPanelLabel = 'Copilot' }: Props) {
  const styles = useStyles();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Share dialog (Fabric "Grant people access") — reachable from EVERY editor's
  // header, not just the standalone Manage-permissions page.
  const [shareOpen, setShareOpen] = useState(false);
  // Right rail (Copilot / properties) collapse — persisted PER SURFACE so the
  // canvas keeps the width the operator chose across visits to this item type.
  const [rightCollapsed, setRightCollapsed] = useCollapsibleState(`right.${item.slug}`, false);
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
          'minmax(0, 1fr)',
          ...(rightPanel ? [rightCollapsed ? RAIL_WIDTH : 'minmax(280px, 340px)'] : []),
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
          {/* Discoverable per-editor Copilot — opens the context-aware Loom
              Copilot (grounded on this item via the route) so help is one click
              away in every editor, not just the ones with a dedicated pane. */}
          <Tooltip content={`Ask Loom Copilot about this ${item.displayName.toLowerCase()} — configure it, explain options, or build it for you`} relationship="label">
            <Button appearance="subtle" size="small" icon={<Sparkle20Regular />} onClick={() => openCopilot()}>
              Copilot
            </Button>
          </Tooltip>
          {/* Loom Thread — weave this item into upstream/downstream Loom services. */}
          <ThreadMenu type={item.slug} id={id} name={title} />
          {/* OneLake item-to-item lineage drawer (upstream/downstream graph). */}
          {!isNew && <LineageDrawer type={item.slug} id={id} displayName={item.displayName} />}
          {/* Generic endorsement (Promote / Certify / Master data) — real Azure-
              native backend (Cosmos state.endorsement), on every editor. */}
          {!isNew && <EndorsementControl itemType={item.slug} itemId={id} />}
          {/* Share (Fabric "Grant people access") — opens the fully-wired
              ShareItemDialog for this item. Real backend: item-permissions. */}
          {!isNew && (
            <Tooltip content={`Share this ${item.displayName.toLowerCase()} — grant people or groups access`} relationship="label">
              <Button appearance="subtle" size="small" icon={<Share20Regular />} onClick={() => setShareOpen(true)}>
                Share
              </Button>
            </Tooltip>
          )}
          <ItemSidePanel type={item.slug} id={id} />
        </div>
      }
    >
      <div className={styles.layout}>
        <Ribbon tabs={ribbon} />
        <BundleContentBar itemType={item.slug} itemId={id} />
        {!isNew && (
          <ShareItemDialog
            open={shareOpen}
            itemId={id}
            itemType={item.slug}
            onClose={() => setShareOpen(false)}
            onGranted={() => setShareOpen(false)}
          />
        )}
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
                    onClick={() => setLeftCollapsed(true)} style={{ float: 'right', margin: tokens.spacingVerticalXXS }} />
                </Tooltip>
                {leftPanel}
              </div>
            )
          )}
          {hasGrid ? <div className={styles.mainPanel}>{main}</div> : <div className={styles.singlePanel}>{main}</div>}
          {rightPanel && (
            rightCollapsed ? (
              <CollapsedRail side="right" label={rightPanelLabel} onExpand={() => setRightCollapsed(false)} />
            ) : (
              <div className={styles.rightPanel}>
                <CollapseToggle side="right" label={rightPanelLabel} onCollapse={() => setRightCollapsed(true)}
                  style={{ float: 'right', margin: tokens.spacingVerticalXXS }} />
                {rightPanel}
              </div>
            )
          )}
        </div>
      </div>
    </PageShell>
  );
}
