'use client';

/**
 * Shared editor chrome — every per-type editor calls this with its
 * ribbon tabs + left/main content. Mirrors the Extensibility Toolkit
 * ItemEditor + ItemEditorDefaultView two-panel layout described in
 * docs/fiab/fabric-feature-inventory.md §3.
 */

import { ReactNode, useEffect, useState } from 'react';
import { Badge, Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { PanelLeftContract20Regular, PanelLeftExpand20Regular, Sparkle20Regular, Share20Regular } from '@fluentui/react-icons';
import { PageShell, type Crumb } from '@/lib/components/page-shell';
import { getItem, getWorkspace } from '@/lib/api/workspaces';
import { useUi } from '@/lib/stores/ui';
import { openCopilot } from '@/lib/components/copilot-pane';
import { Ribbon, type RibbonTab } from '@/lib/components/ribbon';
import { ItemSidePanel } from '@/lib/components/item-side-panel';
import { EditorCollabBar } from '@/lib/components/collab/editor-collab-bar';
import { useCollapsibleState, CollapsedRail, CollapseToggle, RAIL_WIDTH } from '@/lib/components/collapsible-side-panel';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { LineageDrawer } from '@/lib/components/onelake/lineage-drawer';
import { VersionHistoryDrawer } from '@/lib/components/versions/version-history-drawer';
import { ThreadMenu } from '@/lib/components/thread/thread-menu';
import { BundleContentBar } from '@/lib/components/bundle-content-bar';
import { ShareItemDialog } from '@/lib/dialogs/share-item-dialog';
import { EndorsementControl } from '@/lib/editors/endorsement-control';
import { useUnsavedChangesGuard } from '@/lib/editors/use-unsaved-changes-guard';
import { ExplainThisButton, type ExplainConfig } from '@/lib/components/explain-this';
import { IndexMyDataButton } from '@/lib/components/ai-search/index-my-data-wizard';
import type { IndexableSourceType } from '@/lib/azure/index-my-data';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

/** Item slugs that expose the AIF-3 index-my-estate wizard in their editor header. */
const INDEXABLE_SOURCE_SLUGS = new Set<string>(['lakehouse', 'warehouse', 'kql-database']);

const useStyles = makeStyles({
  // Header badge/action row — MUST wrap and shrink (flexWrap + minWidth:0) so
  // the tags/badges never overlap the title/subtitle on narrow widths
  // (web3-ui.md: responsive + bounded; no overlapping content at any width).
  meta: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
    minWidth: 0,
    rowGap: tokens.spacingVerticalXXS,
    justifyContent: 'flex-end',
  },
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
  // Split-pane body (opt-in via `splitKeyPrefix`): a flex container the nested
  // SplitPanes fill. The panes carry their own borders/gap via the region cards.
  bodyFlex: {
    display: 'flex',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    gap: tokens.spacingHorizontalS,
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
  /**
   * Whether the editor has unsaved in-memory changes. When true, ItemEditorChrome
   * arms the shared unsaved-changes guard (native beforeunload prompt on hard
   * navigation + a confirm dialog on internal App Router link clicks) so work is
   * never silently lost (rel-T70). Editors that persist incrementally (no draft
   * state) can omit it.
   */
  dirty?: boolean;
  /**
   * The item's real display NAME (e.g. "Sales Data") — from the editor's own
   * loaded record (rel-T103). When present it titles the editor + breadcrumb
   * instead of the "<Type> (<guid8>)" fallback, so the chrome shows what the
   * user named the item rather than a GUID fragment. Editors that already hold
   * the query data pass it through; when absent the chrome falls back to its own
   * best-effort item fetch (below) and finally to the GUID-fragment format — so
   * omitting it is a no-op regression-wise.
   */
  displayName?: string;
  /**
   * Cross-item "Explain this" action (Wave-2 W19). When supplied, the header
   * renders an `Explain` button that sends the artifact's LIVE structured
   * definition (via {@link ExplainConfig.getDefinition}) to the shared
   * `/api/items/[type]/[id]/explain` edge and renders a plain-English summary +
   * inputs/outputs/risks in a Drawer. Only the pipeline / notebook / warehouse
   * editors pass it; every other editor omits it (no button) — so it is a
   * strictly additive, opt-in surface.
   */
  explain?: ExplainConfig;
  /**
   * SC-9 — render the in-ribbon command-search box (Ctrl+Q / Alt+Q). Editors
   * that also register their ribbon actions (via `useRegisterRibbonCommands`)
   * opt in by passing `commandSearch`. Additive: omitting it changes nothing.
   */
  commandSearch?: boolean;
  /**
   * R1 — opt into DRAGGABLE, persisted pane splitters (ADF-Studio / Fabric
   * parity) instead of the fixed collapsible grid. When set, the left rail ↔
   * canvas and canvas ↔ right rail boundaries become resizable via a keyboard-
   * accessible divider, with the sizes persisted under
   * `loom.splitpane.<splitKeyPrefix>.resources|copilot`. The existing collapse/
   * expand buttons keep working (they drive each SplitPane's `collapsed`).
   * Omitting it preserves today's exact grid layout for every other editor.
   */
  splitKeyPrefix?: string;
  /**
   * A14 — real-time presence on this editor. When set (the high-value
   * co-authoring editors: notebook, report designer, semantic model, unified
   * SQL), the header action row renders the EditorCollabBar avatar stack —
   * live Cosmos-backed presence over the push (SSE) transport with the poll
   * fallback, canvasKey 'editor'. Opt-in per editor so item types without a
   * co-authoring story don't pay the heartbeat. Additive: omitting it changes
   * nothing.
   */
  collabPresence?: boolean;
}

export function ItemEditorChrome({ item, id, ribbon, leftPanel, main, rightPanel, rightPanelLabel = 'Copilot', dirty = false, displayName, explain, commandSearch, splitKeyPrefix, collabPresence }: Props) {
  const styles = useStyles();
  // Shared unsaved-changes guard — one wiring covers every editor that threads
  // a `dirty` signal. Returns the confirm dialog (or null) to render below.
  const unsavedGuard = useUnsavedChangesGuard(dirty);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Best-effort real item name captured from the chrome's own item fetch (below)
  // — the fallback source when an editor doesn't pass `displayName` in, so every
  // editor still shows the real name for a persisted item (rel-T103).
  const [fetchedName, setFetchedName] = useState<string | null>(null);
  // Share dialog (Fabric "Grant people access") — reachable from EVERY editor's
  // header, not just the standalone Manage-permissions page.
  const [shareOpen, setShareOpen] = useState(false);
  // Right rail (Copilot / properties) collapse — persisted PER SURFACE so the
  // canvas keeps the width the operator chose across visits to this item type.
  const [rightCollapsed, setRightCollapsed] = useCollapsibleState(`right.${item.slug}`, false);
  const isNew = id === 'new';
  // Real item NAME resolution (rel-T103): prefer the name the editor passed in,
  // then the name from the chrome's own best-effort item fetch, and only then
  // fall back to the "<Type> (<guid8>)" format so an untitled / still-loading
  // item still reads sensibly. New items have no persisted name yet.
  const resolvedName = displayName ?? fetchedName ?? undefined;
  const title = isNew
    ? `New ${item.displayName.toLowerCase()}`
    : (resolvedName ?? `${item.displayName} (${id.substring(0, 8)})`);

  // Resolve which workspace this item belongs to so the header shows a
  // workspace › item breadcrumb (Fabric's editor breadcrumb) and the topbar
  // workspace switcher auto-pins the last-opened workspace (rel-T49). Real
  // backend: GET /api/cosmos-items/[type]/[id] → workspaceId, then GET
  // /api/workspaces/[id] → name. Best-effort — a failure leaves the default
  // Home › <title> trail intact.
  const setActiveWorkspace = useUi((s) => s.setActiveWorkspace);
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    getItem(item.slug, id)
      .then((it) => {
        // Capture the real item name for the title/breadcrumb fallback (rel-T103)
        // off the SAME fetch that resolves the workspace — no extra request.
        if (!cancelled && it?.displayName) setFetchedName(it.displayName);
        return getWorkspace(it.workspaceId);
      })
      .then((ws) => {
        if (cancelled) return;
        const ref = { id: ws.id, name: ws.name };
        setWorkspace(ref);
        setActiveWorkspace(ref);
      })
      .catch(() => { /* leave breadcrumb + switcher at their prior state */ });
    return () => { cancelled = true; };
  }, [item.slug, id, isNew, setActiveWorkspace]);

  const breadcrumbs: Crumb[] | undefined = workspace
    ? [
        { label: 'Home', href: '/' },
        { label: 'Workspaces', href: '/workspaces' },
        { label: workspace.name, href: `/workspaces/${workspace.id}` },
        { label: title },
      ]
    : undefined;

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

  // The three body regions, rendered identically by both the fixed-grid path
  // (default) and the draggable SplitPane path (opt-in via `splitKeyPrefix`).
  // Extracting them keeps the collapse/expand affordances byte-for-byte the same
  // in either layout.
  const leftRegion = leftPanel && (
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
  );
  const mainRegion = hasGrid ? <div className={styles.mainPanel}>{main}</div> : <div className={styles.singlePanel}>{main}</div>;
  const rightRegion = rightPanel && (
    rightCollapsed ? (
      <CollapsedRail side="right" label={rightPanelLabel} onExpand={() => setRightCollapsed(false)} />
    ) : (
      <div className={styles.rightPanel}>
        <CollapseToggle side="right" label={rightPanelLabel} onCollapse={() => setRightCollapsed(true)}
          style={{ float: 'right', margin: tokens.spacingVerticalXXS }} />
        {rightPanel}
      </div>
    )
  );

  // Collapsed-rail widths so SplitPane reserves exactly the grid's collapsed
  // footprint (left = 32px thin rail; right = the shared 44px Copilot rail).
  const LEFT_RAIL_PX = 32;
  const RIGHT_RAIL_PX = parseInt(RAIL_WIDTH, 10) || 44;

  // canvas ↔ right rail split (the inner boundary). `primary="second"` so the
  // divider sizes the RIGHT (Copilot) pane from its leading edge.
  const canvasWithRight = rightPanel ? (
    <SplitPane
      direction="horizontal"
      primary="second"
      storageKey={`${splitKeyPrefix}.copilot`}
      defaultSize={320}
      minSize={280}
      collapsed={rightCollapsed}
      collapsedSize={RIGHT_RAIL_PX}
      dividerLabel={`Resize the ${rightPanelLabel} panel`}
    >
      {mainRegion}
      {rightRegion}
    </SplitPane>
  ) : mainRegion;

  // Full split body: left rail ↔ (canvas ↔ right rail). `primary="first"` sizes
  // the left (resources) rail.
  const splitBody = leftPanel ? (
    <SplitPane
      direction="horizontal"
      primary="first"
      storageKey={`${splitKeyPrefix}.resources`}
      defaultSize={260}
      minSize={200}
      collapsed={leftCollapsed}
      collapsedSize={LEFT_RAIL_PX}
      dividerLabel="Resize the resources panel"
    >
      {leftRegion}
      {canvasWithRight}
    </SplitPane>
  ) : canvasWithRight;

  const bodyContent = (splitKeyPrefix && hasGrid) ? (
    <div className={styles.bodyFlex}>{splitBody}</div>
  ) : (
    <div className={hasGrid ? styles.body : ''} style={bodyStyle}>
      {leftRegion}
      {mainRegion}
      {rightRegion}
    </div>
  );

  return (
    <PageShell
      title={title}
      subtitle={item.description}
      breadcrumbs={breadcrumbs}
      actions={
        <div className={styles.meta}>
          {/* A14 — live co-authoring presence (opt-in per editor). Real Cosmos
              beacons over the SSE push transport w/ poll fallback. */}
          {!isNew && collabPresence && <EditorCollabBar itemType={item.slug} itemId={id} />}
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
          {/* Cross-item "Explain this" (Wave-2 W19) — pipeline / notebook /
              warehouse editors opt in by passing an `explain` config; the
              button sends the live artifact definition to the /explain edge. */}
          {!isNew && explain && (
            <ExplainThisButton itemType={item.slug} itemId={id} family={explain.family} getDefinition={explain.getDefinition} />
          )}
          {/* Loom Thread — weave this item into upstream/downstream Loom services. */}
          <ThreadMenu type={item.slug} id={id} name={title} workspaceId={workspace?.id} />
          {/* OneLake item-to-item lineage drawer (upstream/downstream graph). */}
          {!isNew && <LineageDrawer type={item.slug} id={id} displayName={item.displayName} />}
          {/* Version-history timeline + visual diff + restore (Wave-2 W6) —
              real Cosmos-snapshot history captured at the shared save path. */}
          {!isNew && <VersionHistoryDrawer type={item.slug} id={id} displayName={resolvedName ?? item.displayName} />}
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
          {/* Index-my-estate wizard (AIF-3) — one-click "Add search index" from a
              lakehouse / warehouse / ADX item: derives the ADLS Gen2 data source,
              builds the chunk+embed skillset, vector index, and indexer, then runs
              it. Warehouse / ADX show the honest recommended path in the wizard. */}
          {!isNew && INDEXABLE_SOURCE_SLUGS.has(item.slug) && (
            <IndexMyDataButton source={{ sourceType: item.slug as IndexableSourceType, itemId: id, itemName: resolvedName ?? item.displayName }} />
          )}
          <ItemSidePanel type={item.slug} id={id} />
        </div>
      }
    >
      <div className={styles.layout}>
        <Ribbon tabs={ribbon} commandSearch={commandSearch} />
        <BundleContentBar itemType={item.slug} itemId={id} />
        {/* Unsaved-changes confirm dialog (rel-T70) — rendered when a guarded
            internal navigation is attempted while the editor is dirty. */}
        {unsavedGuard}
        {!isNew && (
          <ShareItemDialog
            open={shareOpen}
            itemId={id}
            itemType={item.slug}
            onClose={() => setShareOpen(false)}
            onGranted={() => setShareOpen(false)}
          />
        )}
        {bodyContent}
      </div>
    </PageShell>
  );
}
