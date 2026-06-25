'use client';

/**
 * FullNetworkTopologyCanvas — interactive resource-graph visual of the ENTIRE
 * CSA Loom network estate, rendered from REAL Azure Resource Graph data served
 * by GET /api/admin/network/topology (no mocks, no sample data — see
 * .claude/rules/no-vaporware.md).
 *
 * Unlike the private-endpoint-scoped `NetworkTopologyCanvas`, this maps every
 * network resource family ARG returns across LOOM_SUBSCRIPTION_ID ∪
 * LOOM_EXTRA_SUBSCRIPTIONS: vNets (containers) → subnets (nested) → and the
 * leaves that attach to a subnet — private endpoints (labelled with the service
 * they front), NSGs, Azure Firewalls, Bastion hosts, Container Apps managed
 * environments, Application Gateways, internal Load Balancers — plus vNet↔vNet
 * peering edges and floating private DNS zones.
 *
 * Layout is computed client-side from the plain `{nodes, edges}` the server
 * returns (the server can't ship JSX labels): vNets are laid out in a row with
 * their subnets stacked inside; subnet-attached leaves fan out below each
 * subnet; DNS zones sit in a bottom band. Color is keyed by resource kind with
 * CSA Loom Fluent v9 tokens. Zoom / pan / fit-view / minimap via @xyflow/react
 * (the same lib the ADF/Synapse pipeline + deploy-planner canvases use). Click
 * a node → Fluent OverlayDrawer with that resource's live ARM detail.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  MarkerType, useReactFlow, useNodesInitialized, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  makeStyles, tokens,
  Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Button,
  Badge, Body1, Body1Strong, Caption1, Subtitle2, Divider,
} from '@fluentui/react-components';
import {
  Dismiss24Regular,
  VirtualNetwork20Regular, Subtract20Regular, PlugConnected20Regular,
  Shield20Regular, Fire20Regular, GlobeShield20Regular, Box20Regular,
  Router20Regular, ArrowRouting20Regular, Cube20Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';
import type {
  TopoNode, TopoEdge, TopoNodeKind, TopologyGraph,
} from '@/lib/azure/network-topology-graph';

interface ApiResp extends Partial<TopologyGraph> {
  ok: boolean;
  error?: string;
  gate?: { reason?: string; remediation?: string };
}

/**
 * Per-kind visual style: a theme-aware accent CSS var (--loom-accent-*, defined
 * light + dark in app/globals.css) + a Fluent icon component + label. Tints and
 * gradients are derived from the accent via the kit's accentTint/accentGradient
 * helpers at render time — never a raw hex.
 */
const KIND_STYLE: Record<TopoNodeKind, { accent: string; Icon: FluentIcon; label: string }> = {
  vnet:           { accent: 'var(--loom-accent-blue)',    Icon: VirtualNetwork20Regular, label: 'Virtual network' },
  subnet:         { accent: 'var(--loom-accent-teal)',    Icon: Subtract20Regular,       label: 'Subnet' },
  pe:             { accent: 'var(--loom-accent-azure)',   Icon: PlugConnected20Regular,  label: 'Private endpoint' },
  nsg:            { accent: 'var(--loom-accent-amber)',   Icon: Shield20Regular,         label: 'Network security group' },
  firewall:       { accent: 'var(--loom-accent-red)',     Icon: Fire20Regular,           label: 'Azure Firewall' },
  privatednszone: { accent: 'var(--loom-accent-cyan)',    Icon: GlobeShield20Regular,    label: 'Private DNS zone' },
  bastion:        { accent: 'var(--loom-accent-green)',   Icon: GlobeShield20Regular,    label: 'Bastion' },
  managedenv:     { accent: 'var(--loom-accent-violet)',  Icon: Box20Regular,            label: 'Container Apps env' },
  appgateway:     { accent: 'var(--loom-accent-orange)',  Icon: Router20Regular,         label: 'Application Gateway' },
  loadbalancer:   { accent: 'var(--loom-accent-emerald)', Icon: ArrowRouting20Regular,   label: 'Load Balancer' },
};

