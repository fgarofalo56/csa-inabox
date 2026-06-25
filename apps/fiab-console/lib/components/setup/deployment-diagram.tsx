'use client';

/**
 * SetupDeploymentDiagram — a read-only architecture preview of the planned
 * Data Landing Zone deployment, rendered on the Setup Wizard's Review step.
 *
 * It reuses the same React Flow engine as the Deployment Planner (T132) but is
 * intentionally NON-interactive: no palette, no drag, no Cosmos load. The node
 * graph is built purely from the wizard's in-memory state so the operator sees
 * exactly what the generated Bicep will provision before they click Deploy:
 *
 *   Admin Plane subscription (hub)
 *     └─ DLZ domain(s)
 *          └─ Azure-native service leaves (the F-SKU capacity equivalence +
 *             the core lakehouse services main.bicep actually deploys)
 *
 * single-sub  → one DLZ domain inside the admin/hub subscription.
 * multi-sub   → one spoke-subscription node per selected DLZ (wire-new), or per
 *               selected existing DLZ (wire-existing), each holding its domain.
 *
 * Per no-vaporware.md the diagram only shows services the deployment truly
 * stands up — it is a faithful preview, not an aspirational topology.
 */

import { useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls,
  type Node, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Caption1, tokens, makeStyles } from '@fluentui/react-components';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';

export interface DiagramSpoke {
  /** subscription id the DLZ lands in */
  subscriptionId?: string;
  subscriptionName?: string;
  domainName: string;
  region?: string;
}

export interface SetupDiagramProps {
  boundary?: string;
  mode?: 'single-sub' | 'multi-sub';
  /** Admin Plane (hub) subscription */
  adminSubscriptionId?: string;
  adminSubscriptionName?: string;
  region?: string;
  capacitySku?: string;
  /** The DLZ(s) being planned — one for single-sub, N for multi-sub. */
  spokes: DiagramSpoke[];
}

/** The Azure-native services main.bicep provisions in every DLZ (preview leaves). */
const DLZ_SERVICES: { type: string; label: string }[] = [
  { type: 'lakehouse', label: 'Lakehouse (ADLS + Delta)' },
  { type: 'warehouse', label: 'Synapse SQL' },
  { type: 'databricks-cluster', label: 'Databricks' },
  { type: 'kql-database', label: 'ADX (Kusto)' },
  { type: 'synapse-spark-pool', label: 'Synapse Spark' },
];

// layout constants (mirror the deploy-planner's containment metrics)
const SUB_W = 360, SUB_HEADER = 40, SUB_GAP = 36, SUB_BOTTOM = 16;
const DOMAIN_W = 320, DOMAIN_HEADER = 30, DOMAIN_PAD = 12;
const SVC_W = 150, SVC_H = 38, SVC_GAP_Y = 8;

function domainHeight(): number {
  return DOMAIN_HEADER + DOMAIN_PAD + DLZ_SERVICES.length * (SVC_H + SVC_GAP_Y) + DOMAIN_PAD;
}

interface SubData { name: string; boundary?: string; region?: string; role: string; [k: string]: unknown }
interface DomData { name: string; [k: string]: unknown }
interface SvcData { type: string; label: string; [k: string]: unknown }

/** Boundary → theme-aware accent var (cleared-boundary chrome of the subscription frame). */
const BOUNDARY_ACCENT: Record<string, string> = {
  Commercial: 'var(--loom-accent-blue)',
  GCC: 'var(--loom-accent-plum)',
  'GCC-High': 'var(--loom-accent-plum)',
  IL5: 'var(--loom-accent-red)',
  DoD: 'var(--loom-accent-red)',
};

/** DLZ service `type` → theme-aware accent var (per-service-family colour on the leaf cards). */
const SVC_ACCENT: Record<string, string> = {
  lakehouse: 'var(--loom-accent-blue)',
  warehouse: 'var(--loom-accent-green)',
  'databricks-cluster': 'var(--loom-accent-red)',
  'kql-database': 'var(--loom-accent-orange)',
  'synapse-spark-pool': 'var(--loom-accent-azure)',
};

function SubNode({ data, width, height, selected }: NodeProps) {
  const d = data as SubData;
  const accent = BOUNDARY_ACCENT[d.boundary || 'Commercial'] || 'var(--loom-accent-blue)';
  return (
    <div style={{
      width: width ?? SUB_W, height: height ?? 240, borderRadius: tokens.borderRadiusLarge,
      border: `2px solid ${selected ? tokens.colorBrandStroke1 : accent}`,
      background: accentTint(accent, 5), boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
        paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
        paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
        borderBottom: `1px solid ${accentTint(accent, 40)}`, background: accentGradient(accent),
        borderTopLeftRadius: tokens.borderRadiusLarge, borderTopRightRadius: tokens.borderRadiusLarge,
      }}>
        <span style={{ fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 }}>{d.name}</span>
        <Badge appearance="tint" size="small" style={{ color: accent, backgroundColor: accentTint(accent, 14) }}>{d.role}</Badge>
        {d.region && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.region}</Caption1>}
      </div>
    </div>
  );
}

