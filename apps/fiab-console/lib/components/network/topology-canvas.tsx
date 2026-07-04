'use client';

/**
 * NetworkTopologyCanvas — visual representation of the CSA Loom network, rendered
 * from the REAL deployed network read over ARM (no mocks, no sample data).
 *
 * Renders a read-only React Flow graph showing:
 *   • Virtual networks (parent containers) with address space labels
 *   • Subnets (nested nodes) with CIDR prefix + per-subnet PE count + NSG badge
 *   • Network security groups (firewall boundary nodes) wired to their subnet(s)
 *   • Private endpoints (leaf nodes) colored by service type, wired to the
 *     ACTUAL subnet their NIC lives in (properties.subnet.id), not VNet[0]
 *   • Private DNS zones (info nodes) wired to the endpoints that register in them
 *
 * Every node is clickable — selecting one opens a Fluent OverlayDrawer with that
 * resource's real ARM detail (CIDRs, delegations, NSG rule table, PE FQDN→IP→zone).
 * This mirrors the Azure portal "Network → Topology" + resource-detail blades,
 * read-only first per the task scope.
 *
 * Uses @xyflow/react v12.10.2 (already in use for ADF/Synapse pipelines
 * and deploy-planner canvases). Color scheme follows Fluent tokens + CSA Loom
 * service categories (Synapse, Storage, SQL, Databricks, etc.).
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  makeStyles, tokens,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Button,
  Badge, Body1, Body1Strong, Caption1, Subtitle2, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import {
  Dismiss24Regular,
  VirtualNetwork20Regular, Subtract20Regular, Shield20Regular,
  GlobeShield20Regular, LockClosed20Regular, Cloud20Regular, Database20Regular,
  Flash20Regular, Server20Regular, Stream20Regular, Cube20Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import type {
  PrivateEndpointInfo, VNetInfo, SubnetInfo, NsgInfo, NsgRule, PrivateDnsZoneInfo,
} from '@/lib/azure/network-discovery';

/**
 * Service-type visual mapping — theme-aware `--loom-accent-*` var + Fluent glyph.
 * Replaces the old hex-bg/border + emoji-icon map; light + dark resolve through
 * the accent CSS vars (defined under both selectors in app/globals.css).
 */
const SERVICE_VISUAL: Record<string, { accent: string; Icon: FluentIcon }> = {
  synapse: { accent: 'var(--loom-accent-blue)', Icon: Flash20Regular },
  storage: { accent: 'var(--loom-accent-cyan)', Icon: Cloud20Regular },
  sql: { accent: 'var(--loom-accent-violet)', Icon: Database20Regular },
  databricks: { accent: 'var(--loom-accent-red)', Icon: Server20Regular },
  keyvault: { accent: 'var(--loom-accent-amber)', Icon: LockClosed20Regular },
  eventgrid: { accent: 'var(--loom-accent-green)', Icon: Stream20Regular },
  other: { accent: 'var(--loom-accent-teal)', Icon: Cube20Regular },
};

function colorForService(groupIds?: string[]): typeof SERVICE_VISUAL['other'] {
  const firstGroup = (groupIds?.[0] ?? '').toLowerCase();
  if (firstGroup.includes('synapse') || firstGroup === 'dev') return SERVICE_VISUAL.synapse;
  if (firstGroup.includes('blob') || firstGroup.includes('file')) return SERVICE_VISUAL.storage;
  if (firstGroup.includes('sql')) return SERVICE_VISUAL.sql;
  if (firstGroup.includes('databricks')) return SERVICE_VISUAL.databricks;
  if (firstGroup.includes('vault')) return SERVICE_VISUAL.keyvault;
  if (firstGroup.includes('eventgrid')) return SERVICE_VISUAL.eventgrid;
  return SERVICE_VISUAL.other;
}

