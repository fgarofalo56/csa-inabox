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

import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Badge, Caption1, tokens } from '@fluentui/react-components';
import { serviceByKey } from './service-catalog';

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
  const color = def?.color || '#0078d4';
  return (
    <div
      data-plan-service={d.serviceKey}
      title={def?.description}
      style={{
        width: 128,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 7px', borderRadius: 6,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.06)',
        boxSizing: 'border-box',
      }}
    >
      {def?.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/azure-icons/${def.icon}`} alt="" width={20} height={20} style={{ flexShrink: 0 }} />
      ) : (
        <span style={{
          width: 20, height: 20, flexShrink: 0, borderRadius: 4, background: color, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
        }}>{(def?.label || d.serviceKey).slice(0, 2).toUpperCase()}</span>
      )}
      <span style={{
        fontSize: 11, fontWeight: 500, color: tokens.colorNeutralForeground1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{def?.label || d.serviceKey}</span>
    </div>
  );
}

export const SubscriptionNode = memo(SubscriptionNodeImpl);
export const DomainNode = memo(DomainNodeImpl);
export const ServiceNode = memo(ServiceNodeImpl);
