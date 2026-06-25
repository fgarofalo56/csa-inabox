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
import { Badge, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  CheckmarkCircle12Filled, Circle12Regular,
  CloudCube20Regular, ShieldKeyhole20Regular, ShieldLock20Regular,
  Folder20Regular,
} from '@fluentui/react-icons';
import { serviceByKey, serviceVisual, type ConfigStatus } from './service-catalog';
import { iconUrl } from '../ui/item-type-visual';
import { accentTint } from '../canvas/canvas-node-kit';

/**
 * Sovereignty boundary → theme-aware Loom accent var + section glyph. NO hex
 * palette: each accent resolves to a `--loom-accent-*` defined (light + dark)
 * in app/globals.css, so the subscription chrome tracks the theme. IL5 uses the
 * Fluent red-palette token (the kit's 5 accents are blue/violet/teal/magenta/
 * amber — there is no danger-red accent, so we pull the token directly).
 */
interface BoundaryVisual {
  accent: string;
  icon: React.ReactElement;
}
const BOUNDARY_VISUAL: Record<string, BoundaryVisual> = {
  'Commercial': { accent: 'var(--loom-accent-blue)', icon: <CloudCube20Regular /> },
  'GCC': { accent: 'var(--loom-accent-violet)', icon: <ShieldKeyhole20Regular /> },
  'GCC-High': { accent: 'var(--loom-accent-violet)', icon: <ShieldKeyhole20Regular /> },
  'IL5': { accent: tokens.colorPaletteRedForeground1, icon: <ShieldLock20Regular /> },
};
const DEFAULT_BOUNDARY: BoundaryVisual = BOUNDARY_VISUAL['Commercial'];

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

// =============================================================================
// Shared, token-only node chrome (rich + elevated, theme-aware light + dark).
// Geometry contracts kept verbatim: subscription default 360x240, domain
// default 300x150, service fixed 132 wide / 40 tall, and the 8px handle dot.
// =============================================================================

const useNodeStyles = makeStyles({
  // ── Subscription container (boundary-tinted, elevated) ──────────────────────
  subscription: {
    boxSizing: 'border-box',
    borderRadius: tokens.borderRadiusXLarge,
    // Complete `border` shorthand keeps Griffel happy; the boundary accent (or
    // brand-selected) colour is layered on via an inline `borderColor`.
    border: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  subscriptionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    // Accent-tinted divider colour layered on via inline `borderBottomColor`.
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderTopLeftRadius: tokens.borderRadiusLarge,
    borderTopRightRadius: tokens.borderRadiusLarge,
  },
  boundaryChip: {
    flexShrink: 0,
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subscriptionName: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },

  // ── Domain container (framed, neutral) ──────────────────────────────────────
  domain: {
    boxSizing: 'border-box',
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  // Dashed (unselected) vs. solid brand (selected) — each a complete shorthand.
  domainDashed: { border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}` },
  domainSolid: { border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}` },
  domainHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    justifyContent: 'space-between',
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  domainHeaderLead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  domainIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  domainName: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  domainCount: { flexShrink: 0, color: tokens.colorNeutralForeground3 },

  // ── Service leaf (icon-forward card, elevation-on-hover) ────────────────────
  service: {
    boxSizing: 'border-box',
    width: '132px',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8, transform: 'translateY(-1px)' },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  serviceSelected: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow8,
  },
  serviceLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  statusIcon: { flexShrink: 0 },
  statusDot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
  },
});

function SubscriptionNodeImpl({ data, width, height, selected }: NodeProps) {
  const styles = useNodeStyles();
  const d = data as SubscriptionNodeData;
  const boundaryLabel = d.boundary || 'Commercial';
  const bv = BOUNDARY_VISUAL[boundaryLabel] || DEFAULT_BOUNDARY;
  return (
    <div
      data-plan-subscription={d.name}
      className={styles.subscription}
      style={{
        width: width ?? 360, height: height ?? 240,
        borderColor: selected ? tokens.colorBrandStroke1 : bv.accent,
        background: accentTint(bv.accent, 5),
      }}
    >
      <div
        className={styles.subscriptionHeader}
        style={{
          background: accentTint(bv.accent, 10),
          borderBottomColor: accentTint(bv.accent, 25),
        }}
      >
        <span className={styles.boundaryChip} style={{ background: accentTint(bv.accent, 16), color: bv.accent }} aria-hidden="true">
          {bv.icon}
        </span>
        <span className={styles.subscriptionName}>{d.name}</span>
        <Badge
          appearance="tint"
          size="small"
          style={{ backgroundColor: accentTint(bv.accent, 14), color: bv.accent, borderColor: accentTint(bv.accent, 28) }}
        >
          {boundaryLabel}
        </Badge>
        {d.region && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.region}</Caption1>}
      </div>
    </div>
  );
}

function DomainNodeImpl({ data, width, height, selected }: NodeProps) {
  const styles = useNodeStyles();
  const d = data as DomainNodeData;
  return (
    <div
      data-plan-domain={d.name}
      className={mergeClasses(styles.domain, selected ? styles.domainSolid : styles.domainDashed)}
      style={{ width: width ?? 300, height: height ?? 150 }}
    >
      <div className={styles.domainHeader}>
        <span className={styles.domainHeaderLead}>
          <Folder20Regular className={styles.domainIcon} aria-hidden="true" />
          <span className={styles.domainName}>{d.name}</span>
        </span>
        <Caption1 className={styles.domainCount}>{d.serviceCount} svc</Caption1>
      </div>
    </div>
  );
}

function ServiceNodeImpl({ data, selected }: NodeProps) {
  const styles = useNodeStyles();
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
      className={mergeClasses(styles.service, selected && styles.serviceSelected)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} isConnectable />
      <ServiceIconChip def={def} vis={vis} Glyph={Glyph} remote={remote} size={26} iconPx={16} radius={6} />
      <span className={styles.serviceLabel}>{vis.label}</span>
      {def?.config?.length ? (
        d.configStatus === 'configured' ? (
          <CheckmarkCircle12Filled aria-label="Configured" title="Configured"
            className={styles.statusIcon} style={{ color: tokens.colorPaletteGreenForeground1 }} />
        ) : d.configStatus === 'invalid' ? (
          <span role="img" aria-label="Invalid configuration" title="Invalid configuration — open to fix"
            className={styles.statusDot} style={{ background: tokens.colorPaletteRedBackground3 }} />
        ) : (
          <Circle12Regular aria-label="Needs configuration"
            title="Using defaults — select to review its SKU / tier"
            className={styles.statusIcon} style={{ color: tokens.colorNeutralForeground3 }} />
        )
      ) : null}
      {def?.planOnly && (
        <span role="img" aria-label="Plan-only — no one-button bicep toggle yet"
          title="Plan-only — no one-button bicep toggle yet"
          className={styles.statusDot} style={{ background: tokens.colorPaletteMarigoldBackground3 }} />
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
        // `vis.color` is the OFFICIAL Azure-service brand colour from the
        // catalog (not authored here). Wash it via color-mix instead of
        // string-concatenating a hex alpha suffix — works for any CSS colour
        // and matches the kit's token-only tinting convention.
        background: `color-mix(in srgb, ${vis.color} 12%, transparent)`, color: vis.color,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {showRemote ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={remote} alt="" width={iconPx} height={iconPx} style={{ borderRadius: tokens.borderRadiusSmall }}
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
