'use client';

/**
 * LandingZonesCanvas — interactive hub-and-spoke visual of every Data Landing
 * Zone attached to the CSA Loom hub, rendered from REAL data served by
 * GET /api/setup/landing-zones (no mocks — see .claude/rules/no-vaporware.md).
 *
 * The hub sits in the center; each attached DLZ radiates out as a node, colored
 * by attach state (attached / detached / unknown) and labelled with its domain,
 * region, subscription, and whether it is cross-subscription. Click a DLZ → the
 * parent surfaces its detail + per-DLZ actions (the canvas raises onSelect).
 *
 * Uses @xyflow/react — the same lib the network / deploy-planner canvases use.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  MarkerType, useReactFlow, useNodesInitialized, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { makeStyles, tokens, Subtitle2, Body1 } from '@fluentui/react-components';
import { Building20Regular, Box20Regular } from '@fluentui/react-icons';
import { accentTint } from '@/lib/components/canvas/canvas-node-kit';
import type { LandingZone, HubCoords, DlzAttachState } from '@/lib/setup/landing-zones-model';

/**
 * Attach-state → theme-aware accent var + tinted background (the kit's
 * `accentTint` owns the color-mix so light + dark both read correctly — the
 * project's mermaid/dark-mode lesson: light-only pastels break under dark).
 *   attached → emerald, detached → amber, unknown → neutral.
 */
const ACCENT_EMERALD = 'var(--loom-accent-emerald)';
const ACCENT_AMBER = 'var(--loom-accent-amber)';

const STATE_STYLE: Record<DlzAttachState, { bg: string; border: string; label: string }> = {
  attached: { bg: accentTint(ACCENT_EMERALD, 8), border: ACCENT_EMERALD, label: 'Attached' },
  detached: { bg: accentTint(ACCENT_AMBER, 8), border: ACCENT_AMBER, label: 'Needs repair' },
  unknown: { bg: tokens.colorNeutralBackground2, border: tokens.colorNeutralStroke2, label: 'Unknown' },
};

const useStyles = makeStyles({
  shell: {
    // Definite height — NOT `height: 100%`. The canvas is rendered inside an
    // auto-height flex-column card, so a percentage height resolves against an
    // indefinite parent and collapses to ~0; ReactFlow then measures the
    // container as 0×0 at mount and `fitView` zooms the (small) hub+DLZ cluster
    // to nothing → blank canvas. A definite height makes the container real on
    // the first paint so the map (nodes, edges, Controls, MiniMap, legend) shows.
    position: 'relative', width: '100%', height: '480px', minHeight: '420px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, overflow: 'hidden',
  },
  legend: {
    display: 'flex', flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow8,
  },
  legendItem: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap',
  },
  legendSwatch: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0 },
  empty: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalS,
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL,
  },
});

const HUB_ID = '__hub__';

const FIT_VIEW_OPTIONS = { padding: 0.2, minZoom: 0.2, maxZoom: 1.5 } as const;

/**
 * Re-runs `fitView` once React Flow has measured every node's real dimensions
 * (and again whenever the node set changes — e.g. another DLZ is attached). The
 * `fitView` prop on <ReactFlow> only fits on the very first render, which can
 * land before node sizes are known; this guarantees the hub+DLZ cluster is
 * centered and zoomed-to-fit the moment the layout is real. Renders nothing.
 */
function FitViewOnInit({ deps }: { deps: unknown }): null {
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodesInitialized) return;
    // rAF so the fit runs after the browser has laid the container out.
    const raf = requestAnimationFrame(() => { void fitView(FIT_VIEW_OPTIONS); });
    return () => cancelAnimationFrame(raf);
  }, [nodesInitialized, fitView, deps]);
  return null;
}

