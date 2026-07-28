'use client';

/**
 * FlowActivityNode — the React Flow custom node for a pipeline activity.
 *
 * This is the @xyflow/react (React Flow) port of the old hand-rolled
 * ActivityNode. The node chrome (accent rail + gradient header + type-specific
 * glyph chip + title + StatusChip + body badges) is now rendered by the shared
 * Web-5.0 `CanvasNode` primitive from `@/lib/components/canvas/canvas-node-kit`
 * so the pipeline and mapping-data-flow canvases share one richer, token-only
 * visual system that out-classes ADF / Synapse / Fabric Studio. Container
 * activities (ForEach / If / Until / Switch) render with the framed-container
 * variant + live branch chips.
 *
 * Connection ports stay owned HERE and are real React Flow <Handle>s so wiring,
 * hit-testing, and the rubber-band connector come from the library:
 *
 *   • one TARGET handle on the left edge (id `in`)
 *   • four SOURCE handles on the right edge, one per ADF conditional path —
 *     Upon Success (green) · Upon Failure (red) · Upon Completion (blue) ·
 *     Upon Skip (gray). The handle id IS the dependency condition, so the
 *     canvas's onConnect maps sourceHandle → dependencyCondition directly.
 *
 * Handle visuals (11px circles, typed colored border) come from the shared
 * `portStyle` helper so both canvases derive identical ports. All colors /
 * spacing / radius / shadow flow from Loom tokens or `--loom-accent-*` via the
 * kit — no raw hex or px in this file (the fixed 11px handle geometry React
 * Flow needs lives inside `portStyle`).
 *
 * Bezier connectors (React Flow's default edge curvature) are configured on
 * the edges, not here — see loom-bezier-edge.tsx.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge, Button, Tooltip, tokens } from '@fluentui/react-components';
import { Edit16Regular, Glasses16Regular } from '@fluentui/react-icons';
import { findByType } from './activity-catalog';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';
import { isContainerType, totalInnerCount, branchesOf, miniPreviewSections } from './drill-path';
import {
  runStatusToNodeStatus, runStatusDetail, type ActivityRunOverlayRow,
} from './pipeline-debug-overlay';
import {
  CanvasNode,
  CANVAS_NODE_WIDTH,
  getActivityVisual,
  portStyle,
  standardNodeActions,
  type CanvasNodeStatus,
  type NodeAction,
  type PortKind,
} from '@/lib/components/canvas/canvas-node-kit';
import type { PipelineActivity } from './types';

/** Pipeline node width — the shared kit compact width (layout math keys off this). */
export const FLOW_NODE_W = CANVAS_NODE_WIDTH;

const OUTPUT_CONDITIONS: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
const COND_LABEL: Record<ConnectorCondition, string> = {
  Succeeded: 'Upon Success',
  Failed: 'Upon Failure',
  Completed: 'Upon Completion',
  Skipped: 'Upon Skip',
};
// ADF condition → the kit's typed port kind, so the four output handles render
// as Fabric-style small COLORED SQUARES (green/red/brand/neutral) while the
// handle `id` stays the ConnectorCondition the canvas onConnect maps from.
const COND_TO_PORT: Record<ConnectorCondition, PortKind> = {
  Succeeded: 'success',
  Failed: 'fail',
  Completed: 'complete',
  Skipped: 'skip',
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
  /**
   * Drill into this container's inner sub-canvas. Wired by the canvas; only
   * present (and rendered) for control-flow container activities.
   */
  onDrill?: (name: string) => void;
  /**
   * Show the inline mini-preview of inner activities inside container nodes —
   * Fabric's "updated canvas experience" (Learn:
   * data-factory/pipeline-canvas-experience). Toggled by the N keyboard
   * shortcut / the "Nested" toolbar button on the canvas.
   */
  showNestedPreview?: boolean;
  /**
   * Optional run/config state reflected in the header StatusChip. Defaults to
   * 'idle' (shows the type-label chip) so existing call sites compile
   * unchanged.
   */
  status?: CanvasNodeStatus;
  /** Inline live-status detail ('Loading data…' / 'Running Copy…'). */
  statusDetail?: string;
  /** Inline node action-bar callbacks (delete / view-JSON / clone). Optional. */
  onDelete?: (name: string) => void;
  onViewJson?: (name: string) => void;
  onClone?: (name: string) => void;
  /**
   * "Explain this step" (W19) — opens the node-scoped Explain drawer for this
   * activity (a real AOAI summary grounded on the activity JSON + its canvas /
   * lineage neighbors). Wired by the canvas; absent → no Explain action.
   */
  onExplain?: (name: string) => void;
  /**
   * U13 — this activity's live/last run receipt (published by the Debug /
   * Monitor surfaces through the pipeline-debug-overlay store). When present
   * the header StatusChip paints the RUN status (ADF debug-canvas parity) and
   * the eyeglass action drills into the run detail.
   */
  run?: ActivityRunOverlayRow;
  /** Open the run-monitoring detail (eyeglass) for this activity. */
  onInspectRun?: (name: string) => void;
  [key: string]: unknown;
}

function FlowActivityNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as ActivityNodeData;
  const activity = nodeData.activity;
  const def = findByType(activity.type);
  const visual = getActivityVisual(activity.type);
  const isContainer = isContainerType(activity.type);
  const innerCount = isContainer ? totalInnerCount(activity) : 0;

  const actionBar: NodeAction[] = standardNodeActions({
    onExplain: nodeData.onExplain ? () => nodeData.onExplain!(activity.name) : undefined,
    onViewJson: nodeData.onViewJson ? () => nodeData.onViewJson!(activity.name) : undefined,
    onClone: nodeData.onClone ? () => nodeData.onClone!(activity.name) : undefined,
    onDelete: nodeData.onDelete ? () => nodeData.onDelete!(activity.name) : undefined,
  });
  // U13 — the ADF eyeglass: when this activity has a run receipt, lead the
  // action bar with "View run details" (drills to input/output/error JSON).
  if (nodeData.run && nodeData.onInspectRun) {
    actionBar.unshift({
      key: 'inspect-run',
      icon: <Glasses16Regular />,
      label: 'View run details',
      onClick: (e) => { e.stopPropagation(); nodeData.onInspectRun!(activity.name); },
    });
  }

  // Run receipt wins the header StatusChip while an overlay is published
  // (ADF debug-canvas parity); otherwise any host-supplied status shows.
  const runStatus: CanvasNodeStatus | undefined = nodeData.run
    ? runStatusToNodeStatus(nodeData.run.status)
    : undefined;
  const statusDetail = nodeData.run ? runStatusDetail(nodeData.run) : nodeData.statusDetail;

  return (
    <CanvasNode
      width={FLOW_NODE_W}
      title={activity.name}
      visual={visual}
      typeLabel={def?.label || activity.type || 'Unknown'}
      selected={selected}
      status={runStatus ?? nodeData.status}
      statusDetail={statusDetail}
      actionBar={actionBar.length > 0 ? actionBar : undefined}
      description={activity.description as string | undefined}
      framed={isContainer}
      branchChips={
        isContainer
          ? branchesOf(activity).map((b) => ({ label: b.label, count: b.count }))
          : undefined
      }
      headerAction={
        isContainer && nodeData.onDrill ? (
          <Tooltip content={`Edit ${def?.label || activity.type} activities`} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Edit16Regular />}
              aria-label={`Edit ${activity.name} inner activities`}
              data-drill-into={activity.name}
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); nodeData.onDrill!(activity.name); }}
            />
          </Tooltip>
        ) : undefined
      }
      badges={
        <>
          {isContainer && (
            <Badge
              appearance="tint"
              size="small"
              color="informative"
              data-inner-count={innerCount}
              title="Inner activities — double-click or use the pencil to edit"
            >
              Activities ({innerCount})
            </Badge>
          )}
          {def && !def.runnable && (
            <Badge size="small" appearance="outline" color="warning">Save-only</Badge>
          )}
        </>
      }
      rootProps={{
        // The id keeps DOM parity with the old node for any existing selectors.
        id: `activity-node-${activity.name}`,
        'data-activity-name': activity.name,
        'data-activity-type': activity.type || '',
        'aria-label': `Activity ${activity.name} of type ${activity.type || 'unknown'}`,
      }}
    >
      {/* Input port (left edge). Handles stay owned here; visuals come from the
          shared portStyle helper (11px circle, typed colored border). */}
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ ...portStyle('in', tokens.colorBrandStroke1), left: -6 }}
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
            // Typed COLORED SQUARE per condition (kit derives the palette colour
            // from the mapped port kind); id stays the ConnectorCondition.
            style={{ ...portStyle(COND_TO_PORT[cond], CONNECTOR_COLORS[cond]), right: -6, top: PORT_TOP[cond] }}
          />
        </Tooltip>
      ))}

      {/* Inline nested-activity mini-preview — Fabric "updated canvas
          experience": a container summarises its inner activities right on the
          parent canvas. Toggled by the N shortcut / "Nested" toolbar button.
          Non-interactive (pointerEvents:none) — drilling still uses the pencil
          or double-click so the node stays draggable. */}
      {isContainer && nodeData.showNestedPreview && (
        <div
          data-nested-preview={activity.name}
          aria-label={`Inner activities preview for ${activity.name}`}
          style={{
            marginTop: tokens.spacingVerticalXS,
            borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
            paddingTop: tokens.spacingVerticalXS,
            paddingLeft: tokens.spacingHorizontalMNudge,
            paddingRight: tokens.spacingHorizontalS,
            paddingBottom: tokens.spacingVerticalSNudge,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacingVerticalXS,
            pointerEvents: 'none',
          }}
        >
          {miniPreviewSections(activity, 3).map((sec) => (
            <div key={sec.label}>
              <div style={{
                fontSize: tokens.fontSizeBase100,
                fontWeight: tokens.fontWeightSemibold,
                color: tokens.colorNeutralForeground3,
                marginBottom: tokens.spacingVerticalXXS,
              }}>
                {sec.label} ({sec.totalCount})
              </div>
              {sec.activities.length === 0 ? (
                <div style={{
                  fontSize: tokens.fontSizeBase100,
                  color: tokens.colorNeutralForeground3,
                  fontStyle: 'italic',
                }}>
                  empty
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                  {sec.activities.map((inner) => {
                    const iVisual = getActivityVisual(inner.type);
                    return (
                      <div key={inner.name} style={{
                        display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center',
                        fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2,
                      }}>
                        <span style={{ color: iVisual.accent, flexShrink: 0, display: 'inline-flex' }} aria-hidden="true">
                          {iVisual.icon}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {inner.name}
                        </span>
                      </div>
                    );
                  })}
                  {sec.totalCount > sec.activities.length && (
                    <div style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
                      +{sec.totalCount - sec.activities.length} more
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </CanvasNode>
  );
}

export const FlowActivityNode = memo(FlowActivityNodeImpl);
