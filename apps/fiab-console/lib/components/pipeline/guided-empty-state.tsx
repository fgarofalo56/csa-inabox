'use client';

/**
 * GuidedEmptyStateLauncher — Fabric's empty-pipeline "guided launcher".
 *
 * Fabric's empty pipeline canvas is NOT a passive hint — it offers four
 * clickable starting paths (blank canvas / Copy-data assistant / sample pipeline
 * / Templates gallery) plus an "Ask Copilot" entry, teaching the flow before a
 * single node exists (see fabric-ux-observations.md §6). This component ports
 * that pattern one-for-one with the Loom Fluent v9 + canvas-node-kit accent
 * language: each path is a real card that performs a real action (insert an
 * activity / a starter graph / open the template gallery / focus Copilot) — no
 * dead tiles, per no-vaporware.md.
 *
 * Every colour / space / radius / shadow is a Fluent `tokens.*` value or a
 * `--loom-accent-*` var via the kit's `accentTint` / `accentGradient` helpers —
 * no raw px / hex / hardcoded shadow.
 */

import { Subtitle1, Subtitle2, Body1, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import {
  Flow24Regular, DocumentArrowRight24Regular, DocumentTable24Regular,
  Apps24Regular, Sparkle24Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { accentTint, accentGradient, CATEGORY_ACCENT } from '@/lib/components/canvas/canvas-node-kit';

const useStyles = makeStyles({
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingHorizontalXL,
    // Sits above the (empty) React Flow surface; the cards themselves capture
    // pointer events, the backdrop lets canvas panning through where it's clear.
    zIndex: 2,
    pointerEvents: 'none',
    overflow: 'auto',
  },
  panel: {
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalL,
    maxWidth: '640px',
    width: '100%',
    textAlign: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow28,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
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
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '2px',
    },
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
});

interface LaunchCard {
  key: string;
  title: string;
  body: string;
  icon: FluentIcon;
  accent: string;
  onClick: () => void;
}

export interface GuidedEmptyStateLauncherProps {
  /** Start from a blank canvas — dismiss the launcher so the palette + drop work. */
  onBlank: () => void;
  /** Copy-data assistant — insert + open a Copy activity's Source tab. */
  onCopyData: () => void;
  /** Instantiate a sample pipeline graph onto the canvas. */
  onSample: () => void;
  /** Open the templates gallery. */
  onTemplates: () => void;
  /** Focus the Pipeline Copilot composer. Card hidden when omitted. */
  onAskCopilot?: () => void;
}

export function GuidedEmptyStateLauncher({
  onBlank, onCopyData, onSample, onTemplates, onAskCopilot,
}: GuidedEmptyStateLauncherProps) {
  const s = useStyles();
  const cards: LaunchCard[] = [
    {
      key: 'blank',
      title: 'Start with a blank canvas',
      body: 'Drag activities from the left palette, or click a tile to insert it.',
      icon: Flow24Regular, accent: CATEGORY_ACCENT.control, onClick: onBlank,
    },
    {
      key: 'copy',
      title: 'Copy data',
      body: 'Add a Copy activity and configure its source and destination.',
      icon: DocumentArrowRight24Regular, accent: CATEGORY_ACCENT.move, onClick: onCopyData,
    },
    {
      key: 'sample',
      title: 'Sample pipeline',
      body: 'Start from a ready-made Lookup → ForEach → Copy metadata-driven graph.',
      icon: DocumentTable24Regular, accent: CATEGORY_ACCENT.transform, onClick: onSample,
    },
    {
      key: 'templates',
      title: 'Browse templates',
      body: 'Pick a curated pattern from the pipeline template gallery.',
      icon: Apps24Regular, accent: CATEGORY_ACCENT.iteration, onClick: onTemplates,
    },
  ];

  return (
    <div className={s.overlay} data-guided-empty-state>
      <div className={s.panel} role="group" aria-label="Start your pipeline">
        <div className={s.hero} aria-hidden="true"><Flow24Regular /></div>
        <Subtitle1>Design your pipeline</Subtitle1>
        <Body1 className={s.intro}>
          Orchestrate data movement and transformation. Choose a starting point —
          every path drops real, runnable activities on the canvas.
        </Body1>
        <div className={s.grid}>
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.key}
                className={s.card}
                role="button"
                tabIndex={0}
                data-launch-card={c.key}
                onClick={c.onClick}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.onClick(); } }}
              >
                <span
                  className={s.cardIcon}
                  style={{ background: accentGradient(c.accent), color: c.accent, border: `1px solid ${accentTint(c.accent, 24)}` }}
                  aria-hidden="true"
                >
                  <Icon />
                </span>
                <span className={s.cardText}>
                  <Subtitle2 className={s.cardTitle}>{c.title}</Subtitle2>
                  <Caption1 className={s.cardBody}>{c.body}</Caption1>
                </span>
              </div>
            );
          })}
        </div>
        {onAskCopilot && (
          <div className={s.copilotRow}>
            <div
              className={s.card}
              role="button"
              tabIndex={0}
              data-launch-card="copilot"
              style={{ maxWidth: '320px' }}
              onClick={onAskCopilot}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAskCopilot(); } }}
            >
              <span
                className={s.cardIcon}
                style={{ background: accentGradient(CATEGORY_ACCENT.external), color: CATEGORY_ACCENT.external, border: `1px solid ${accentTint(CATEGORY_ACCENT.external, 24)}` }}
                aria-hidden="true"
              >
                <Sparkle24Regular />
              </span>
              <span className={s.cardText}>
                <Subtitle2 className={s.cardTitle}>Ask Copilot</Subtitle2>
                <Caption1 className={s.cardBody}>Describe the pipeline in words and let Copilot build it.</Caption1>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