/** Lay the hub in the center and the DLZs around it in a ring. */
function layout(hub: HubCoords | null, zones: LandingZone[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const cx = 360, cy = 240, radius = Math.max(180, 80 + zones.length * 14);

  nodes.push({
    id: HUB_ID, type: 'default', position: { x: cx - 90, y: cy - 36 },
    draggable: false, selectable: false,
    style: {
      width: 180,
      paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
      paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
      borderRadius: tokens.borderRadiusLarge, textAlign: 'center',
      backgroundColor: tokens.colorBrandBackground2,
      border: `2px solid ${tokens.colorBrandStroke1}`,
      boxShadow: tokens.shadow8,
    },
    data: {
      label: (
        <div style={{ lineHeight: 1.3 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            gap: tokens.spacingHorizontalXS,
            fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase300,
            color: tokens.colorNeutralForeground1,
          }}>
            <Building20Regular style={{ width: 16, height: 16, color: tokens.colorBrandForeground1 }} />
            CSA Loom hub
          </div>
          <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
            {hub?.boundary || '—'} · {hub?.location || '—'}
          </div>
        </div>
      ),
    },
  });

  zones.forEach((z, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, zones.length) - Math.PI / 2;
    const x = cx + radius * Math.cos(angle) - 80;
    const y = cy + radius * Math.sin(angle) - 32;
    const st = STATE_STYLE[z.attachState];
    nodes.push({
      id: z.id, type: 'default', position: { x, y },
      style: {
        width: 160,
        paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
        paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
        borderRadius: tokens.borderRadiusMedium, fontSize: tokens.fontSizeBase200,
        textAlign: 'center',
        backgroundColor: st.bg, border: `2px solid ${st.border}`, cursor: 'pointer',
        boxShadow: tokens.shadow4,
      },
      data: {
        zone: z,
        label: (
          <div style={{ lineHeight: 1.3 }} title={z.rg}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              gap: tokens.spacingHorizontalXS,
              fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground1,
            }}>
              <Box20Regular style={{ width: 16, height: 16, color: st.border }} />
              {z.domainName}
            </div>
            <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>{z.region}</div>
            {z.crossSubscription && (
              <div style={{ fontSize: tokens.fontSizeBase100, marginTop: tokens.spacingVerticalXXS, color: ACCENT_AMBER }}>cross-subscription</div>
            )}
          </div>
        ),
      },
    });
    edges.push({
      id: `e-${z.id}`, source: HUB_ID, target: z.id,
      animated: z.attachState === 'attached',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: z.attachState === 'detached' ? ACCENT_AMBER : tokens.colorBrandBackground,
        strokeWidth: 1.5,
        strokeDasharray: z.attachState === 'detached' ? '4,3' : undefined,
      },
    });
  });

  return { nodes, edges };
}

function CanvasInner({
  hub, zones, onSelect,
}: {
  hub: HubCoords | null;
  zones: LandingZone[];
  onSelect: (z: LandingZone) => void;
}): React.ReactElement {
  const styles = useStyles();
  const { nodes, edges } = useMemo(() => layout(hub, zones), [hub, zones]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const zone = (node.data as { zone?: LandingZone } | undefined)?.zone;
    if (zone) onSelect(zone);
  }, [onSelect]);

  if (zones.length === 0) {
    return (
      <div className={styles.shell}>
        <div className={styles.empty}>
          <Subtitle2>No Data Landing Zones attached yet</Subtitle2>
          <Body1 style={{ color: tokens.colorNeutralForeground3, maxWidth: 420 }}>
            Resource Graph found no <code>rg-csa-loom-dlz-*</code> resource groups the Console can see.
            Attach a Data Landing Zone to populate this map.
          </Body1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView fitViewOptions={FIT_VIEW_OPTIONS} minZoom={0.2} attributionPosition="bottom-left">
          <FitViewOnInit deps={nodes.length} />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
          <Panel position="top-left">
            <div className={styles.legend} aria-label="Landing zone legend">
              {(['attached', 'detached', 'unknown'] as DlzAttachState[]).map((k) => (
                <span key={k} className={styles.legendItem}>
                  <span className={styles.legendSwatch} style={{ backgroundColor: STATE_STYLE[k].bg, border: `2px solid ${STATE_STYLE[k].border}` }} />
                  {STATE_STYLE[k].label}
                </span>
              ))}
            </div>
          </Panel>
          <MiniMap position="bottom-right" pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}` }} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export function LandingZonesCanvas(props: {
  hub: HubCoords | null;
  zones: LandingZone[];
  onSelect: (z: LandingZone) => void;
}): React.ReactElement {
  return <CanvasInner {...props} />;
}

export default LandingZonesCanvas;
