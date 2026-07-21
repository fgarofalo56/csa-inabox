'use client';

/**
 * StepWalkthrough — a polished, web3 visual step-by-step walkthrough.
 *
 * Renders a numbered vertical stepper where each step is a card carrying:
 *   • a numbered accent badge (keyed to the item family color),
 *   • a concise caption of what to do + an optional longer action detail,
 *   • the clean step screenshot — or, when that step hasn't been captured yet,
 *     an HONEST placeholder tile ("Screenshot coming") instead of a broken
 *     image (no_scaffold: we never fake a capture that doesn't exist).
 *
 * Fluent v9 + Loom tokens only (web3-ui: no hard-coded px / hex where a token
 * exists; dynamic family colors are the one allowed inline value). Reused by the
 * LearnTopicCard "View walkthrough" dialog and any surface that wants to show an
 * item's guided walkthrough inline.
 */

import * as React from 'react';
import {
  Text, Badge, Title3, Body1, Caption1, Button,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Open16Regular, BookOpen16Regular, ImageOff24Regular, Camera20Regular,
} from '@fluentui/react-icons';
import { itemVisual, readableAccent } from '@/lib/components/ui/item-type-visual';
import { useTheme } from '@/lib/theme/theme-context';
import type { WalkthroughStep } from '@/lib/learn/content';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },

  // Header band with the item icon, title, summary.
  head: {
    display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-start',
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '48px', borderRadius: tokens.borderRadiusLarge,
    flexShrink: 0, boxShadow: tokens.shadow4,
  },
  headText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  headSummary: { color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  headLinks: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
  primaryLink: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300, textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  secondaryLink: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    textDecorationLine: 'none', ':hover': { textDecorationLine: 'underline' },
  },

  // Steps list — a connective rail runs down the left through the number badges.
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  step: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  railCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXS },
  badge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '34px', height: '34px', borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForegroundOnBrand, fontWeight: tokens.fontWeightBold,
    fontSize: tokens.fontSizeBase300, flexShrink: 0, boxShadow: tokens.shadow4,
  },
  rail: { flex: 1, width: '2px', backgroundColor: tokens.colorNeutralStroke2, borderRadius: tokens.borderRadiusSmall, minHeight: tokens.spacingVerticalL },

  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    minWidth: 0,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, border-color',
    ':hover': { boxShadow: tokens.shadow8, border: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  cardCaption: { fontWeight: tokens.fontWeightSemibold, lineHeight: 1.3 },
  cardAction: { color: tokens.colorNeutralForeground2, lineHeight: 1.5 },

  // Screenshot frame — bounded, rounded, subtle border; image fits within.
  shotFrame: {
    position: 'relative', width: '100%', overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  shotImg: { display: 'block', width: '100%', height: 'auto', objectFit: 'contain' },

  // Honest "screenshot coming" placeholder (not a broken image).
  placeholder: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
  },
  placeholderIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '48px', borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground3,
  },
});

export interface StepWalkthroughProps {
  /** Item-type slug — resolves the family icon + accent color. */
  visualType: string;
  title: string;
  summary?: string;
  steps: WalkthroughStep[];
  /** PRIMARY doc link (full Loom guide), shown in the header. */
  docsUrl?: string;
  docsLabel?: string;
  /** SECONDARY MS Learn link, shown when distinct from the primary. */
  msLearnUrl?: string;
}

/** One step's clean screenshot, or an honest "coming" placeholder. */
function StepShot({ step }: { step: WalkthroughStep }): React.ReactElement {
  const s = useStyles();
  // Guard against a published thumbnail that 404s on the docs site.
  const [imgOk, setImgOk] = React.useState<boolean>(step.hasImage && !!step.imgUrl);
  if (step.hasImage && step.imgUrl && imgOk) {
    return (
      <div className={s.shotFrame}>
        <img
          className={s.shotImg}
          src={step.imgUrl}
          alt={`Step ${step.n}: ${step.caption}`}
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      </div>
    );
  }
  return (
    <div className={s.placeholder}>
      <span className={s.placeholderIcon} aria-hidden>
        {imgOk ? <Camera20Regular /> : <ImageOff24Regular />}
      </span>
      <Text size={200}>Screenshot coming for this step</Text>
      <Caption1>Regenerate with the tutorial-capture UAT to publish this step.</Caption1>
    </div>
  );
}

export function StepWalkthrough({
  visualType, title, summary, steps, docsUrl, docsLabel, msLearnUrl,
}: StepWalkthroughProps): React.ReactElement {
  const s = useStyles();
  const { mode } = useTheme();
  const visual = itemVisual(visualType);
  const fg = readableAccent(visual.color, mode === 'dark');
  const Icon = visual.icon;
  const captured = steps.filter((st) => st.hasImage).length;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span
          className={s.headIcon}
          style={{ background: `linear-gradient(135deg, ${fg}26 0%, ${fg}0d 100%)`, color: fg }}
          aria-hidden
        >
          <Icon />
        </span>
        <div className={s.headText}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
            <Title3>{title}</Title3>
            <Badge appearance="tint" color="brand">{steps.length} steps</Badge>
            <Badge appearance="outline" color={captured === steps.length ? 'success' : 'informative'}>
              {captured}/{steps.length} captured
            </Badge>
          </div>
          {summary && <Body1 className={s.headSummary}>{summary}</Body1>}
          {(docsUrl || msLearnUrl) && (
            <div className={s.headLinks}>
              {docsUrl && (
                <a className={s.primaryLink} href={docsUrl} target="_blank" rel="noreferrer">
                  <BookOpen16Regular />{docsLabel ?? 'Open the full guide'}<Open16Regular />
                </a>
              )}
              {msLearnUrl && (
                <a className={s.secondaryLink} href={msLearnUrl} target="_blank" rel="noreferrer">
                  MS Learn <Open16Regular />
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={s.steps}>
        {steps.map((step, i) => (
          <div className={s.step} key={step.n}>
            <div className={s.railCol}>
              <span
                className={s.badge}
                style={{ backgroundColor: visual.color }}
                aria-hidden
              >
                {step.n}
              </span>
              {i < steps.length - 1 && <span className={s.rail} aria-hidden />}
            </div>
            <div className={s.card}>
              <div>
                <Text className={mergeClasses(s.cardCaption)} size={400}>{step.caption}</Text>
                {step.action && <Body1 className={s.cardAction}>{step.action}</Body1>}
              </div>
              <StepShot step={step} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default StepWalkthrough;