// Node-kind accents (theme-aware --loom-accent-* vars; see app/globals.css).
const VNET_ACCENT = 'var(--loom-accent-blue)';
const SUBNET_ACCENT = 'var(--loom-accent-teal)';
const NSG_ACCENT = 'var(--loom-accent-amber)';
const ZONE_ACCENT = 'var(--loom-accent-azure)';

/** Discriminated detail attached to each node — read in the drawer. */
type NodeDetail =
  | { kind: 'vnet'; vnet: VNetInfo }
  | { kind: 'subnet'; subnet: SubnetInfo; vnetName: string; peCount: number; nsgName?: string }
  | { kind: 'nsg'; nsg: NsgInfo }
  | { kind: 'pe'; pe: PrivateEndpointInfo }
  | { kind: 'zone'; zone: string; fqdns: { fqdn: string; ips: string[] }[] };

interface TopologyData {
  endpoints: PrivateEndpointInfo[];
  vnets: VNetInfo[];
  nsgs?: NsgInfo[];
  zones: string[];
  /** Private DNS zones + their authoritative A-records. When present, the zone
   * drawer prefers these records (some zones carry A-records whose IP the PE's
   * customDnsConfigs never echoes), unioning them with PE-derived records. */
  dnsZones?: PrivateDnsZoneInfo[];
}

interface TopologyCanvasProps {
  data: TopologyData;
  compact?: boolean;
}

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '520px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
  },
  detailRow: { marginBottom: '10px' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: '12px', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: '14px',
    rowGap: '6px',
    maxWidth: '420px',
    padding: '8px 10px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow8,
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  legendSwatch: {
    width: '14px',
    height: '14px',
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    textAlign: 'center',
    padding: '24px',
  },
});

/** Legend rows — node kinds + the service-color key, derived from SERVICE_VISUAL. */
const NODE_LEGEND: { label: string; accent: string; Icon: FluentIcon }[] = [
  { label: 'Virtual network', accent: VNET_ACCENT, Icon: VirtualNetwork20Regular },
  { label: 'Subnet', accent: SUBNET_ACCENT, Icon: Subtract20Regular },
  { label: 'Network security group', accent: NSG_ACCENT, Icon: Shield20Regular },
  { label: 'Private DNS zone', accent: ZONE_ACCENT, Icon: GlobeShield20Regular },
];
const SERVICE_LEGEND: { label: string; key: keyof typeof SERVICE_VISUAL }[] = [
  { label: 'Synapse', key: 'synapse' },
  { label: 'Storage', key: 'storage' },
  { label: 'SQL', key: 'sql' },
  { label: 'Databricks', key: 'databricks' },
  { label: 'Key Vault', key: 'keyvault' },
  { label: 'Event Grid', key: 'eventgrid' },
];

/**
 * Build React Flow nodes + edges from the real ARM data.
 * Layout: vNets at top, subnets nested inside, NSGs in a band below the VNets,
 * PEs as leaves wired to their actual subnet, DNS zones floating at the bottom.
 */
