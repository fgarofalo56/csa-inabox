'use client';

/**
 * ActivityNode — a single tile on the canvas. Selectable, draggable
 * (to reorder on canvas-grid in future), shows an iconic color swatch +
 * activity name + type badge.
 */

import { Badge, Caption1, Tooltip, tokens, makeStyles } from '@fluentui/react-components';
import { findByType } from './activity-catalog';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';
import type { PipelineActivity } from './types';

const useStyles = makeStyles({
  card: {
    position: 'absolute',
    padding: '10px 12px',
    borderRadius: 6,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
    minWidth: 180,
    maxWidth: 220,
    display: 'flex', flexDirection: 'column', gap: 4,
    cursor: 'pointer',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '120ms',
    userSelect: 'none',
  },
  selected: {
    borderColor: tokens.colorBrandStroke1,
    boxShadow: `0 0 0 2px ${tokens.colorBrandBackground2}`,
  },
  name: {
    fontWeight: 600,
    fontSize: 13,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  swatch: { width: 6, alignSelf: 'stretch', borderRadius: 2 },
  body: { display: 'flex', gap: 8, alignItems: 'flex-start' },
  textCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  // Connection handles — the small circular ports on a node's left (input)
  // and right (output) edges. ADF Studio gives every activity four output
  // ports stacked on the right edge, one per conditional path:
  //   Upon Success (green) · Upon Failure (red) · Upon Completion (blue) ·
  //   Upon Skip (gray). Dragging from a port to another node's input port
  //   creates a dependsOn edge with that dependencyCondition.
  handle: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: '50%',
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'crosshair',
    zIndex: 2,
    transitionProperty: 'transform',
    transitionDuration: '100ms',
    ':hover': { transform: 'scale(1.4)' },
  },
  handleIn: {
    left: -7,
    top: '50%',
    marginTop: -6,
    border: `2px solid ${tokens.colorBrandStroke1}`,
  },
  // Output ports column on the right edge.
  outPorts: {
    position: 'absolute',
    right: -7,
    top: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 4,
    zIndex: 2,
  },
});

const OUTPUT_CONDITIONS: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
const COND_LABEL: Record<ConnectorCondition, string> = {
  Succeeded: 'Upon Success',
  Failed: 'Upon Failure',
  Completed: 'Upon Completion',
  Skipped: 'Upon Skip',
};

export interface ActivityNodeProps {
  activity: PipelineActivity;
  x: number;
  y: number;
  selected?: boolean;
  onSelect?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  /** Begin dragging a connector out of this node's output port for `cond`. */
  onConnectStart?: (cond: ConnectorCondition, e: React.MouseEvent) => void;
  /** Pointer entered this node's input port while a connector drag is live. */
  onConnectEnter?: () => void;
  onConnectLeave?: () => void;
}

export function ActivityNode({
  activity, x, y, selected, onSelect, onMouseDown,
  onConnectStart, onConnectEnter, onConnectLeave,
}: ActivityNodeProps) {
  const s = useStyles();
  const def = findByType(activity.type);
  const swatch = def?.color || tokens.colorBrandBackground;

  return (
    <div
      id={`activity-node-${activity.name}`}
      className={`${s.card} ${selected ? s.selected : ''}`}
      style={{ left: x, top: y }}
      role="button"
      tabIndex={0}
      aria-pressed={selected || false}
      aria-label={`Activity ${activity.name} of type ${activity.type || 'unknown'}`}
      data-activity-name={activity.name}
      data-activity-type={activity.type || ''}
      onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(); }
      }}
      onMouseDown={onMouseDown}
    >
      {/* Input port (left edge) */}
      <div
        className={`${s.handle} ${s.handleIn}`}
        data-handle="in"
        title="Input — drop a connector here"
        onMouseEnter={onConnectEnter}
        onMouseLeave={onConnectLeave}
      />
      {/* Four output ports (right edge), one per conditional path. */}
      <div className={s.outPorts}>
        {OUTPUT_CONDITIONS.map((cond) => (
          <Tooltip key={cond} content={COND_LABEL[cond]} relationship="label" positioning="after">
            <div
              className={s.handle}
              data-handle="out"
              data-handle-condition={cond}
              style={{ position: 'relative', right: 0, border: `2px solid ${CONNECTOR_COLORS[cond]}` }}
              aria-label={`${COND_LABEL[cond]} output — drag to connect`}
              onMouseDown={(e) => { e.stopPropagation(); onConnectStart?.(cond, e); }}
            />
          </Tooltip>
        ))}
      </div>
      <div className={s.body}>
        <div className={s.swatch} style={{ backgroundColor: swatch }} />
        <div className={s.textCol}>
          <div className={s.name}>{activity.name}</div>
          <Badge appearance="filled" size="small" style={{ backgroundColor: swatch, color: def?.fg || '#fff', alignSelf: 'flex-start' }}>
            {def?.label || activity.type || 'Unknown'}
          </Badge>
          {activity.description && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{activity.description}</Caption1>
          )}
          {def && !def.runnable && (
            <Badge size="small" appearance="outline" color="warning">Save-only</Badge>
          )}
        </div>
      </div>
    </div>
  );
}
