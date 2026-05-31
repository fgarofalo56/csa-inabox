'use client';

/**
 * EventstreamFlowNode — a React Flow custom node for the Eventstream visual
 * designer. Faithful to Fabric's real Eventstream editor, which is a free-form
 * canvas of source → operator → destination cards wired with curved
 * connectors (not a fixed 3-column list).
 *
 * Roles:
 *   source      — only an OUTPUT handle (right)
 *   transform   — INPUT (left) + OUTPUT (right)
 *   sink         — only an INPUT handle (left)
 *
 * Bezier connectors are React Flow's default edge type, configured on the
 * edges in visual-designer.tsx.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge, Caption1, tokens } from '@fluentui/react-components';
import {
  CloudArrowUp20Regular, Filter20Regular, DatabaseArrowRight20Regular,
  Database20Regular, Flowchart20Regular, BranchFork20Regular,
} from '@fluentui/react-icons';

export type NodeRole = 'source' | 'transform' | 'sink';

export interface EsNodeData {
  label: string;
  kind: string;
  role: NodeRole;
  subtitle?: string;
  [key: string]: unknown;
}

// Loom-themed accent per role (left swatch + badge).
const ROLE_COLOR: Record<NodeRole, string> = {
  source: '#0078d4',     // blue
  transform: '#7719aa',  // purple
  sink: '#107c10',       // green
};

function roleIcon(role: NodeRole, kind: string) {
  if (role === 'source') return <CloudArrowUp20Regular />;
  if (role === 'sink') return kind === 'kusto' ? <Database20Regular /> : <DatabaseArrowRight20Regular />;
  // transform
  if (kind === 'filter') return <Filter20Regular />;
  if (kind === 'join' || kind === 'union') return <BranchFork20Regular />;
  return <Flowchart20Regular />;
}

const HANDLE: React.CSSProperties = {
  width: 11, height: 11, borderRadius: '50%',
  background: tokens.colorNeutralBackground1, zIndex: 3,
};

function EventstreamFlowNodeImpl({ data, selected }: NodeProps) {
  const d = data as EsNodeData;
  const color = ROLE_COLOR[d.role];

  return (
    <div
      data-es-role={d.role}
      data-es-name={d.label}
      aria-label={`${d.role} ${d.label}`}
      style={{
        position: 'relative',
        width: 184,
        padding: '10px 12px',
        borderRadius: 6,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.06)',
        display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', userSelect: 'none',
      }}
    >
      {d.role !== 'source' && (
        <Handle id="in" type="target" position={Position.Left}
          style={{ ...HANDLE, left: -6, border: `2px solid ${tokens.colorBrandStroke1}` }} />
      )}
      {d.role !== 'sink' && (
        <Handle id="out" type="source" position={Position.Right}
          style={{ ...HANDLE, right: -6, border: `2px solid ${color}` }} />
      )}

      <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 2, background: color }} />
      <div style={{ color, display: 'flex', alignItems: 'center', flexShrink: 0 }}>{roleIcon(d.role, d.kind)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <div style={{
          fontWeight: 600, fontSize: 13, color: tokens.colorNeutralForeground1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{d.label}</div>
        <Badge appearance="filled" size="small" style={{ backgroundColor: color, color: '#fff', alignSelf: 'flex-start' }}>
          {d.kind}
        </Badge>
        {d.subtitle && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.subtitle}</Caption1>}
      </div>
    </div>
  );
}

export const EventstreamFlowNode = memo(EventstreamFlowNodeImpl);