function buildTopology(data: TopologyData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nsgs = data.nsgs || [];

  // ARM-id → node-id maps so edges key on REAL connectivity, not array position.
  const subnetNodeIdByArmId = new Map<string, string>();
  const nsgNodeIdByArmId = new Map<string, string>();

  // PE count per subnet ARM id (real: keyed on the PE's properties.subnet.id).
  const peCountBySubnetArmId = new Map<string, number>();
  for (const pe of data.endpoints) {
    if (!pe.subnetId) continue;
    peCountBySubnetArmId.set(pe.subnetId, (peCountBySubnetArmId.get(pe.subnetId) || 0) + 1);
  }

  const vnetsByRegion = new Map<string, VNetInfo[]>();
  for (const vnet of data.vnets) {
    const region = vnet.resourceGroup || 'unknown';
    if (!vnetsByRegion.has(region)) vnetsByRegion.set(region, []);
    vnetsByRegion.get(region)!.push(vnet);
  }

  let vnetX = 0;
  let maxVnetHeight = 0;

  for (const [, vnets] of vnetsByRegion) {
    let vnetY = 0;
    for (const vnet of vnets) {
      const vnetId = `vnet-${vnet.id}`;
      const addressSpace = (vnet.addressPrefixes || []).join(', ') || '(no prefix)';
      const subnets = vnet.subnets || [];
      const estimatedSubnetHeight = subnets.length * 60 + 40;
      const vnetHeight = Math.max(120, estimatedSubnetHeight);

      nodes.push({
        id: vnetId,
        type: 'default',
        position: { x: vnetX, y: vnetY },
        style: {
          padding: tokens.spacingHorizontalM,
          borderRadius: tokens.borderRadiusLarge,
          background: accentTint(VNET_ACCENT, 5),
          border: `1.5px solid ${accentTint(VNET_ACCENT, 40)}`,
          width: '280px',
          height: `${vnetHeight}px`,
          minWidth: '160px',
          boxShadow: tokens.shadow4,
        },
        data: {
          detail: { kind: 'vnet', vnet } as NodeDetail,
          label: (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS }}>
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22, borderRadius: tokens.borderRadiusMedium,
                    background: accentTint(VNET_ACCENT, 14), color: VNET_ACCENT, flexShrink: 0,
                  }}
                  aria-hidden="true"
                >
                  <VirtualNetwork20Regular style={{ width: 16, height: 16 }} />
                </span>
                <span style={{ fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200 }}>
                  {vnet.name || 'vNet'}
                </span>
              </div>
              <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
                {addressSpace}
              </div>
            </div>
          ),
        },
      });

      let subnetY = 32;
      for (const subnet of subnets) {
        const subnetId = `subnet-${vnet.id}-${subnet.name}`;
        if (subnet.id) subnetNodeIdByArmId.set(subnet.id, subnetId);
        // Real per-subnet PE count (PE.subnetId === subnet ARM id). Falls back to
        // the subnet's own privateEndpoints[] count from the VNet payload.
        const peCount = (subnet.id && peCountBySubnetArmId.get(subnet.id))
          || subnet.privateEndpointCount || 0;
        const nsgName = subnet.nsgId ? subnet.nsgId.split('/').pop() : undefined;

        nodes.push({
          id: subnetId,
          type: 'default',
          parentId: vnetId,
          extent: 'parent' as const,
          position: { x: 8, y: subnetY },
          style: {
            padding: tokens.spacingHorizontalS,
            borderRadius: tokens.borderRadiusMedium,
            background: accentTint(SUBNET_ACCENT, 4),
            border: `1px dashed ${accentTint(SUBNET_ACCENT, 40)}`,
            fontSize: tokens.fontSizeBase100,
            width: 'calc(100% - 16px)',
            minWidth: '120px',
          },
          data: {
            detail: { kind: 'subnet', subnet, vnetName: vnet.name, peCount, nsgName } as NodeDetail,
            label: (
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 20, height: 20, borderRadius: tokens.borderRadiusSmall,
                    background: accentTint(SUBNET_ACCENT, 14), color: SUBNET_ACCENT, flexShrink: 0,
                  }}
                  aria-hidden="true"
                >
                  <Subtract20Regular style={{ width: 16, height: 16 }} />
                </span>
                <span style={{ fontWeight: tokens.fontWeightSemibold }}>{subnet.name}</span>
                <span style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
                  {subnet.addressPrefix}
                </span>
                {peCount > 0 && (
                  <Badge
                    appearance="tint"
                    size="small"
                    style={{ backgroundColor: accentTint(SUBNET_ACCENT, 16), color: SUBNET_ACCENT }}
                  >
                    {peCount} PE
                  </Badge>
                )}
                {nsgName && (
                  <Badge
                    appearance="tint"
                    size="small"
                    style={{ backgroundColor: accentTint(NSG_ACCENT, 16), color: NSG_ACCENT }}
                  >
                    NSG
                  </Badge>
                )}
              </div>
            ),
          },
        });

        edges.push({
          id: `vnet-subnet-${vnet.id}-${subnet.name}`,
          source: vnetId,
          target: subnetId,
          style: { stroke: tokens.colorNeutralStroke2, strokeDasharray: '3,3' },
          animated: false,
        });

        subnetY += 60;
      }

      maxVnetHeight = Math.max(maxVnetHeight, vnetHeight);
      vnetY += vnetHeight + 40;
    }

    vnetX += 320;
  }

  // ── NSG nodes (security boundary) — wired to the subnet(s) they protect ──
  let nsgX = 0;
  const nsgY = maxVnetHeight + 60;
  for (const nsg of nsgs) {
    const nsgNodeId = `nsg-${nsg.id}`;
    nsgNodeIdByArmId.set(nsg.id, nsgNodeId);
    const denyCount = nsg.rules.filter((r) => r.access === 'Deny').length;
    nodes.push({
      id: nsgNodeId,
      type: 'default',
      position: { x: nsgX, y: nsgY },
      style: {
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        fontSize: tokens.fontSizeBase100,
        textAlign: 'center',
        background: accentTint(NSG_ACCENT, 6),
        border: `2px solid ${NSG_ACCENT}`,
        minWidth: '120px',
        boxShadow: tokens.shadow4,
      },
      data: {
        detail: { kind: 'nsg', nsg } as NodeDetail,
        label: (
          <div style={{ lineHeight: 1.3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS }} title={nsg.name}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: tokens.borderRadiusMedium,
                background: accentTint(NSG_ACCENT, 14), color: NSG_ACCENT,
              }}
              aria-hidden="true"
            >
              <Shield20Regular style={{ width: 16, height: 16, color: NSG_ACCENT }} />
            </span>
            <div style={{ fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold }}>
              {nsg.name.length > 16 ? `${nsg.name.slice(0, 14)}…` : nsg.name}
            </div>
            <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
              {nsg.rules.length} rules · {denyCount} deny
            </div>
          </div>
        ),
      },
    });

    // Edge: subnet → NSG (the subnet whose networkSecurityGroup.id is this NSG),
    // plus the NSG's own properties.subnets[] (covers either discovery direction).
    const linkedSubnetNodeIds = new Set<string>();
    for (const armId of nsg.subnetIds) {
      const sn = subnetNodeIdByArmId.get(armId);
      if (sn) linkedSubnetNodeIds.add(sn);
    }
    for (const v of data.vnets) {
      for (const sn of v.subnets) {
        if (sn.nsgId === nsg.id && sn.id) {
          const node = subnetNodeIdByArmId.get(sn.id);
          if (node) linkedSubnetNodeIds.add(node);
        }
      }
    }
    for (const snNode of linkedSubnetNodeIds) {
      edges.push({
        id: `subnet-nsg-${snNode}-${nsg.id}`,
        source: snNode,
        target: nsgNodeId,
        style: { stroke: NSG_ACCENT, strokeWidth: 1.25 },
        animated: false,
      });
    }

    nsgX += 150;
  }

  // ── Private-endpoint leaves — wired to their ACTUAL subnet ──
  let peX = 0;
  const peY = nsgY + 120;
  const processedPes = new Set<string>();

  for (const pe of data.endpoints) {
    if (processedPes.has(pe.id)) continue;
    processedPes.add(pe.id);

    const peId = `pe-${pe.id}`;
    const v = colorForService(pe.groupIds);
    const serviceLabel = pe.connectedResourceName || pe.name;

    nodes.push({
      id: peId,
      type: 'default',
      position: { x: peX, y: peY },
      style: {
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        fontSize: tokens.fontSizeBase100,
        fontWeight: tokens.fontWeightSemibold,
        textAlign: 'center',
        background: accentTint(v.accent, 6),
        border: `2px solid ${v.accent}`,
        minWidth: '90px',
        boxShadow: tokens.shadow4,
      },
      data: {
        detail: { kind: 'pe', pe } as NodeDetail,
        label: (
          <div style={{ lineHeight: 1.3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS }} title={serviceLabel}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: tokens.borderRadiusMedium,
                background: accentTint(v.accent, 14), color: v.accent,
              }}
              aria-hidden="true"
            >
              <v.Icon style={{ width: 16, height: 16, color: v.accent }} />
            </span>
            <div style={{ fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold }}>
              {serviceLabel.length > 12
                ? `${serviceLabel.slice(0, 10)}...`
                : serviceLabel}
            </div>
            {pe.loomDomain && (
              <Badge
                appearance="tint"
                size="small"
                title={pe.loomDomain}
                style={{
                  backgroundColor: accentTint(v.accent, 16),
                  color: v.accent,
                  maxWidth: '80px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'inline-block',
                }}
              >
                {pe.loomDomain}
              </Badge>
            )}
          </div>
        ),
      },
    });

    // Source the edge from the REAL subnet the PE lives in; fall back to the
    // first VNet only when the subnet id couldn't be resolved.
    const subnetNode = pe.subnetId ? subnetNodeIdByArmId.get(pe.subnetId) : undefined;
    const source = subnetNode || (data.vnets.length > 0 ? `vnet-${data.vnets[0].id}` : undefined);
    if (source) {
      edges.push({
        id: `link-pe-${pe.id}`,
        source,
        target: peId,
        style: { stroke: v.accent, strokeWidth: 1.5 },
        animated: false,
      });
    }

    peX += 120;
  }

  // ── Private DNS zones ──
  let zoneX = 0;
  const zoneY = peY + 110;

  // Authoritative A-records per zone (some zones hold records whose IP the PE's
  // customDnsConfigs never echoes). Keyed by zone name for union with PE records.
  const zoneRecordsByZone = new Map<string, { fqdn: string; ips: string[] }[]>();
  for (const z of data.dnsZones || []) {
    zoneRecordsByZone.set(z.name, (z.records || []).map((r) => ({ fqdn: r.fqdn, ips: r.ips })));
  }

  for (const zone of data.zones.slice(0, 12)) {
    const zoneId = `zone-${zone}`;
    // Union the authoritative zone A-records with the PE-derived records,
    // de-duplicating on FQDN (zone record wins — it is the source of truth).
    const byFqdn = new Map<string, { fqdn: string; ips: string[] }>();
    for (const r of zoneRecordsByZone.get(zone) || []) {
      if (r.fqdn) byFqdn.set(r.fqdn, { fqdn: r.fqdn, ips: r.ips });
    }
    for (const pe of data.endpoints) {
      for (const d of pe.dns) {
        if (d.zone === zone && d.fqdn && !byFqdn.has(d.fqdn)) {
          byFqdn.set(d.fqdn, { fqdn: d.fqdn, ips: d.ips });
        }
      }
    }
    const fqdns: { fqdn: string; ips: string[] }[] = [...byFqdn.values()];
    nodes.push({
      id: zoneId,
      type: 'default',
      position: { x: zoneX, y: zoneY },
      style: {
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        background: accentTint(ZONE_ACCENT, 5),
        border: `1px solid ${accentTint(ZONE_ACCENT, 40)}`,
        fontSize: tokens.fontSizeBase100,
        width: '130px',
        boxShadow: tokens.shadow4,
      },
      data: {
        detail: { kind: 'zone', zone, fqdns } as NodeDetail,
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 20, height: 20, borderRadius: tokens.borderRadiusSmall,
                background: accentTint(ZONE_ACCENT, 14), color: ZONE_ACCENT, flexShrink: 0,
              }}
              aria-hidden="true"
            >
              <GlobeShield20Regular style={{ width: 16, height: 16 }} />
            </span>
            <span style={{ fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold, color: ZONE_ACCENT, overflowWrap: 'anywhere' }}>
              {zone.replace('privatelink.', '')}
            </span>
          </div>
        ),
      },
    });

    for (const pe of data.endpoints) {
      const peZones = new Set(pe.dns.map((d) => d.zone));
      if (peZones.has(zone)) {
        edges.push({
          id: `pe-zone-${pe.id}-${zone}`,
          source: `pe-${pe.id}`,
          target: zoneId,
          style: { stroke: tokens.colorNeutralStroke3, strokeDasharray: '5,5' },
          animated: false,
        });
      }
    }

    zoneX += 150;
  }

  return { nodes, edges };
}

