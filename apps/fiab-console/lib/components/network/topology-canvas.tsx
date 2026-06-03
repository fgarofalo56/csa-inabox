'use client';

/**
 * NetworkTopologyCanvas — visual representation of the CSA Loom network.
 *
 * Renders a read-only React Flow graph showing:
 *   • Virtual networks (parent containers) with address space labels
 *   • Subnets (nested nodes) with CIDR prefix + PE count badges
 *   • Private endpoints (leaf nodes) colored by service type
 *   • Private DNS zones (info nodes)
 *   • VNet-to-PE-to-Service/Zone relationships via edges
 *
 * Uses @xyflow/react v12.10.2 (already in use for ADF/Synapse pipelines
 * and deploy-planner canvases). Color scheme follows Fluent tokens + CSA Loom
 * service categories (Synapse, Storage, SQL, Databricks, etc.).
 */

import React, { useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { makeStyles, tokens } from '@fluentui/react-components';
import type { PrivateEndpointInfo, VNetInfo } from '@/lib/azure/network-discovery';

/**
 * Service type color mapping — matches Fluent color tokens + CSA service categories.
 */
const SERVICE_COLORS: Record<string, { bg: string; border: string; icon: string }> = {
  synapse: { bg: '#EFF6FC', border: tokens.colorBrandForeground1, icon: '⚡' },
  storage: { bg: '#F0F5FD', border: '#1570EF', icon: '📦' },
  sql: { bg: '#F0E8FF', border: '#7C3AED', icon: '🗄️' },
  databricks: { bg: '#FEF3E2', border: '#D97706', icon: '📊' },
  keyvault: { bg: '#FEF2F2', border: '#DC2626', icon: '🔐' },
  eventgrid: { bg: '#F0FDF4', border: '#16A34A', icon: '📨' },
  other: { bg: '#F5F5F5', border: tokens.colorNeutralStroke2, icon: '🔗' },
};

function colorForService(groupIds?: string[]): typeof SERVICE_COLORS['other'] {
  const firstGroup = (groupIds?.[0] ?? '').toLowerCase();
  if (firstGroup.includes('synapse') || firstGroup === 'dev') return SERVICE_COLORS.synapse;
  if (firstGroup.includes('blob') || firstGroup.includes('file')) return SERVICE_COLORS.storage;
  if (firstGroup.includes('sql')) return SERVICE_COLORS.sql;
  if (firstGroup.includes('databricks')) return SERVICE_COLORS.databricks;
  if (firstGroup.includes('vault')) return SERVICE_COLORS.keyvault;
  if (firstGroup.includes('eventgrid')) return SERVICE_COLORS.eventgrid;
  return SERVICE_COLORS.other;
}

interface TopologyData {
  endpoints: PrivateEndpointInfo[];
  vnets: VNetInfo[];
  zones: string[];
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
    minHeight: '480px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
  },
});

/**
 * Build React Flow nodes + edges from endpoint + vNet data.
 * Layout: vNets at top (by region), subnets nested inside, PEs as leaves,
 * DNS zones floating below.
 */
function buildTopology(data: TopologyData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

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
          padding: '12px',
          borderRadius: '6px',
          backgroundColor: '#F5F5F5',
          border: `2px solid ${tokens.colorBrandBackground}`,
          width: '280px',
          height: `${vnetHeight}px`,
          minWidth: '160px',
        },
        data: {
          label: (
            <div>
              <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '4px' }}>
                {vnet.name || 'vNet'}
              </div>
              <div style={{ fontSize: '10px', color: tokens.colorNeutralForeground3 }}>
                {addressSpace}
              </div>
            </div>
          ),
        },
      });

      let subnetY = 32;
      for (const subnet of subnets) {
        const subnetId = `subnet-${vnet.id}-${subnet.name}`;
        const peCount = data.endpoints.filter(
          (ep) => ep.nicIps && ep.nicIps.length > 0,
        ).length;

        nodes.push({
          id: subnetId,
          type: 'default',
          parentId: vnetId,
          extent: 'parent' as const,
          position: { x: 8, y: subnetY },
          style: {
            padding: '8px',
            borderRadius: '4px',
            backgroundColor: '#FAFAFA',
            border: `1px dashed ${tokens.colorNeutralStroke2}`,
            fontSize: '11px',
            width: 'calc(100% - 16px)',
            minWidth: '120px',
          },
          data: {
            label: (
              <div>
                <span style={{ fontWeight: 600 }}>{subnet.name}</span>
                <span style={{ fontSize: '9px', color: tokens.colorNeutralForeground3 }}>
                  {' '}{subnet.addressPrefix}
                </span>
                {peCount > 0 && (
                  <span
                    style={{
                      marginLeft: '4px',
                      fontSize: '8px',
                      backgroundColor: tokens.colorBrandBackground,
                      color: '#FFF',
                      padding: '1px 4px',
                      borderRadius: '3px',
                    }}
                  >
                    {peCount} PE
                  </span>
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

  let peX = 0;
  let peY = maxVnetHeight + 80;
  const processedPes = new Set<string>();

  for (const pe of data.endpoints) {
    if (processedPes.has(pe.id)) continue;
    processedPes.add(pe.id);

    const peId = `pe-${pe.id}`;
    const color = colorForService(pe.groupIds);
    const serviceLabel = pe.connectedResourceName || pe.name;

    nodes.push({
      id: peId,
      type: 'default',
      position: { x: peX, y: peY },
      style: {
        padding: '6px 8px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 600,
        textAlign: 'center',
        backgroundColor: color.bg,
        border: `2px solid ${color.border}`,
        minWidth: '90px',
      },
      data: {
        label: (
          <div style={{ lineHeight: 1.3 }}>
            <div>{color.icon}</div>
            <div style={{ fontSize: '8px', fontWeight: 600 }}>
              {serviceLabel.length > 12
                ? `${serviceLabel.slice(0, 10)}...`
                : serviceLabel}
            </div>
          </div>
        ),
      },
    });

    if (data.vnets.length > 0) {
      edges.push({
        id: `vnet-pe-${pe.id}`,
        source: `vnet-${data.vnets[0].id}`,
        target: peId,
        style: { stroke: color.border, strokeWidth: 1.5 },
        animated: false,
      });
    }

    peX += 120;
  }

  let zoneX = 0;
  const zoneY = peY + 100;

  for (const zone of data.zones.slice(0, 10)) {
    const zoneId = `zone-${zone}`;
    nodes.push({
      id: zoneId,
      type: 'default',
      position: { x: zoneX, y: zoneY },
      style: {
        padding: '6px 8px',
        borderRadius: '4px',
        backgroundColor: '#F0F9FF',
        border: `1px solid ${tokens.colorBrandBackground2}`,
        fontSize: '10px',
        width: '120px',
      },
      data: {
        label: (
          <div style={{ fontSize: '9px', fontWeight: 600, color: tokens.colorBrandForeground1 }}>
            {zone.replace('privatelink.', '')}
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

    zoneX += 140;
  }

  return { nodes, edges };
}

export function NetworkTopologyCanvas(props: TopologyCanvasProps): React.ReactElement {
  const { data } = props;
  const styles = useStyles();

  const { nodes, edges } = useMemo(
    () => buildTopology(data),
    [data],
  );

  return (
    <div className={styles.shell}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          attributionPosition="bottom-left"
        >
          <Background variant={BackgroundVariant.Lines} gap={16} size={2} />
          <Controls showInteractive={false} />
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
    </div>
  );
}

export default NetworkTopologyCanvas;
