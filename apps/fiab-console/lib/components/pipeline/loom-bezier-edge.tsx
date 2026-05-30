'use client';

/**
 * LoomBezierEdge — the pipeline dependency connector, drawn with React Flow's
 * Bezier curvature (the same connector style atlas-diag uses).
 *
 * ADF / Synapse / Fabric draw four connector colours, one per dependency
 * condition:
 *   Succeeded → green  #107c10
 *   Failed    → red    #d13438
 *   Completion→ blue   #0078d4
 *   Skipped   → grey   #888888
 *
 * The condition rides on `edge.data.condition`; the arrowhead colour matches
 * the stroke. `getBezierPath` gives the smooth S-curve between the source
 * output port and the target input port.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';

export interface LoomEdgeData {
  condition?: ConnectorCondition;
  [key: string]: unknown;
}

export function LoomBezierEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const cond = (data as LoomEdgeData | undefined)?.condition;
  const stroke = cond ? CONNECTOR_COLORS[cond] : '#888888';

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{ stroke, strokeWidth: selected ? 2.5 : 1.7 }}
    />
  );
}

/** Marker-end id per condition (registered once by the canvas via SVG defs). */
export function conditionMarkerId(cond?: ConnectorCondition): string {
  return `loom-arrow-${cond || 'default'}`;
}

/** The four condition colours + default, for SVG <marker> registration. */
export const MARKER_DEFS: Array<[string, string]> = [
  ['Succeeded', CONNECTOR_COLORS.Succeeded],
  ['Failed', CONNECTOR_COLORS.Failed],
  ['Completed', CONNECTOR_COLORS.Completed],
  ['Skipped', CONNECTOR_COLORS.Skipped],
  ['default', '#888888'],
];