/** Inbound/Outbound NSG-rule grid — mirrors the Azure "security rules" blade. */
function NsgRuleTable({ rules }: { rules: NsgRule[] }): React.ReactElement {
  if (!rules.length) return <Caption1>No security rules.</Caption1>;
  return (
    <Table size="small" aria-label="NSG security rules">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Pri</TableHeaderCell>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Dir</TableHeaderCell>
          <TableHeaderCell>Access</TableHeaderCell>
          <TableHeaderCell>Proto</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Dest</TableHeaderCell>
          <TableHeaderCell>Port</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r, i) => (
          <TableRow key={`${r.name}-${r.direction}-${i}`}>
            <TableCell>{r.priority}</TableCell>
            <TableCell>{r.name}</TableCell>
            <TableCell>{r.direction}</TableCell>
            <TableCell>
              <Badge appearance="tint" color={r.access === 'Allow' ? 'success' : 'danger'}>
                {r.access}
              </Badge>
            </TableCell>
            <TableCell>{r.protocol}</TableCell>
            <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100 }}>{r.sourcePrefix}</TableCell>
            <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100 }}>{r.destPrefix}</TableCell>
            <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100 }}>{r.destPort}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Renders the real ARM detail for the selected topology node. */
function DetailBody({ detail }: { detail: NodeDetail }): React.ReactElement {
  const styles = useStyles();
  if (detail.kind === 'vnet') {
    const v = detail.vnet;
    return (
      <div>
        <div className={styles.detailRow}><Body1Strong>Address space</Body1Strong><br />
          <span className={styles.mono}>{v.addressPrefixes.join(', ') || '—'}</span></div>
        <div className={styles.detailRow}><Body1Strong>Resource group</Body1Strong><br />
          <span className={styles.mono}>{v.resourceGroup || '—'}</span></div>
        <Divider style={{ margin: '12px 0' }} />
        <Subtitle2>Subnets ({v.subnets.length})</Subtitle2>
        <Table size="small" aria-label="Subnets" style={{ marginTop: tokens.spacingVerticalS }}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Subnet</TableHeaderCell>
              <TableHeaderCell>Prefix</TableHeaderCell>
              <TableHeaderCell>PEs</TableHeaderCell>
              <TableHeaderCell>NSG</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.subnets.map((sn) => (
              <TableRow key={sn.name}>
                <TableCell>{sn.name}</TableCell>
                <TableCell className={styles.mono}>{sn.addressPrefix || '—'}</TableCell>
                <TableCell>{sn.privateEndpointCount || 0}</TableCell>
                <TableCell>{sn.nsgId ? sn.nsgId.split('/').pop() : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  if (detail.kind === 'subnet') {
    const s = detail.subnet;
    return (
      <div>
        <div className={styles.detailRow}><Body1Strong>Virtual network</Body1Strong><br />{detail.vnetName}</div>
        <div className={styles.detailRow}><Body1Strong>Address prefix</Body1Strong><br />
          <span className={styles.mono}>{s.addressPrefix || '—'}</span></div>
        <div className={styles.detailRow}><Body1Strong>Private endpoints</Body1Strong><br />{detail.peCount}</div>
        <div className={styles.detailRow}><Body1Strong>Delegations</Body1Strong><br />
          {s.delegations.length ? s.delegations.join(', ') : '—'}</div>
        <div className={styles.detailRow}><Body1Strong>Network security group</Body1Strong><br />
          {detail.nsgName || 'None attached'}</div>
      </div>
    );
  }
  if (detail.kind === 'nsg') {
    const n = detail.nsg;
    return (
      <div>
        <div className={styles.detailRow}><Body1Strong>Resource group</Body1Strong><br />
          <span className={styles.mono}>{n.resourceGroup || '—'}</span></div>
        <div className={styles.detailRow}><Body1Strong>Attached subnets</Body1Strong><br />
          {n.subnetIds.length ? n.subnetIds.map((s) => s.split('/').pop()).join(', ') : '—'}</div>
        <Divider style={{ margin: '12px 0' }} />
        <Subtitle2>Security rules ({n.rules.length})</Subtitle2>
        <div style={{ marginTop: tokens.spacingVerticalS }}><NsgRuleTable rules={n.rules} /></div>
      </div>
    );
  }
  if (detail.kind === 'pe') {
    const pe = detail.pe;
    return (
      <div>
        <div className={styles.detailRow}><Body1Strong>Connected resource</Body1Strong><br />
          {pe.connectedResourceName || '—'}</div>
        {pe.connectedResourceType && (
          <div className={styles.detailRow}><Body1Strong>Resource type</Body1Strong><br />
            <span className={styles.mono}>{pe.connectedResourceType}</span></div>
        )}
        <div className={styles.detailRow}><Body1Strong>Loom domain</Body1Strong><br />
          {pe.loomDomain
            ? <Badge appearance="tint" color="brand">{pe.loomDomain}</Badge>
            : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Shared / admin plane (untagged)</Caption1>}</div>
        <div className={styles.detailRow}><Body1Strong>Sub-resource</Body1Strong><br />
          {pe.groupIds.join(', ') || '—'}</div>
        <div className={styles.detailRow}><Body1Strong>Subnet</Body1Strong><br />
          {pe.subnetName || '—'}</div>
        <div className={styles.detailRow}><Body1Strong>State</Body1Strong><br />
          <Badge appearance="tint" color={pe.state === 'Approved' || pe.state === 'Succeeded' ? 'success' : 'warning'}>
            {pe.state || '—'}
          </Badge></div>
        <Divider style={{ margin: '12px 0' }} />
        <Subtitle2>FQDN → private IP → zone</Subtitle2>
        <Table size="small" aria-label="PE DNS" style={{ marginTop: tokens.spacingVerticalS }}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>FQDN</TableHeaderCell>
              <TableHeaderCell>IP</TableHeaderCell>
              <TableHeaderCell>Zone</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(pe.dns.length ? pe.dns : [{ fqdn: '(no DNS config)', ips: [], zone: '' }]).map((d, i) => (
              <TableRow key={`${d.fqdn}-${i}`}>
                <TableCell className={styles.mono}>{d.fqdn}</TableCell>
                <TableCell className={styles.mono}>{d.ips.join(', ') || '—'}</TableCell>
                <TableCell className={styles.mono}>{d.zone || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  // zone
  return (
    <div>
      <div className={styles.detailRow}><Body1Strong>Private DNS zone</Body1Strong><br />
        <span className={styles.mono}>{detail.zone}</span></div>
      <Divider style={{ margin: '12px 0' }} />
      <Subtitle2>Registered records ({detail.fqdns.length})</Subtitle2>
      {detail.fqdns.length ? (
        <Table size="small" aria-label="Zone records" style={{ marginTop: tokens.spacingVerticalS }}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>FQDN</TableHeaderCell>
              <TableHeaderCell>IP</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.fqdns.map((f, i) => (
              <TableRow key={`${f.fqdn}-${i}`}>
                <TableCell className={styles.mono}>{f.fqdn}</TableCell>
                <TableCell className={styles.mono}>{f.ips.join(', ') || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS }}>No endpoints register in this zone yet.</Caption1>}
    </div>
  );
}

function detailTitle(detail: NodeDetail): string {
  switch (detail.kind) {
    case 'vnet': return detail.vnet.name || 'Virtual network';
    case 'subnet': return detail.subnet.name || 'Subnet';
    case 'nsg': return detail.nsg.name || 'Network security group';
    case 'pe': return detail.pe.connectedResourceName || detail.pe.name || 'Private endpoint';
    case 'zone': return detail.zone;
  }
}

export function NetworkTopologyCanvas(props: TopologyCanvasProps): React.ReactElement {
  const { data } = props;
  const styles = useStyles();
  const [selected, setSelected] = useState<NodeDetail | null>(null);

  const { nodes, edges } = useMemo(
    () => buildTopology(data),
    [data],
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const detail = (node.data as { detail?: NodeDetail } | undefined)?.detail;
    if (detail) setSelected(detail);
  }, []);

  if (nodes.length === 0) {
    return (
      <div className={styles.shell}>
        <div className={styles.empty}>
          <Subtitle2>No network resources to map</Subtitle2>
          <Body1 style={{ color: tokens.colorNeutralForeground3, maxWidth: 360 }}>
            No virtual networks or private endpoints were returned for the readable subscription(s).
            Once the network bicep module provisions the hub VNet and private endpoints, the live
            topology renders here.
          </Body1>
        </div>
      </div>
    );
  }

  return (
    // Drag-to-resize canvas height via the shared Web-5.0 primitive (pointer +
    // keyboard + per-surface localStorage, bounded 360px–80vh). The shell keeps
    // height:100% and resolves against the region; minHeight is overridden to 0
    // here so the region's bounds win (the shared style's 520px floor stays for
    // the empty-state return above, which is not wrapped).
    <ResizableCanvasRegion
      storageKey="network-topology"
      defaultPx={560}
      minPx={360}
      ariaLabel="Resize network topology canvas height"
    >
    <div className={styles.shell} style={{ minHeight: 0 }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          fitView
          attributionPosition="bottom-left"
        >
          <Background variant={BackgroundVariant.Lines} gap={16} size={2} />
          <Controls showInteractive={false} />
          <Panel position="top-left">
            <div className={styles.legend} aria-label="Topology legend">
              {NODE_LEGEND.map((n) => (
                <span key={n.label} className={styles.legendItem}>
                  <span
                    className={styles.legendSwatch}
                    style={{ background: accentTint(n.accent, 16), border: `2px solid ${n.accent}`, color: n.accent }}
                  >
                    <n.Icon style={{ width: 10, height: 10 }} />
                  </span>
                  {n.label}
                </span>
              ))}
              {SERVICE_LEGEND.map((s) => {
                const sv = SERVICE_VISUAL[s.key];
                return (
                  <span key={s.label} className={styles.legendItem}>
                    <span
                      className={styles.legendSwatch}
                      style={{ background: accentTint(sv.accent, 16), border: `2px solid ${sv.accent}`, color: sv.accent }}
                    >
                      <sv.Icon style={{ width: 10, height: 10 }} />
                    </span>
                    {s.label}
                  </span>
                );
              })}
            </div>
          </Panel>
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            style={{
              backgroundColor: tokens.colorNeutralBackground2,
              border: `1px solid ${tokens.colorNeutralStroke2}`,
            }}
          />
        </ReactFlow>
      </ReactFlowProvider>

      <OverlayDrawer
        position="end"
        open={selected != null}
        onOpenChange={(_, d) => { if (!d.open) setSelected(null); }}
        size="medium"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<Dismiss24Regular />}
                onClick={() => setSelected(null)}
              />
            }
          >
            {selected ? detailTitle(selected) : ''}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {selected ? <DetailBody detail={selected} /> : <Body1>Select a node.</Body1>}
        </DrawerBody>
      </OverlayDrawer>
    </div>
    </ResizableCanvasRegion>
  );
}

export default NetworkTopologyCanvas;
