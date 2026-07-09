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
import type { JSX } from 'react';
import {
  CloudArrowUp20Regular, Filter20Regular, DatabaseArrowRight20Regular,
  Database20Regular, Flowchart20Regular, BranchFork20Regular,
} from '@fluentui/react-icons';
import {
  CanvasNode, CATEGORY_ACCENT, portStyle, standardNodeActions,
  type CanvasNodeCategory, type CanvasNodeStatus, type CanvasVisual,
} from '@/lib/components/canvas/canvas-node-kit';

export type NodeRole = 'source' | 'transform' | 'sink';

export interface EsNodeData {
  label: string;
  kind: string;
  role: NodeRole;
  subtitle?: string;
  /** Optional run/preview state → header StatusChip (default 'idle'). */
  status?: CanvasNodeStatus;
  /** Inline live-status detail ('Loading data…') shown under the header. */
  statusDetail?: string;
  /** Inline node action-bar callbacks (view-JSON / clone / delete). Optional. */
  onViewJson?: () => void;
  onClone?: () => void;
  onDelete?: () => void;
  [key: string]: unknown;
}

/** Node width (matches the kit's pipeline/data-flow sizing contract). */
const NODE_WIDTH = 200;

/**
 * Role → one of the kit's 5 canvas categories, driving the theme-aware accent
 * (CATEGORY_ACCENT) + gradient header + rail. Sources move data in, sinks are
 * the controlled endpoints, transforms reshape.
 */
const ROLE_CATEGORY: Record<NodeRole, CanvasNodeCategory> = {
  source: 'move',        // --loom-accent-blue
  transform: 'transform', // --loom-accent-violet
  sink: 'control',       // --loom-accent-teal
};

function roleIcon(role: NodeRole, kind: string): JSX.Element {
  if (role === 'source') return <CloudArrowUp20Regular />;
  if (role === 'sink') return kind === 'kusto' ? <Database20Regular /> : <DatabaseArrowRight20Regular />;
  // transform
  if (kind === 'filter') return <Filter20Regular />;
  if (kind === 'join' || kind === 'union') return <BranchFork20Regular />;
  return <Flowchart20Regular />;
}

/** Resolve the kit visual (glyph + category + accent var) for an eventstream node. */
function eventstreamVisual(role: NodeRole, kind: string): CanvasVisual {
  const category = ROLE_CATEGORY[role];
  return { icon: roleIcon(role, kind), category, accent: CATEGORY_ACCENT[category] };
}

function EventstreamFlowNodeImpl({ data, selected }: NodeProps) {
  const d = data as EsNodeData;
  const visual = eventstreamVisual(d.role, d.kind);

  const actionBar = standardNodeActions({
    onViewJson: d.onViewJson,
    onClone: d.onClone,
    onDelete: d.onDelete,
  });

  return (
    <CanvasNode
      width={NODE_WIDTH}
      title={d.label}
      visual={visual}
      selected={selected}
      typeLabel={d.kind}
      status={d.status}
      statusDetail={d.statusDetail}
      actionBar={actionBar.length > 0 ? actionBar : undefined}
      description={d.subtitle}
      rootProps={{
        'data-es-role': d.role,
        'data-es-name': d.label,
        'aria-label': `${d.role} ${d.label}`,
      }}
    >
      {d.role !== 'source' && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          style={{ ...portStyle('in', visual.accent), left: -6 }}
        />
      )}
      {d.role !== 'sink' && (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          style={{ ...portStyle('out', visual.accent), right: -6 }}
        />
      )}
    </CanvasNode>
  );
}

export const EventstreamFlowNode = memo(EventstreamFlowNodeImpl);