function DomNode({ data, width, height }: NodeProps) {
  const d = data as DomData;
  return (
    <div style={{
      width: width ?? DOMAIN_W, height: height ?? 150, borderRadius: tokens.borderRadiusMedium,
      border: `1.5px dashed ${tokens.colorNeutralStroke1}`,
      background: tokens.colorNeutralBackground1, boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
        paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      }}>
        <span style={{ fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1 }}>{d.name}</span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>DLZ</Caption1>
      </div>
    </div>
  );
}

function SvcNode({ data }: NodeProps) {
  const d = data as SvcData;
  const v = itemVisual(d.type);
  const Icon = v.icon;
  const accent = SVC_ACCENT[d.type] || 'var(--loom-accent-teal)';
  return (
    <div style={{
      width: SVC_W, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
      paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
      paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
      borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      boxShadow: tokens.shadow4, boxSizing: 'border-box',
    }}>
      <span aria-hidden style={{
        flexShrink: 0, width: 26, height: 26, borderRadius: tokens.borderRadiusMedium,
        background: accentTint(accent, 14), color: accent,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon style={{ width: 16, height: 16 }} />
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightMedium,
        color: tokens.colorNeutralForeground1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{d.label}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = { subc: SubNode, domn: DomNode, svc: SvcNode };

function buildNodes(props: SetupDiagramProps): Node[] {
  const nodes: Node[] = [];
  const isMulti = props.mode === 'multi-sub';
  const hubName = props.adminSubscriptionName || props.adminSubscriptionId || 'Admin Plane subscription';
  const domH = domainHeight();

  function domainWithServices(parentId: string, domLabel: string): Node[] {
    const out: Node[] = [];
    const domId = `${parentId}:dom`;
    out.push({
      id: domId, type: 'domn', parentId, extent: 'parent',
      position: { x: (SUB_W - DOMAIN_W) / 2, y: SUB_HEADER + 8 },
      width: DOMAIN_W, height: domH, draggable: false, selectable: false,
      data: { name: domLabel },
    });
    DLZ_SERVICES.forEach((svc, k) => {
      out.push({
        id: `${domId}:svc:${k}`, type: 'svc', parentId: domId, extent: 'parent',
        position: { x: (DOMAIN_W - SVC_W) / 2, y: DOMAIN_HEADER + DOMAIN_PAD + k * (SVC_H + SVC_GAP_Y) },
        draggable: false, selectable: false,
        data: { type: svc.type, label: svc.label },
      });
    });
    return out;
  }

  if (!isMulti) {
    // Single-sub: one hub subscription that also holds the DLZ domain.
    const subId = 'sub:hub';
    const subH = SUB_HEADER + 8 + domH + SUB_BOTTOM;
    nodes.push({
      id: subId, type: 'subc', position: { x: 0, y: 0 },
      width: SUB_W, height: subH, draggable: false, selectable: false,
      data: { name: hubName, boundary: props.boundary, region: props.region, role: 'Admin + DLZ' },
    });
    const dom = props.spokes[0]?.domainName || 'default';
    nodes.push(...domainWithServices(subId, dom));
    return nodes;
  }

  // Multi-sub: hub subscription (Admin Plane) + one spoke subscription per DLZ.
  let x = 0;
  const subH = SUB_HEADER + 8 + domH + SUB_BOTTOM;
  // Hub (no DLZ domain — it hosts the Admin Plane only).
  nodes.push({
    id: 'sub:hub', type: 'subc', position: { x, y: 0 },
    width: SUB_W, height: SUB_HEADER + 56, draggable: false, selectable: false,
    data: { name: hubName, boundary: props.boundary, region: props.region, role: 'Admin Plane (hub)' },
  });
  x += SUB_W + SUB_GAP;
  props.spokes.forEach((spoke, i) => {
    const subId = `sub:spoke:${i}`;
    nodes.push({
      id: subId, type: 'subc', position: { x, y: 0 },
      width: SUB_W, height: subH, draggable: false, selectable: false,
      data: {
        name: spoke.subscriptionName || spoke.subscriptionId || `Spoke ${i + 1}`,
        boundary: props.boundary,
        region: spoke.region || props.region,
        role: 'DLZ (spoke)',
      },
    });
    nodes.push(...domainWithServices(subId, spoke.domainName || `dlz-${i + 1}`));
    x += SUB_W + SUB_GAP;
  });
  return nodes;
}

const useStyles = makeStyles({
  canvas: {
    position: 'relative',
    height: '340px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    background: tokens.colorNeutralBackground3,
  },
});

function DiagramInner(props: SetupDiagramProps) {
  const s = useStyles();
  const nodes = useMemo(() => buildNodes(props), [props]);
  return (
    <div className={s.canvas} data-canvas="setup-deployment-diagram">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        minZoom={0.3}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function SetupDeploymentDiagram(props: SetupDiagramProps) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}
