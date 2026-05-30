'use client';

/**
 * FlowActivityNode — the React Flow custom node for a pipeline activity.
 *
 * This is the @xyflow/react (React Flow) port of the old hand-rolled
 * ActivityNode. The visual is identical to ADF / Synapse / Fabric Studio
 * (swatch + name + type badge + optional description), but connection ports
 * are now real React Flow <Handle>s so wiring, hit-testing, and the rubber-band
 * connector come from the library instead of bespoke mouse math:
 *
 *   • one TARGET handle on the left edge (id `in`)
 *   • four SOURCE handles on the right edge, one per ADF conditional path —
 *     Upon Success (green) · Upon Failure (red) · Upon Completion (blue) ·
 *     Upon Skip (gray). The handle id IS the dependency condition, so the
 *     canvas's onConnect maps sourceHandle → dependencyCondition directly.
 *
 * Bezier connectors (React Flow's default edge curvature) are configured on
 * the edges, not here — see loom-bezier-edge.tsx.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge, Caption1, Tooltip, tokens } from '@fluentui/react-components';
import { findByType } from './activity-catalog';
import { activityIcon } from './activity-icons';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';
import type { PipelineActivity } from './types';

export const FLOW_NODE_W = 200;

const OUTPUT_CONDITIONS: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
const COND_LABEL: Record<ConnectorCondition, string> = {
  Succeeded: 'Upon Success',
  Failed: 'Upon Failure',
  Completed: 'Upon Completion',
  Skipped: 'Upon Skip',
};
// Vertical placement (as a % of node height) of the four stacked output ports.
const PORT_TOP: Record<ConnectorCondition, string> = {
  Succeeded: '22%',
  Failed: '40%',
  Completed: '60%',
  Skipped: '78%',
};

/** The data carried on a React Flow node of type `activity`. */
export interface ActivityNodeData {
  activity: PipelineActivity;
  [key: string]: unknown;
}

const HANDLE_BASE: React.CSSProperties = {
  width: 11,
  height: 11,
  borderRadius: '50%',
  background: tokens.colorNeutralBackground1,
  zIndex: 3,
};

function FlowActivityNodeImpl({ data, selected }: NodeProps) {
  const activity = (data as ActivityNodeData).activity;
  const def = findByType(activity.type);
  const swatch = def?.color || tokens.colorBrandBackground;

  return (
    <div
      // The id keeps DOM parity with the old node for any existing selectors.
      id={`activity-node-${activity.name}`}
      data-activity-name={activity.name}
      data-activity-type={activity.type || ''}
      aria-label={`Activity ${activity.name} of type ${activity.type || 'unknown'}`}
      style={{
        position: 'relative',
        width: FLOW_NODE_W,
        padding: '10px 12px',
        borderRadius: 6,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected
          ? `0 0 0 2px ${tokens.colorBrandBackground2}`
          : '0 1px 2px rgba(0,0,0,0.06)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* Input port (left edge) */}
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ ...HANDLE_BASE, left: -6, border: `2px solid ${tokens.colorBrandStroke1}` }}
        title="Input — drop a connector here"
      />

      {/* Four output ports (right edge), one per ADF conditional path. The
          handle id IS the dependency condition. */}
      {OUTPUT_CONDITIONS.map((cond) => (
        <Tooltip key={cond} content={COND_LABEL[cond]} relationship="label" positioning="after">
          <Handle
            id={cond}
            type="source"
            position={Position.Right}
            data-handle-condition={cond}
            aria-label={`${COND_LABEL[cond]} output — drag to connect`}
            style={{ ...HANDLE_BASE, right: -6, top: PORT_TOP[cond], border: `2px solid ${CONNECTOR_COLORS[cond]}` }}
          />
        </Tooltip>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 2, background: swatch }} />
        <div style={{
          flexShrink: 0, width: 28, height: 28, borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${swatch}1a`, color: swatch,
        }} aria-hidden="true">{activityIcon(activity.type)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 600, fontSize: 13, color: tokens.colorNeutralForeground1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {activity.name}
          </div>
          <Badge
            appearance="filled"
            size="small"
            style={{ backgroundColor: swatch, color: def?.fg || '#fff', alignSelf: 'flex-start' }}
          >
            {def?.label || activity.type || 'Unknown'}
          </Badge>
          {activity.description && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{activity.description as string}</Caption1>
          )}
          {def && !def.runnable && (
            <Badge size="small" appearance="outline" color="warning">Save-only</Badge>
          )}
        </div>
      </div>
    </div>
  );
}

export const FlowActivityNode = memo(FlowActivityNodeImpl);