const useStyles = makeStyles({
  shell: {
    // Definite height — NOT `height: 100%`. This canvas renders inside an
    // auto-height card (network-pane), so a percentage height resolves against
    // an indefinite parent and collapses to ~0; ReactFlow then measures the
    // container as 0×0 at mount and `fitView` zooms the (large, multi-sub)
    // estate to nothing → blank canvas even though the data loaded. A definite
    // height makes the container real on first paint so the map renders.
    position: 'relative', width: '100%', height: '640px', minHeight: '560px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, overflow: 'hidden',
  },
  detailRow: { marginBottom: '10px' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
  legend: {
    display: 'flex', flexWrap: 'wrap', columnGap: '12px', rowGap: '6px',
    maxWidth: '520px', padding: '8px 10px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow8,
  },
  legendItem: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    fontSize: '11px', color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap',
  },
  legendSwatch: {
    width: '16px', height: '16px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  empty: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '8px',
    textAlign: 'center', padding: '24px',
  },
});

/** Edge styling per relationship kind. */
function edgeStyle(kind: TopoEdge['kind']): { stroke: string; dash?: string; animated: boolean } {
  switch (kind) {
    case 'subnet':    return { stroke: tokens.colorNeutralStroke2, dash: '3,3', animated: false };
    case 'peering':   return { stroke: tokens.colorBrandBackground, animated: true };
    case 'pe-target': return { stroke: KIND_STYLE.pe.accent, animated: false };
    case 'nsg':       return { stroke: KIND_STYLE.nsg.accent, animated: false };
    case 'attach':    return { stroke: tokens.colorNeutralStroke1, animated: false };
    default:          return { stroke: tokens.colorNeutralStroke2, animated: false };
  }
}

/**
 * Compute a deterministic layout from the plain server graph. vNets row across
 * the top with subnets stacked inside; each subnet gets its OWN column so
 * leaves never overlap; private DNS zones sit in a band below the deepest leaf.
 * Returns React Flow nodes (with JSX labels) + edges.
 *
 * Coordinate system
 * ─────────────────
 *   Row 0  (y=0)                vNet containers, laid out left-to-right.
 *                                Each vNet's width = max(MIN_VNET_W, subnetCount * (LEAF_W + LEAF_GAP)).
 *                                Subnets are listed inside as dashed chips at
 *                                x=8, y=SUBNET_TOP + sIdx*SUBNET_H.
 *
 *   Row 1  (y=maxVnetBottom+80)  Leaf band — one vertical column per subnet.
 *                                subnetAbsY[snId]  = maxVnetBottom + 80   (uniform row)
 *                                subnetColX[snId]  = vnetX + sIdx*(LEAF_W+LEAF_GAP)
 *                                Within a column leaves stack at ly += LEAF_H + LEAF_V_GAP.
 *
 *   Row 2  (y=deepestLeafBottom+80)  DNS zones in a wrapping grid row.
 *
 * FIX 1 (overlap): subnetAbsY / subnetColX are now per-subnet, not per-vNet.
 * FIX 2 (DNS gap): zoneY is computed from the ACTUAL deepest leaf, not a hardcoded guess.
 */
