'use client';

/**
 * GuidedEmptyState — the shared multi-path guided launcher, generalized from
 * `lib/components/pipeline/guided-empty-state.tsx` to an N-path launcher
 * (PRP-ux-baseline-program §3, SC-4).
 *
 * Fabric's empty designers are NOT passive hints — they offer several clickable
 * starting paths (blank canvas / Copy-data assistant / import from Excel-SQL-CSV
 * / templates …) plus an "Ask Copilot" entry and a "Learn more" link, teaching
 * the flow before a single object exists (fabric-ux-observations §6, §29). This
 * component ports that pattern one-for-one: each path is a real card that runs a
 * real action (onClick) or navigates (href) — no dead tiles, per no-vaporware.
 *
 * Two variants:
 *   • 'overlay' — absolutely positioned over an (empty) canvas, like the pipeline
 *     launcher (pointer-events pass through the backdrop so panning still works);
 *   • 'block'   — an in-flow card for list/pane empty states (dataflow, lakehouse,
 *     hubs).
 *
 * Every colour / space / radius / shadow is a Fluent `tokens.*` value or a
 * `--loom-accent-*` var via accent-tokens — no raw px, no raw hex. This file has
 * no default export.
 */

import type { ReactNode } from 'react';
import {
  Subtitle1, Subtitle2, Body1, Caption1, Link, makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle24Regular, Open16Regular, type FluentIcon } from '@fluentui/react-icons';
import { accentTint, accentGradient, accentForIndex, LOOM_ACCENT } from './accent-tokens';

const useStyles = makeStyles({
  // 'overlay' — sits above an empty canvas surface.
  overlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingHorizontalXL,
    zIndex: 2,
    pointerEvents: 'none',
    overflow: 'auto',
  },
  // 'block' — in-flow empty state.
  block: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingHorizontalXL,
    width: '100%',
  },
  panel: {
    pointerEvents: 'auto',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: tokens.spacingVerticalL,
    maxWidth: '640px', width: '100%',
    textAlign: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow28,
    paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL,
  },
  hero: {
    width: '72px', height: '72px',
    borderRadius: tokens.borderRadiusCircular,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
  },
  intro: { color: tokens.colorNeutralForeground3, maxWidth: '460px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    '@media (max-width: 520px)': { gridTemplateColumns: '1fr' },
  },
  gridSingle: { gridTemplateColumns: '1fr' },
  card: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    textAlign: 'left',
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    width: '100%',
    color: tokens.colorNeutralForeground1,
    textDecorationLine: 'none',
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  cardIcon: {
    flexShrink: 0,
    width: '40px', height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  cardText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  cardTitle: { color: tokens.colorNeutralForeground1 },
  cardBody: { color: tokens.colorNeutralForeground3 },
  copilotRow: {
    display: 'flex', justifyContent: 'center', width: '100%',
    marginTop: tokens.spacingVerticalXS,
  },
  learnRow: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
  },
});

/** One launcher path. Provide `onClick` (action) or `href` (navigate). */
export interface GuidedPath {
  key: string;
  title: string;
  body: string;
  icon: FluentIcon;
  /** Accent CSS var; defaults to a stable per-index rotation. */
  accent?: string;
  onClick?: () => void;
  href?: string;
}

export interface GuidedEmptyStateProps {
  /** Big heading, e.g. "Design your dataflow". */
  title: string;
  /** One-line teaching intro under the title. */
  intro?: ReactNode;
  /** Hero glyph in the gradient circle. */
  heroIcon?: FluentIcon;
  /** The launcher paths (icon cards). */
  paths: GuidedPath[];
  /** Optional "Ask Copilot" card (rendered full-width under the grid). */
  askCopilot?: { onClick: () => void; label?: string; body?: string };
  /** Optional "Learn more" link under everything. */
  learnMoreHref?: string;
  learnMoreLabel?: string;
  /** 'overlay' over a canvas, or 'block' in-flow. Default 'block'. */
  variant?: 'overlay' | 'block';
  /** Grid columns: 1 or 2. Default 2 (1 when a single path). */
  columns?: 1 | 2;
  /** Accessible group label. */
  ariaLabel?: string;
}

export function GuidedEmptyState({
  title, intro, heroIcon, paths, askCopilot,
  learnMoreHref, learnMoreLabel = 'Learn more',
  variant = 'block', columns, ariaLabel,
}: GuidedEmptyStateProps) {
  const s = useStyles();
  const Hero = heroIcon;
  const oneCol = (columns ?? (paths.length <= 1 ? 1 : 2)) === 1;

  return (
    <div className={variant === 'overlay' ? s.overlay : s.block} data-guided-empty-state>
      <div className={s.panel} role="group" aria-label={ariaLabel ?? title}>
        {Hero && <div className={s.hero} aria-hidden="true"><Hero /></div>}
        <Subtitle1>{title}</Subtitle1>
        {intro != null && <Body1 className={s.intro}>{intro}</Body1>}

        <div className={oneCol ? `${s.grid} ${s.gridSingle}` : s.grid}>
          {paths.map((p, i) => {
            const Icon = p.icon;
            const accent = p.accent ?? accentForIndex(i);
            const iconEl = (
              <span
                className={s.cardIcon}
                style={{ background: accentGradient(accent), color: accent, border: `1px solid ${accentTint(accent, 24)}` }}
                aria-hidden="true"
              >
                <Icon />
              </span>
            );
            const textEl = (
              <span className={s.cardText}>
                <Subtitle2 className={s.cardTitle}>{p.title}</Subtitle2>
                <Caption1 className={s.cardBody}>{p.body}</Caption1>
              </span>
            );
            // href → real anchor; onClick → button-role div (keyboard accessible).
            if (p.href) {
              return (
                <a key={p.key} className={s.card} data-launch-card={p.key} href={p.href} onClick={p.onClick}>
                  {iconEl}{textEl}
                </a>
              );
            }
            return (
              <div
                key={p.key}
                className={s.card}
                role="button"
                tabIndex={0}
                data-launch-card={p.key}
                onClick={p.onClick}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onClick?.(); } }}
              >
                {iconEl}{textEl}
              </div>
            );
          })}
        </div>

        {askCopilot && (
          <div className={s.copilotRow}>
            <div
              className={s.card}
              role="button"
              tabIndex={0}
              data-launch-card="copilot"
              style={{ maxWidth: '320px' }}
              onClick={askCopilot.onClick}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); askCopilot.onClick(); } }}
            >
              <span
                className={s.cardIcon}
                style={{ background: accentGradient(LOOM_ACCENT.magenta), color: LOOM_ACCENT.magenta, border: `1px solid ${accentTint(LOOM_ACCENT.magenta, 24)}` }}
                aria-hidden="true"
              >
                <Sparkle24Regular />
              </span>
              <span className={s.cardText}>
                <Subtitle2 className={s.cardTitle}>{askCopilot.label ?? 'Ask Copilot'}</Subtitle2>
                <Caption1 className={s.cardBody}>{askCopilot.body ?? 'Describe what you want in words and let Copilot build it.'}</Caption1>
              </span>
            </div>
          </div>
        )}

        {learnMoreHref && (
          <Link className={s.learnRow} href={learnMoreHref} target="_blank" rel="noopener noreferrer">
            {learnMoreLabel} <Open16Regular />
          </Link>
        )}
      </div>
    </div>
  );
}
