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
  MarkerType, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  makeStyles, tokens,
  Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Button,
  Badge, Body1, Body1Strong, Caption1, Subtitle2, Divider,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import type {
  TopoNode, TopoEdge, TopoNodeKind, TopologyGraph,
} from '@/lib/azure/network-topology-graph';

interface ApiResp extends Partial<TopologyGraph> {
  ok: boolean;
  error?: string;
  gate?: { reason?: string; remediation?: string };
}

/** Per-kind visual style: container styling differs from leaf chips. */
const KIND_STYLE: Record<TopoNodeKind, { bg: string; border: string; icon: string; label: string }> = {
  vnet:           { bg: '#F5F5F5', border: tokens.colorBrandBackground, icon: '🌐', label: 'Virtual network' },
  subnet:         { bg: '#FAFAFA', border: tokens.colorNeutralStroke2, icon: '▦', label: 'Subnet' },
  pe:             { bg: '#EFF6FC', border: '#0F6CBD', icon: '🔌', label: 'Private endpoint' },
  nsg:            { bg: '#FFF7ED', border: '#B45309', icon: '🛡️', label: 'Network security group' },
  firewall:       { bg: '#FEF2F2', border: '#DC2626', icon: '🔥', label: 'Azure Firewall' },
  privatednszone: { bg: '#F0F9FF', border: tokens.colorBrandBackground2, icon: '🧭', label: 'Private DNS zone' },
  bastion:        { bg: '#F0FDF4', border: '#16A34A', icon: '🧱', label: 'Bastion' },
  managedenv:     { bg: '#F0E8FF', border: '#7C3AED', icon: '📦', label: 'Container Apps env' },
  appgateway:     { bg: '#FEF3E2', border: '#D97706', icon: '🚪', label: 'Application Gateway' },
  loadbalancer:   { bg: '#ECFEFF', border: '#0891B2', icon: '⚖️', label: 'Load Balancer' },
};

