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
 * the stroke. The Web-5.0 canvas system unifies all edge rendering in the
 * shared {@link CanvasEdge} primitive (bezier path + stroke/width/animation/
 * marker, reduced-motion-aware) — this module is now a thin wrapper that
 * resolves the per-condition stroke and the `flowing` (active-run) flag and
 * delegates everything else. The public exports (`LoomBezierEdge`,
 * `LoomEdgeData`, `conditionMarkerId`, `MARKER_DEFS`) are unchanged so
 * `canvas.tsx` (edgeTypes key `'loom'` + `buildEdges`) is untouched.
 */

import { type EdgeProps } from '@xyflow/react';
import { CanvasEdge } from '@/lib/components/canvas/canvas-node-kit';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';

export interface LoomEdgeData {
  condition?: ConnectorCondition;
  /** When true, the edge is part of a live/running path → animated dashed flow. */
  active?: boolean;
  [key: string]: unknown;
}

export function LoomBezierEdge(props: EdgeProps) {
  const data = props.data as LoomEdgeData | undefined;
  const cond = data?.condition;
  const stroke = cond ? CONNECTOR_COLORS[cond] : '#888888';

  return <CanvasEdge {...props} stroke={stroke} flowing={!!data?.active} />;
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
