'use client';

/**
 * LoomLogo — CSA Loom brand mark + wordmark.
 *
 * v1.8 redesign: more Fluid / Microsoft Power Platform feel.
 *   - Hex frame (still Fabric-inspired) in deep navy
 *   - THREE overlapping gradient ribbons / "petals" rotated 120° apart,
 *     each with its own jewel gradient (indigo→azure, magenta→amber,
 *     teal→cyan). Creates the "woven" Loom feel via translucent
 *     overlap blending.
 *   - Central white sparkle for that Microsoft-design polish.
 *   - SVG <defs> use a stable + unique-per-instance ID so multiple
 *     logos on the same page don't fight over gradient definitions.
 *
 * Why this aesthetic: matches the new Microsoft Fabric / Power BI /
 * Power Platform / Copilot art direction — fluid overlapping shapes,
 * multi-color gradients, soft frame, central highlight. Distinctive
 * for CSA Loom but visually at home next to Fabric items.
 */

import { useId } from 'react';

export interface LoomLogoProps {
  variant?: 'icon' | 'horizontal' | 'stacked';
  size?: number;
  showTagline?: boolean;
  /** When true, render the mark in pure white for use on dark gradient backgrounds. */
  monochromeColor?: string;
}

export function LoomLogo({
  variant = 'horizontal',
  size = 28,
  showTagline = false,
  monochromeColor,
}: LoomLogoProps) {
  const uid = useId().replace(/:/g, '');
  const id = (k: string) => `csa-loom-${uid}-${k}`;

  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="CSA Loom"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        {/* Three jewel ribbon gradients (Microsoft Fluid palette) */}
        <linearGradient id={id('ribA')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5e2ed1" />
          <stop offset="55%" stopColor="#1f6feb" />
          <stop offset="100%" stopColor="#28d2c2" />
        </linearGradient>
        <linearGradient id={id('ribB')} x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#e94b8a" />
          <stop offset="60%" stopColor="#f08a3c" />
          <stop offset="100%" stopColor="#f5c93e" />
        </linearGradient>
        <linearGradient id={id('ribC')} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#0078d4" />
          <stop offset="100%" stopColor="#742774" />
        </linearGradient>
        {/* Hex backdrop gradient */}
        <linearGradient id={id('hex')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0b1228" />
          <stop offset="100%" stopColor="#1a1042" />
        </linearGradient>
        {/* Soft inner glow filter */}
        <filter id={id('soft')} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.3" />
        </filter>
        {/* Center highlight radial */}
        <radialGradient id={id('spark')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Hex frame */}
      <polygon
        points="32,2.5 58.5,17 58.5,47 32,61.5 5.5,47 5.5,17"
        fill={monochromeColor ?? `url(#${id('hex')})`}
      />
      {/* Subtle inner hex outline for depth */}
      <polygon
        points="32,7 53.5,19.5 53.5,44.5 32,57 10.5,44.5 10.5,19.5"
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="0.7"
      />

      {/* Three overlapping ribbon-petals, rotated 120° apart */}
      <g transform="translate(32 32)" filter={`url(#${id('soft')})`}>
        <ellipse
          cx="0" cy="-10" rx="9" ry="16"
          fill={monochromeColor ?? `url(#${id('ribA')})`}
          opacity={monochromeColor ? 0.85 : 0.92}
          transform="rotate(0)"
        />
        <ellipse
          cx="0" cy="-10" rx="9" ry="16"
          fill={monochromeColor ?? `url(#${id('ribB')})`}
          opacity={monochromeColor ? 0.75 : 0.82}
          transform="rotate(120)"
        />
        <ellipse
          cx="0" cy="-10" rx="9" ry="16"
          fill={monochromeColor ?? `url(#${id('ribC')})`}
          opacity={monochromeColor ? 0.65 : 0.78}
          transform="rotate(240)"
        />
      </g>

      {/* Center sparkle */}
      <circle cx="32" cy="32" r="5" fill={`url(#${id('spark')})`} />
      <circle cx="32" cy="32" r="1.8" fill="#ffffff" opacity="0.95" />
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