const useStyles = makeStyles({
  shell: {
    position: 'relative', width: '100%', height: '100%', minHeight: '560px',
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
  legendSwatch: { width: '12px', height: '12px', borderRadius: '3px', flexShrink: 0 },
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
    case 'pe-target': return { stroke: '#0F6CBD', animated: false };
    case 'nsg':       return { stroke: '#B45309', animated: false };
    case 'attach':    return { stroke: tokens.colorNeutralStroke1, animated: false };
    default:          return { stroke: tokens.colorNeutralStroke2, animated: false };
  }
}

/**
 * Compute a deterministic layout from the plain server graph. vNets row across
 * the top with subnets stacked inside; each subnet's attached leaves fan out in
 * a column beneath it; private DNS zones in a bottom band. Returns React Flow
 * nodes (with JSX labels) + edges.
 */
function layout(graph: { nodes: TopoNode[]; edges: TopoEdge[] }): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  const VNET_W = 300, SUBNET_H = 46, SUBNET_TOP = 40, SUBNET_PAD = 10, VNET_GAP = 60;
  const LEAF_W = 150, LEAF_H = 56;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const subnetsByVnet = new Map<string, TopoNode[]>();
  const vnets = graph.nodes.filter((n) => n.kind === 'vnet');
  for (const sn of graph.nodes.filter((n) => n.kind === 'subnet')) {
    if (!sn.parentNodeId) continue;
    if (!subnetsByVnet.has(sn.parentNodeId)) subnetsByVnet.set(sn.parentNodeId, []);
    subnetsByVnet.get(sn.parentNodeId)!.push(sn);
  }

  // Map each subnet → its on-canvas absolute Y baseline so leaves can stack below.
  const subnetAbsY = new Map<string, number>();
  const subnetX = new Map<string, number>();

  let vnetX = 0;
  let maxVnetBottom = 0;
  for (const v of vnets) {
    const subnets = subnetsByVnet.get(v.id) || [];
    const vnetH = Math.max(110, SUBNET_TOP + subnets.length * SUBNET_H + SUBNET_PAD);
    const st = KIND_STYLE.vnet;
    rfNodes.push({
      id: v.id, type: 'default', position: { x: vnetX, y: 0 },
      style: {
        width: VNET_W, height: vnetH, padding: 10, borderRadius: 8,
        backgroundColor: st.bg, border: `2px solid ${st.border}`,
      },
      data: {
        topo: v,
        label: (
          <div>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{st.icon} {v.name}</div>
            <div style={{ fontSize: 10, color: tokens.colorNeutralForeground3 }}>
              {(v.meta?.addressPrefixes as string[] | undefined)?.join(', ') || '(no prefix)'}
            </div>
          </div>
        ),
      },
    });

    let sy = SUBNET_TOP;
    for (const sn of subnets) {
      const sst = KIND_STYLE.subnet;
      rfNodes.push({
        id: sn.id, type: 'default', parentId: v.id, extent: 'parent' as const,
        position: { x: 8, y: sy },
        style: {
          width: VNET_W - 16, height: SUBNET_H - 8, padding: 6, borderRadius: 4,
          backgroundColor: sst.bg, border: `1px dashed ${sst.border}`, fontSize: 11,
        },
        data: {
          topo: sn,
          label: (
            <div style={{ lineHeight: 1.25 }}>
              <span style={{ fontWeight: 600 }}>{sn.name}</span>{' '}
              <span style={{ fontSize: 9, color: tokens.colorNeutralForeground3 }}>
                {sn.meta?.addressPrefix as string}
              </span>
              {Number(sn.meta?.privateEndpointCount || 0) > 0 && (
                <span style={{ marginLeft: 4, fontSize: 8, background: tokens.colorBrandBackground, color: '#FFF', padding: '1px 4px', borderRadius: 3 }}>
                  {sn.meta?.privateEndpointCount as number} PE
                </span>
              )}
              {sn.meta?.nsg && (
                <span style={{ marginLeft: 4, fontSize: 8, background: '#B45309', color: '#FFF', padding: '1px 4px', borderRadius: 3 }}>NSG</span>
              )}
            </div>
          ),
        },
      });
      subnetAbsY.set(sn.id, vnetH + 40); // baseline below this vNet
      subnetX.set(sn.id, vnetX + (VNET_W - LEAF_W) / 2);
      sy += SUBNET_H;
    }

    maxVnetBottom = Math.max(maxVnetBottom, vnetH);
    vnetX += VNET_W + VNET_GAP;
  }

  // Leaves attached to a subnet (pe / nsg / firewall / bastion / managedenv /
  // appgateway / loadbalancer) — stack in a column beneath their FIRST subnet.
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

  const leafBaseline = maxVnetBottom + 60;
  let floatingX = 0;
  for (const [subnetId, leaves] of leavesBySubnet) {
    const colX = subnetId === '__floating__'
      ? (floatingX += LEAF_W + 24, floatingX - (LEAF_W + 24))
      : (subnetX.get(subnetId) ?? 0);
    let ly = subnetId === '__floating__' ? leafBaseline : (subnetAbsY.get(subnetId) ?? leafBaseline);
    leaves.forEach((leaf) => {
      const st = KIND_STYLE[leaf.kind];
      rfNodes.push({
        id: leaf.id, type: 'default', position: { x: colX, y: ly },
        style: {
          width: LEAF_W, padding: '6px 8px', borderRadius: 4, fontSize: 10,
          textAlign: 'center', backgroundColor: st.bg, border: `2px solid ${st.border}`,
        },
        data: {
          topo: leaf,
          label: (
            <div style={{ lineHeight: 1.3 }} title={leaf.name}>
              <div>{st.icon}</div>
              <div style={{ fontSize: 9, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {leaf.name}
              </div>
              {leaf.kind === 'pe' && leaf.meta?.target && (
                <div style={{ fontSize: 8, color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  → {leaf.meta.target as string}
                </div>
              )}
            </div>
          ),
        },
      });
      ly += LEAF_H + 14;
    });
  }

  // Private DNS zones — floating info band at the very bottom.
  const dnsZones = graph.nodes.filter((n) => n.kind === 'privatednszone');
  const zoneY = leafBaseline + 320;
  dnsZones.forEach((z, i) => {
    const st = KIND_STYLE.privatednszone;
    rfNodes.push({
      id: z.id, type: 'default', position: { x: i * (LEAF_W + 16), y: zoneY },
      style: {
        width: LEAF_W, padding: '6px 8px', borderRadius: 4, fontSize: 9,
        backgroundColor: st.bg, border: `1px solid ${st.border}`,
      },
      data: {
        topo: z,
        label: (
          <div style={{ fontSize: 9, fontWeight: 600, color: tokens.colorBrandForeground1 }} title={z.name}>
            {st.icon} {z.name.replace('privatelink.', '')}
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
          minZoom={0.1}
          attributionPosition="bottom-left"
        >
          <Background variant={BackgroundVariant.Lines} gap={16} size={1} />
          <Controls showInteractive={false} />
          <Panel position="top-left">
            <div className={styles.legend} aria-label="Topology legend">
              {NODE_LEGEND.map((k) => (
                <span key={k} className={styles.legendItem}>
                  <span className={styles.legendSwatch} style={{ backgroundColor: KIND_STYLE[k].bg, border: `2px solid ${KIND_STYLE[k].border}` }} />
                  {KIND_STYLE[k].label}
                </span>
              ))}
            </div>
          </Panel>
          <MiniMap
            position="bottom-right" pannable zoomable
            nodeColor={(n) => {
              const k = (n.data as { topo?: TopoNode } | undefined)?.topo?.kind;
              return k ? KIND_STYLE[k].border : tokens.colorNeutralStroke2;
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
