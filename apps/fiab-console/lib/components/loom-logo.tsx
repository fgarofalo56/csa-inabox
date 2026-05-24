'use client';

/**
 * LoomLogo — CSA Loom brand mark + wordmark.
 *
 * Visual concept (Fabric-inspired, branded for CSA):
 *   - Hex outer frame (Fabric uses hex)
 *   - Interlocked weave inside: 3 horizontal "warp" threads + 3 diagonal
 *     "weft" threads forming a stylized L (for Loom)
 *   - CSA brand: indigo + amber gradient
 *   - Wordmark: "CSA Loom" in semibold + small-caps "Cloud Scale Analytics"
 *     subtitle, with tagline.
 *
 * Why "Loom": the platform weaves every Azure data service (Synapse,
 * Databricks, ADF, U-SQL, Fabric workloads) into one experience —
 * threads of compute, storage, and governance pulled through a single
 * shuttle. Tagline reinforces this.
 */

import { tokens } from '@fluentui/react-components';

export interface LoomLogoProps {
  /** "icon" = just the hex mark, "horizontal" = mark + wordmark inline,
   *  "stacked" = mark above wordmark. */
  variant?: 'icon' | 'horizontal' | 'stacked';
  /** px height of the mark. Wordmark scales proportionally. */
  size?: number;
  /** Show the "Cloud Scale Analytics" subtitle + tagline. */
  showTagline?: boolean;
  /** Override mark colors (e.g. all-white for dark topbars). */
  monochromeColor?: string;
}

const GRADIENT_ID = 'csa-loom-mark-grad';

export function LoomLogo({
  variant = 'horizontal',
  size = 28,
  showTagline = false,
  monochromeColor,
}: LoomLogoProps) {
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="CSA Loom"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3d2e80" />
          <stop offset="55%" stopColor="#1f6feb" />
          <stop offset="100%" stopColor="#d89f3d" />
        </linearGradient>
      </defs>
      {/* Hex frame */}
      <polygon
        points="16,1.5 29,9 29,23 16,30.5 3,23 3,9"
        fill={monochromeColor ?? `url(#${GRADIENT_ID})`}
        opacity={monochromeColor ? 1 : 0.95}
      />
      {/* Inner hex cutout for depth */}
      <polygon
        points="16,4.5 26.4,10.5 26.4,21.5 16,27.5 5.6,21.5 5.6,10.5"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="0.6"
      />
      {/* Weave: 3 horizontal warp + 3 diagonal weft, forming an implied L */}
      <g stroke={monochromeColor ? 'white' : 'white'} strokeWidth="1.6" strokeLinecap="round" opacity="0.95">
        <line x1="9" y1="11" x2="23" y2="11" />
        <line x1="9" y1="16" x2="23" y2="16" />
        <line x1="9" y1="21" x2="23" y2="21" />
      </g>
      <g stroke={monochromeColor ? 'white' : 'white'} strokeWidth="1.6" strokeLinecap="round" opacity="0.55">
        <line x1="11" y1="9" x2="20" y2="23" />
        <line x1="14" y1="9" x2="23" y2="23" />
        <line x1="9" y1="13" x2="17" y2="23" />
      </g>
    </svg>
  );

  if (variant === 'icon') return mark;

  const wordmark = (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: 1.1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: size * 0.65, fontWeight: 700, letterSpacing: '-0.01em' }}>CSA</span>
        <span style={{ fontSize: size * 0.65, fontWeight: 400, opacity: 0.85 }}>Loom</span>
      </div>
      {showTagline && (
        <>
          <span style={{
            fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
            fontWeight: 600, opacity: 0.75, marginTop: 2,
          }}>
            Cloud Scale Analytics
          </span>
          <span style={{ fontSize: 11, opacity: 0.7, marginTop: 1 }}>
            Weaving every Azure data service into one experience
          </span>
        </>
      )}
    </div>
  );

  if (variant === 'stacked') {
    return (
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        {mark}
        {wordmark}
      </div>
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {mark}
      {wordmark}
    </div>
  );
}