function layout(graph: { nodes: TopoNode[]; edges: TopoEdge[] }): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // ── Sizing constants ──────────────────────────────────────────────────────
  // FIX 4: wider nodes + readable font sizes.
  const LEAF_W     = 200;   // was 150 — now legible at 1× zoom
  const LEAF_H     = 68;    // explicit height so ReactFlow can measure nodes
  const LEAF_GAP   = 28;    // horizontal gap between subnet columns (NEW)
  const LEAF_V_GAP = 16;    // vertical gap between leaves in the same column
  const MIN_VNET_W = 260;   // minimum vNet container width

  const SUBNET_H   = 46;
  const SUBNET_TOP = 40;
  const SUBNET_PAD = 12;
  const VNET_GAP   = 80;    // horizontal gap between vNet containers

  const LEAF_ROW_TOP = 80;  // gap between bottom of vNet containers and first leaf row
  const DNS_ROW_GAP  = 80;  // gap between deepest leaf and DNS zone row

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const subnetsByVnet = new Map<string, TopoNode[]>();
  const vnets = graph.nodes.filter((n) => n.kind === 'vnet');
  for (const sn of graph.nodes.filter((n) => n.kind === 'subnet')) {
    if (!sn.parentNodeId) continue;
    if (!subnetsByVnet.has(sn.parentNodeId)) subnetsByVnet.set(sn.parentNodeId, []);
    subnetsByVnet.get(sn.parentNodeId)!.push(sn);
  }

  // Per-subnet layout: absolute X for the leaf column + absolute Y for the leaf baseline.
  const subnetColX  = new Map<string, number>(); // FIX 1: per-subnet (was shared per-vNet)
  const subnetAbsY  = new Map<string, number>(); // FIX 1: uniform row, per-subnet entry

  let vnetX = 0;
  let maxVnetBottom = 0;

  for (const v of vnets) {
    const subnets = subnetsByVnet.get(v.id) || [];
    const subnetCount = Math.max(1, subnets.length);

    // FIX 1: vNet width expands to contain all its subnet columns.
    const vnetW = Math.max(MIN_VNET_W, subnetCount * (LEAF_W + LEAF_GAP) - LEAF_GAP + 16);
    const vnetH = Math.max(110, SUBNET_TOP + subnets.length * SUBNET_H + SUBNET_PAD);

    const st = KIND_STYLE.vnet;
    rfNodes.push({
      id: v.id, type: 'default', position: { x: vnetX, y: 0 },
      style: {
        width: vnetW, height: vnetH,
        padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusLarge,
        background: accentTint(st.accent, 5), border: `1.5px solid ${accentTint(st.accent, 40)}`,
        boxShadow: tokens.shadow4,
      },
      data: {
        topo: v,
        label: (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 }}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, borderRadius: tokens.borderRadiusMedium,
                  background: accentTint(st.accent, 14), color: st.accent, flexShrink: 0,
                }}
                aria-hidden="true"
              >
                <st.Icon style={{ width: 14, height: 14 }} />
              </span>
              {v.name}
            </div>
            <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
              {(v.meta?.addressPrefixes as string[] | undefined)?.join(', ') || '(no prefix)'}
            </div>
          </div>
        ),
      },
    });

    let sy = SUBNET_TOP;
    subnets.forEach((sn, sIdx) => {
      const sst = KIND_STYLE.subnet;
      // FIX 1: subnet chip width matches the column width so the chip aligns with leaves below.
      const chipW = LEAF_W;
      const chipX = 8 + sIdx * (LEAF_W + LEAF_GAP);
      rfNodes.push({
        id: sn.id, type: 'default', parentId: v.id, extent: 'parent' as const,
        position: { x: chipX, y: sy },
        style: {
          width: chipW, height: SUBNET_H - 8,
          padding: tokens.spacingHorizontalXS, borderRadius: tokens.borderRadiusMedium,
          background: accentTint(sst.accent, 4), border: `1px dashed ${accentTint(sst.accent, 40)}`,
          fontSize: tokens.fontSizeBase200,
        },
        data: {
          topo: sn,
          label: (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, lineHeight: 1.3, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', color: sst.accent }} aria-hidden="true">
                <sst.Icon style={{ width: 12, height: 12 }} />
              </span>
              <span style={{ fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200 }}>{sn.name}</span>
              <span style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
                {sn.meta?.addressPrefix as string}
              </span>
              {Number(sn.meta?.privateEndpointCount || 0) > 0 && (
                <Badge
                  appearance="tint" size="small"
                  style={{ backgroundColor: accentTint(KIND_STYLE.pe.accent, 16), color: KIND_STYLE.pe.accent }}
                >
                  {sn.meta?.privateEndpointCount as number} PE
                </Badge>
              )}
              {sn.meta?.nsg && (
                <Badge
                  appearance="tint" size="small"
                  style={{ backgroundColor: accentTint(KIND_STYLE.nsg.accent, 16), color: KIND_STYLE.nsg.accent }}
                >
                  NSG
                </Badge>
              )}
            </div>
          ),
        },
      });
      // FIX 1: each subnet gets its own column X; Y is uniform (set after all vNets are laid out).
      subnetColX.set(sn.id, vnetX + chipX);
      subnetAbsY.set(sn.id, 0); // placeholder — filled in after maxVnetBottom is known
      sy += SUBNET_H;
    });

    maxVnetBottom = Math.max(maxVnetBottom, vnetH);
    vnetX += vnetW + VNET_GAP;
  }

  // FIX 1: Now that maxVnetBottom is known, compute the uniform leaf-row Y for every subnet.
  const leafRowY = maxVnetBottom + LEAF_ROW_TOP;
  for (const [snId] of subnetAbsY) {
    subnetAbsY.set(snId, leafRowY);
  }

  // ── Leaf placement ────────────────────────────────────────────────────────
  // Leaves attached to a subnet (pe / nsg / firewall / bastion / managedenv /
  // appgateway / loadbalancer) — stack in a column beneath THEIR OWN subnet.
  const leavesBySubnet = new Map<string, TopoNode[]>();
  const subnetForLeaf = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind === 'subnet' || e.kind === 'peering') continue;
    // subnet → leaf edges: source is a subnet, target is a leaf
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    if (src?.kind === 'subnet' && tgt && tgt.kind !== 'subnet') {
      if (!subnetForLeaf.has(tgt.id)) subnetForLeaf.set(tgt.id, src.id);
    }
  }
  for (const n of graph.nodes) {
    if (n.kind === 'vnet' || n.kind === 'subnet' || n.kind === 'privatednszone') continue;
    const sn = subnetForLeaf.get(n.id);
    const key = sn || '__floating__';
    if (!leavesBySubnet.has(key)) leavesBySubnet.set(key, []);
    leavesBySubnet.get(key)!.push(n);
  }

  // Track the deepest leaf Y reached so we can place DNS zones just below.
  let deepestLeafBottom = leafRowY;

  let floatingX = vnetX; // floating leaves park to the right of all vNets
  for (const [subnetId, leaves] of leavesBySubnet) {
    const colX = subnetId === '__floating__'
      ? (floatingX += LEAF_W + LEAF_GAP, floatingX - (LEAF_W + LEAF_GAP))
      : (subnetColX.get(subnetId) ?? 0);
    let ly = subnetId === '__floating__' ? leafRowY : (subnetAbsY.get(subnetId) ?? leafRowY);
    leaves.forEach((leaf) => {
      const st = KIND_STYLE[leaf.kind];
      const LeafIcon = st?.Icon ?? Cube20Regular;
      const leafAccent = st?.accent ?? 'var(--loom-accent-blue)';
      rfNodes.push({
        id: leaf.id, type: 'default', position: { x: colX, y: ly },
        style: {
          width: LEAF_W,
          height: LEAF_H,   // FIX 4: explicit height so ReactFlow measures the node
          padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium,
          textAlign: 'center', background: accentTint(leafAccent, 6),
          border: `2px solid ${leafAccent}`,
          boxSizing: 'border-box' as const,
          boxShadow: tokens.shadow4,
        },
        data: {
          topo: leaf,
          label: (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS, lineHeight: 1.35 }} title={leaf.name}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 26, height: 26, borderRadius: tokens.borderRadiusMedium,
                  background: accentTint(leafAccent, 14), color: leafAccent,
                }}
                aria-hidden="true"
              >
                <LeafIcon style={{ width: 16, height: 16 }} />
              </span>
              {/* FIX 4: label font raised to 12px */}
              <div style={{ fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {leaf.name}
              </div>
              {leaf.kind === 'pe' && leaf.meta?.target && (
                // FIX 4: PE target with ellipsis + title tooltip
                <div
                  style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={leaf.meta.target as string}
                >
                  → {leaf.meta.target as string}
                </div>
              )}
            </div>
          ),
        },
      });
      ly += LEAF_H + LEAF_V_GAP;
      deepestLeafBottom = Math.max(deepestLeafBottom, ly);
    });
  }

  // ── DNS zone band ─────────────────────────────────────────────────────────
  // FIX 2: zoneY computed from ACTUAL deepest leaf, not a hardcoded +320 guess.
  const dnsZones = graph.nodes.filter((n) => n.kind === 'privatednszone');
  const DNS_ZONE_W = LEAF_W;
  const DNS_ZONE_H = 48;
  const DNS_COLS    = Math.max(1, Math.floor((vnetX - VNET_GAP + LEAF_GAP) / (DNS_ZONE_W + LEAF_GAP)));
  const zoneY = deepestLeafBottom + DNS_ROW_GAP;
  dnsZones.forEach((z, i) => {
    const st = KIND_STYLE.privatednszone;
    const col = i % DNS_COLS;
    const row = Math.floor(i / DNS_COLS);
    rfNodes.push({
      id: z.id, type: 'default',
      position: { x: col * (DNS_ZONE_W + LEAF_GAP), y: zoneY + row * (DNS_ZONE_H + 12) },
      style: {
        width: DNS_ZONE_W, height: DNS_ZONE_H,
        padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium,
        boxSizing: 'border-box' as const,
        background: accentTint(st.accent, 5), border: `1px solid ${accentTint(st.accent, 40)}`,
        boxShadow: tokens.shadow4,
      },
      data: {
        topo: z,
        label: (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, color: st.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }} title={z.name}>
            <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }} aria-hidden="true">
              <st.Icon style={{ width: 14, height: 14 }} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {z.name.replace('privatelink.', '')}
            </span>
          </div>
        ),
      },
    });
  });

  // Edges — only between nodes that actually rendered.
  const rendered = new Set(rfNodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!rendered.has(e.source) || !rendered.has(e.target)) continue;
    const s = edgeStyle(e.kind);
    rfEdges.push({
      id: e.id, source: e.source, target: e.target,
      label: e.kind === 'peering' ? e.label : undefined,
      animated: s.animated,
      markerEnd: e.kind === 'peering' ? { type: MarkerType.ArrowClosed } : undefined,
      style: { stroke: s.stroke, strokeWidth: e.kind === 'peering' ? 1.75 : 1.25, strokeDasharray: s.dash },
      labelStyle: { fontSize: 9, fill: tokens.colorNeutralForeground3 },
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

/** Detail drawer body for a selected topology node. */
function DetailBody({ topo }: { topo: TopoNode }): React.ReactElement {
  const styles = useStyles();
  const meta = topo.meta || {};
  const row = (label: string, val: React.ReactNode) => (
    <div className={styles.detailRow}><Body1Strong>{label}</Body1Strong><br />{val}</div>
  );
  return (
    <div>
      {row('Kind', <Badge appearance="tint" color="brand">{KIND_STYLE[topo.kind].label}</Badge>)}
      {row('Resource type', <span className={styles.mono}>{topo.type}</span>)}
      {topo.location && row('Location', topo.location)}
      {topo.resourceGroup && row('Resource group', <span className={styles.mono}>{topo.resourceGroup}</span>)}
      {topo.subscriptionId && row('Subscription', <span className={styles.mono}>{topo.subscriptionId}</span>)}
      {Object.keys(meta).length > 0 && <Divider style={{ margin: '12px 0' }} />}
      {Object.entries(meta).map(([k, v]) => row(
        k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
        Array.isArray(v)
          ? (v.length ? <span className={styles.mono}>{v.join(', ')}</span> : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>)
          : <span className={styles.mono}>{String(v) || '—'}</span>,
      ))}
      <Divider style={{ margin: '12px 0' }} />
      {row('Resource ID', <span className={styles.mono} style={{ fontSize: 11 }}>{topo.armId}</span>)}
    </div>
  );
}

const NODE_LEGEND: TopoNodeKind[] = [
  'vnet', 'subnet', 'pe', 'nsg', 'firewall', 'bastion', 'managedenv', 'appgateway', 'loadbalancer', 'privatednszone',
];

const FIT_VIEW_OPTIONS = { padding: 0.15, minZoom: 0.1, maxZoom: 1.5 } as const;

/**
 * Re-runs `fitView` once React Flow has measured every node's real dimensions
 * (and again whenever the node count changes — e.g. a refetch returns more
 * resources). The `fitView` prop on <ReactFlow> only fits on the very first
 * render, which can land before node sizes are known; on a large multi-sub
 * estate that leaves the graph framed wrong or off-screen. This guarantees the
 * whole estate is centered and zoomed-to-fit the moment the layout is real.
 * Renders nothing.
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

function GraphInner({ graph }: { graph: { nodes: TopoNode[]; edges: TopoEdge[] } }): React.ReactElement {
  const styles = useStyles();
  const [selected, setSelected] = useState<TopoNode | null>(null);
  const { nodes, edges } = useMemo(() => layout(graph), [graph]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const topo = (node.data as { topo?: TopoNode } | undefined)?.topo;
    if (topo) setSelected(topo);
  }, []);

  if (nodes.length === 0) {
    return (
      <div className={styles.shell}>
        <div className={styles.empty}>
          <Subtitle2>No network resources to map</Subtitle2>
          <Body1 style={{ color: tokens.colorNeutralForeground3, maxWidth: 380 }}>
            Azure Resource Graph returned no virtual networks, private endpoints, firewalls, or other
            network resources for the readable subscription(s). Once the network bicep module deploys the
            hub/spoke vNets and their endpoints, the live topology renders here.
          </Body1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.1}
          attributionPosition="bottom-left"
        >
          <FitViewOnInit deps={nodes.length} />
          {/* FIX 3: Dots background to match every other Loom canvas (pipeline, deploy-planner, landing-zones). */}
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
          <Controls showInteractive={false} />
          <Panel position="top-left">
            <div className={styles.legend} aria-label="Topology legend">
              {NODE_LEGEND.map((k) => {
                const { accent, Icon, label } = KIND_STYLE[k];
                return (
                  <span key={k} className={styles.legendItem}>
                    <span
                      className={styles.legendSwatch}
                      style={{ background: accentTint(accent, 16), border: `2px solid ${accent}`, color: accent }}
                      aria-hidden="true"
                    >
                      <Icon style={{ width: 12, height: 12 }} />
                    </span>
                    {label}
                  </span>
                );
              })}
            </div>
          </Panel>
          <MiniMap
            position="bottom-right" pannable zoomable
            nodeColor={(n) => {
              const k = (n.data as { topo?: TopoNode } | undefined)?.topo?.kind;
              return k ? KIND_STYLE[k].accent : tokens.colorNeutralStroke2;
            }}
            style={{ backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}` }}
          />
        </ReactFlow>
      </ReactFlowProvider>

      <OverlayDrawer position="end" open={selected != null} onOpenChange={(_, d) => { if (!d.open) setSelected(null); }} size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={() => setSelected(null)} />}>
            {selected?.name || ''}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {selected ? <DetailBody topo={selected} /> : <Body1>Select a node.</Body1>}
        </DrawerBody>
      </OverlayDrawer>
    </div>
  );
}

/**
 * Self-contained section: fetches /api/admin/network/topology and renders the
 * full-estate React Flow graph, an honest MessageBar gate, or a spinner.
 */
export function FullNetworkTopologyCanvas(): React.ReactElement {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/admin/network/topology');
        const j = (await r.json()) as ApiResp;
        if (alive) setData(j);
      } catch (e: any) {
        if (alive) setData({ ok: false, error: e?.message || String(e) });
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <Spinner label="Querying Azure Resource Graph for the network estate…" />;

  if (!data || !data.ok) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Couldn’t render the network topology</MessageBarTitle>
          {data?.gate?.remediation || data?.error || 'Unknown error.'}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const c = data.counts;
  const summary = c
    ? [
        c.vnet && `${c.vnet} vNet${c.vnet > 1 ? 's' : ''}`,
        c.subnet && `${c.subnet} subnet${c.subnet > 1 ? 's' : ''}`,
        c.pe && `${c.pe} private endpoint${c.pe > 1 ? 's' : ''}`,
        c.nsg && `${c.nsg} NSG${c.nsg > 1 ? 's' : ''}`,
        c.firewall && `${c.firewall} firewall${c.firewall > 1 ? 's' : ''}`,
        c.bastion && `${c.bastion} Bastion`,
        c.managedenv && `${c.managedenv} Container Apps env`,
        c.appgateway && `${c.appgateway} App Gateway`,
        c.loadbalancer && `${c.loadbalancer} load balancer${c.loadbalancer > 1 ? 's' : ''}`,
        c.privatednszone && `${c.privatednszone} DNS zone${c.privatednszone > 1 ? 's' : ''}`,
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <div>
      {summary && (
        <Caption1 block style={{ marginBottom: 10, color: tokens.colorNeutralForeground3 }}>
          {summary}
          {data.subscriptions?.length ? ` — across ${data.subscriptions.length} subscription${data.subscriptions.length > 1 ? 's' : ''}` : ''}
        </Caption1>
      )}
      <GraphInner graph={{ nodes: data.nodes || [], edges: data.edges || [] }} />
    </div>
  );
}

export default FullNetworkTopologyCanvas;
