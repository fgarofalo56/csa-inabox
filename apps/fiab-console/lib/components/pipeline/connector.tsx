'use client';

/**
 * Connector — SVG path between two activity tiles with the right
 * dependency-condition colour.
 *
 * Fabric's 4 connector colours:
 *   Succeeded → green   #107c10
 *   Failed    → red     #d13438
 *   Completion→ blue    #0078d4
 *   Skipped   → grey    #888888
 *
 * Rendered inside the canvas's absolute-positioned SVG overlay; pure
 * stateless component so it can be hot-swapped during measurement.
 */

import { tokens } from '@fluentui/react-components';

export type ConnectorCondition = 'Succeeded' | 'Failed' | 'Completed' | 'Skipped';

// Theme-aware semantic tokens — same source the read-only DAG view (COND_COLORS)
// uses, so the editable canvas edges and the DAG edges share one palette.
export const CONNECTOR_COLORS: Record<ConnectorCondition, string> = {
  Succeeded: tokens.colorPaletteGreenForeground1,
  Failed:    tokens.colorPaletteRedForeground1,
  Completed: tokens.colorBrandForeground1,
  Skipped:   tokens.colorNeutralForeground3,
};

export interface ConnectorProps {
  sx: number; sy: number;
  ex: number; ey: number;
  condition?: ConnectorCondition;
  selected?: boolean;
  /** Unique key for the SVG <path>. */
  id: string;
  onClick?: () => void;
}

export function Connector({ sx, sy, ex, ey, condition, selected, id, onClick }: ConnectorProps) {
  const color = condition ? CONNECTOR_COLORS[condition] : tokens.colorNeutralForeground3;
  const dx = Math.max(48, Math.abs(ex - sx) / 2);
  const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
  const markerKey = condition || 'default';

  return (
    <g data-connector-id={id} data-connector-condition={condition || ''} onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : undefined }}
    >
      {/* invisible wider hit target */}
      <path d={d} stroke="transparent" strokeWidth={10} fill="none" />
      <path
        d={d}
        stroke={color}
        strokeWidth={selected ? 2.5 : 1.6}
        fill="none"
        markerEnd={`url(#fiab-arrow-${markerKey})`}
      />
    </g>
  );
}

/**
 * Renders the SVG <defs> with the four arrow markers (one per condition
 * colour + a default). Mount once per canvas.
 */
export function ConnectorMarkers() {
  const items: Array<[string, string]> = [
    ['Succeeded', CONNECTOR_COLORS.Succeeded],
    ['Failed',    CONNECTOR_COLORS.Failed],
    ['Completed', CONNECTOR_COLORS.Completed],
    ['Skipped',   CONNECTOR_COLORS.Skipped],
    ['default',   tokens.colorNeutralForeground3],
  ];
  return (
    <defs>
      {items.map(([k, c]) => (
        <marker
          key={k}
          id={`fiab-arrow-${k}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
        </marker>
      ))}
    </defs>
  );
}
