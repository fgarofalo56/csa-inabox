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

import React, { useCallback, useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  MarkerType, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { makeStyles, tokens, Subtitle2, Body1 } from '@fluentui/react-components';
import type { LandingZone, HubCoords, DlzAttachState } from '@/lib/setup/landing-zones-model';

const STATE_STYLE: Record<DlzAttachState, { bg: string; border: string; label: string }> = {
  attached: { bg: '#F0FDF4', border: '#16A34A', label: 'Attached' },
  detached: { bg: '#FFF7ED', border: '#B45309', label: 'Needs repair' },
  unknown: { bg: '#F5F5F5', border: tokens.colorNeutralStroke2, label: 'Unknown' },
};

const useStyles = makeStyles({
  shell: {
    position: 'relative', width: '100%', height: '100%', minHeight: '420px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, overflow: 'hidden',
  },
  legend: {
    display: 'flex', flexWrap: 'wrap', columnGap: '12px', rowGap: '6px',
    padding: '8px 10px', backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow8,
  },
  legendItem: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    fontSize: '11px', color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap',
  },
  legendSwatch: { width: '12px', height: '12px', borderRadius: '3px', flexShrink: 0 },
  empty: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '8px',
    textAlign: 'center', padding: '24px',
  },
});

const HUB_ID = '__hub__';

/** Lay the hub in the center and the DLZs around it in a ring. */
function layout(hub: HubCoords | null, zones: LandingZone[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const cx = 360, cy = 240, radius = Math.max(180, 80 + zones.length * 14);

  nodes.push({
    id: HUB_ID, type: 'default', position: { x: cx - 90, y: cy - 36 },
    draggable: false, selectable: false,
    style: {
      width: 180, padding: '10px 12px', borderRadius: 10, textAlign: 'center',
      backgroundColor: tokens.colorBrandBackground2, border: `2px solid ${tokens.colorBrandStroke1}`,
    },
    data: {
      label: (
        <div style={{ lineHeight: 1.3 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>🏛️ CSA Loom hub</div>
          <div style={{ fontSize: 10, color: tokens.colorNeutralForeground3 }}>
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
        width: 160, padding: '8px 10px', borderRadius: 8, fontSize: 11, textAlign: 'center',
        backgroundColor: st.bg, border: `2px solid ${st.border}`, cursor: 'pointer',
      },
      data: {
        zone: z,
        label: (
          <div style={{ lineHeight: 1.3 }} title={z.rg}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>📦 {z.domainName}</div>
            <div style={{ fontSize: 9, color: tokens.colorNeutralForeground3 }}>{z.region}</div>
            {z.crossSubscription && (
              <div style={{ fontSize: 8, marginTop: 2, color: '#B45309' }}>cross-subscription</div>
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
        stroke: z.attachState === 'detached' ? '#B45309' : tokens.colorBrandBackground,
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
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView minZoom={0.2} attributionPosition="bottom-left">
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
