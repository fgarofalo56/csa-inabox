'use client';

/**
 * LoomLogo — uses the AI-generated raster mark at
 *   /brand/loom-logo.png      (primary, triple-spiral)
 *   /brand/loom-logo-alt-1.png (stylized L knot)
 *   /brand/loom-logo-alt-2.png (3-ring shield)
 *
 * Generated 2026-05-24 via atlas-media's image-gen pipeline
 * (gemini-2.5-flash-image / "nano banana") with a Fluid / Microsoft
 * Power Platform aesthetic prompt. Source PNGs live in this folder so
 * the brand asset is fully reproducible — re-generate by re-running
 * `temp/atlas-tools/run_extra.py` style scripts against atlas-media.
 *
 * The SVG fallback (icon variant only) renders if PNG fails to load
 * — keeps the topbar from looking broken in air-gapped renders.
 */

import { useState, useId } from 'react';

export interface LoomLogoProps {
  variant?: 'icon' | 'horizontal' | 'stacked';
  size?: number;
  showTagline?: boolean;
  /** Pick an alternate mark: 'primary' (default), 'alt-1', or 'alt-2'. */
  mark?: 'primary' | 'alt-1' | 'alt-2';
}

const MARK_SRC: Record<NonNullable<LoomLogoProps['mark']>, string> = {
  'primary': '/brand/loom-logo.png',
  'alt-1':   '/brand/loom-logo-alt-1.png',
  'alt-2':   '/brand/loom-logo-alt-2.png',
};

export function LoomLogo({
  variant = 'horizontal',
  size = 28,
  showTagline = false,
  mark = 'primary',
}: LoomLogoProps) {
  const uid = useId().replace(/:/g, '');
  const [failed, setFailed] = useState(false);

  const markEl = failed ? (
    // SVG fallback — minimal hex with gradient
    <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"
         role="img" aria-label="CSA Loom" style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id={`fb-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5e2ed1" />
          <stop offset="50%" stopColor="#1f6feb" />
          <stop offset="100%" stopColor="#28d2c2" />
        </linearGradient>
      </defs>
      <polygon points="32,2.5 58.5,17 58.5,47 32,61.5 5.5,47 5.5,17"
               fill={`url(#fb-${uid})`} />
      <circle cx="32" cy="32" r="3" fill="#ffffff" opacity="0.95" />
    </svg>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={MARK_SRC[mark]}
      width={size}
      height={size}
      alt="CSA Loom"
      onError={() => setFailed(true)}
      style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }}
    />
  );

  if (variant === 'icon') return markEl;

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
        {markEl}
        {wordmark}
      </div>
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {markEl}
      {wordmark}
    </div>
  );
}
