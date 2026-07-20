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
import { Position, type NodeProps } from '@xyflow/react';
import {
  CanvasNode, CanvasPort, CANVAS_NODE_WIDTH, getOperatorVisual, standardNodeActions,
  type CanvasNodeStatus, type CanvasVisual,
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

/** Node width (matches the kit's shared compact sizing contract). */
const NODE_WIDTH = CANVAS_NODE_WIDTH;

/**
 * Map an eventstream node to a generic operator role, then resolve its branded
 * glyph + category accent through the shared kit (`getOperatorVisual`). A
 * source moves events in, a sink is the controlled endpoint, and a transform is
 * refined by its `kind` (filter → control, join/union → join) so each operator
 * still gets a DISTINCT glyph — now from the one kit map instead of a local one.
 */
function operatorRole(role: NodeRole, kind: string): string {
  if (role === 'source') return 'source';
  if (role === 'sink') return 'sink';
  if (kind === 'filter') return 'filter';
  if (kind === 'join' || kind === 'union') return 'join';
  // Geospatial operators carry their own kit glyphs (geo-graph-ml GEO-1).
  if (kind === 'geo-point' || kind === 'geo-fence' || kind === 'geo-proximity' || kind === 'geo-aggregate') return kind;
  return 'transform';
}

/** Resolve the kit visual (glyph + category + accent var) for an eventstream node. */
function eventstreamVisual(role: NodeRole, kind: string): CanvasVisual {
  return getOperatorVisual(operatorRole(role, kind));
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
        <CanvasPort id="in" type="target" position={Position.Left} accent={visual.accent} label="events" />
      )}
      {d.role !== 'sink' && (
        <CanvasPort id="out" type="source" position={Position.Right} accent={visual.accent} label="events" />
      )}
    </CanvasNode>
  );
}

export const EventstreamFlowNode = memo(EventstreamFlowNodeImpl);
