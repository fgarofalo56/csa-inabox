'use client';

/**
 * React Flow node components for the Deployment planner.
 *
 *   subscription  → outer container (boundary-tinted), holds domain groups
 *   domain        → inner container, holds service nodes
 *   service       → leaf: official Azure icon + label (a planned deployment)
 *
 * Containment, not flow — there are no connection handles. The visual answers
 * "what deploys where": services sit inside the domain inside the subscription.
 */

import * as React from 'react';
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge, Caption1, tokens } from '@fluentui/react-components';
import { CheckmarkCircle12Filled, Circle12Regular } from '@fluentui/react-icons';
import { serviceByKey, serviceVisual, type ConfigStatus } from './service-catalog';
import { iconUrl } from '../ui/item-type-visual';

const BOUNDARY_TINT: Record<string, string> = {
  'Commercial': '#0078d4',
  'GCC': '#5c2d91',
  'GCC-High': '#5c2d91',
  'IL5': '#a4262c',
};

export interface SubscriptionNodeData {
  name: string;
  boundary?: string;
  region?: string;
  [key: string]: unknown;
}
export interface DomainNodeData {
  name: string;
  serviceCount: number;
  [key: string]: unknown;
}
export interface ServiceNodeData {
  serviceKey: string;
  /** Per-resource config status, computed by the view (drives the node badge). */
  configStatus?: ConfigStatus;
  [key: string]: unknown;
}

function SubscriptionNodeImpl({ data, width, height, selected }: NodeProps) {
  const d = data as SubscriptionNodeData;
  const tint = BOUNDARY_TINT[d.boundary || 'Commercial'] || '#0078d4';
  return (
    <div
      data-plan-subscription={d.name}
      style={{
        width: width ?? 360, height: height ?? 240,
        borderRadius: 10,
        border: `2px solid ${selected ? tokens.colorBrandStroke1 : tint}`,
        background: `${tint}0d`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderBottom: `1px solid ${tint}40`,
        background: `${tint}1a`, borderTopLeftRadius: 8, borderTopRightRadius: 8,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: tokens.colorNeutralForeground1 }}>{d.name}</span>
        <Badge appearance="tint" size="small" style={{ color: tint }}>{d.boundary || 'Commercial'}</Badge>
        {d.region && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.region}</Caption1>}
      </div>
    </div>
  );
}

function DomainNodeImpl({ data, width, height, selected }: NodeProps) {
  const d = data as DomainNodeData;
  return (
    <div
      data-plan-domain={d.name}
      style={{
        width: width ?? 300, height: height ?? 150,
        borderRadius: 8,
        border: `1.5px ${selected ? 'solid' : 'dashed'} ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1}`,
        background: tokens.colorNeutralBackground1,
        boxSizing: 'border-box',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: tokens.colorNeutralForeground1 }}>{d.name}</span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.serviceCount} svc</Caption1>
      </div>
    </div>
  );
}

function ServiceNodeImpl({ data, selected }: NodeProps) {
  const d = data as ServiceNodeData;
  const def = serviceByKey(d.serviceKey);
  const vis = serviceVisual(d.serviceKey);
  const Glyph = vis.glyph;
  // Optional Atlas Diag enhancement — resolve via the canonical icon slug, NOT
  // the camelCase key (which is not in the Atlas Diag / Azure-icon namespace).
  const remote = iconUrl(def?.iconSlug ?? d.serviceKey);
  const handleStyle: React.CSSProperties = {
    width: 8, height: 8, background: tokens.colorBrandBackground,
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  };
  return (
    <div
      data-plan-service={d.serviceKey}
      title={def?.description}
      style={{
        width: 132,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 9px', borderRadius: 8,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.06)',
        boxSizing: 'border-box',
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} isConnectable />
      <ServiceIconChip def={def} vis={vis} Glyph={Glyph} remote={remote} size={26} iconPx={16} radius={6} />
      <span style={{
        flex: 1, minWidth: 0,
        fontSize: 11, fontWeight: 500, color: tokens.colorNeutralForeground1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{vis.label}</span>
      {def?.config?.length ? (
        d.configStatus === 'configured' ? (
          <CheckmarkCircle12Filled aria-label="Configured" title="Configured ✓"
            style={{ flexShrink: 0, color: tokens.colorPaletteGreenForeground1 }} />
        ) : d.configStatus === 'invalid' ? (
          <span role="img" aria-label="Invalid configuration" title="Invalid configuration — open to fix" style={{
            flexShrink: 0, width: 7, height: 7, borderRadius: 4,
            background: tokens.colorPaletteRedBackground3,
          }} />
        ) : (
          <Circle12Regular aria-label="Needs configuration"
            title="Using defaults — select to review its SKU / tier"
            style={{ flexShrink: 0, color: tokens.colorNeutralForeground3 }} />
        )
      ) : null}
      {def?.planOnly && (
        <span role="img" aria-label="Plan-only — no one-button bicep toggle yet"
          title="Plan-only — no one-button bicep toggle yet" style={{
          flexShrink: 0, width: 7, height: 7, borderRadius: 4,
          background: tokens.colorPaletteMarigoldBackground3,
        }} />
      )}
      <Handle type="source" position={Position.Right} style={handleStyle} isConnectable />
    </div>
  );
}

/**
 * Shared icon chip: a tinted rounded square holding either the bundled Azure
 * raster icon, the optional Atlas Diag remote icon, or the Fluent glyph. The
 * fixed-size chip with its own padding is what keeps the icon from butting the
 * label (the old node packed a bare 20px image flush against the text).
 */
function ServiceIconChip({
  def, vis, Glyph, remote, size, iconPx, radius,
}: {
  def: ReturnType<typeof serviceByKey>;
  vis: { color: string; label: string };
  Glyph: React.ComponentType<{ style?: React.CSSProperties }>;
  remote: string | undefined;
  size: number; iconPx: number; radius: number;
}) {
  // If the optional Atlas Diag remote icon 404s (the slug isn't hosted, or the
  // endpoint is unreachable in an air-gapped/sovereign boundary), drop to the
  // bundled raster / Fluent glyph instead of leaving a broken-image box.
  const [remoteOk, setRemoteOk] = React.useState(true);
  // Re-arm the remote attempt whenever the slug changes so a recycled chip
  // (React Flow reuses node instances) never suppresses a valid icon because a
  // previous, different slug had 404'd.
  React.useEffect(() => { setRemoteOk(true); }, [remote]);
  const showRemote = !!remote && remoteOk;
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0, width: size, height: size, borderRadius: radius,
        background: `${vis.color}1f`, color: vis.color,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {showRemote ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={remote} alt="" width={iconPx} height={iconPx} style={{ borderRadius: 3 }}
          onError={() => setRemoteOk(false)} />
      ) : def?.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/azure-icons/${def.icon}`} alt="" width={iconPx} height={iconPx} />
      ) : (
        <Glyph style={{ width: iconPx, height: iconPx, color: vis.color }} />
      )}
    </span>
  );
}

export { ServiceIconChip };

export const SubscriptionNode = memo(SubscriptionNodeImpl);
export const DomainNode = memo(DomainNodeImpl);
export const ServiceNode = memo(ServiceNodeImpl);
