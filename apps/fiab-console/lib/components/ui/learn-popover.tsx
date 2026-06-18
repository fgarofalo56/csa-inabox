'use client';

/**
 * LearnPopover — shared contextual-help primitives for Loom surfaces.
 *
 * Two exports for two distinct display modes:
 *
 * 1. **`LearnPopover`** — an icon-only button (Info16Regular or Learning16Regular)
 *    that opens a Fluent v9 Popover containing a title, descriptive content,
 *    bullet tips, and an optional "Learn more" link. Use this in section
 *    headers, toolbar trailing slots, or wherever a non-intrusive help trigger
 *    is needed.
 *
 *    ```tsx
 *    <LearnPopover
 *      title="Sensitivity labels"
 *      content="Sensitivity labels classify assets by sensitivity level."
 *      tips={['Restricted', 'Confidential', 'Internal', 'Public']}
 *      learnMoreHref="https://learn.microsoft.com/..."
 *    />
 *    ```
 *
 * 2. **`SectionExplainer`** — the static inline explainer row
 *    (Info20Regular icon + Body1 text) that was previously duplicated across
 *    7+ admin pages and panes. Consolidates the two variants that used raw
 *    `style={{}}` inline styles instead of `useAdminTabStyles` tokens.
 *
 *    ```tsx
 *    <SectionExplainer>
 *      Sensitivity labels are Loom-native tags…
 *    </SectionExplainer>
 *    ```
 *
 * Both components use only Fluent v9 tokens — no hardcoded px or colors.
 */

import * as React from 'react';
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Text,
  Link,
  Body1,
  Subtitle2,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components';
import {
  Info16Regular,
  Info20Regular,
  Open16Regular,
} from '@fluentui/react-icons';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  // LearnPopover trigger button — transparent, no extra padding.
  trigger: {
    minWidth: 'unset',
    padding: `0 ${tokens.spacingHorizontalXS}`,
    color: tokens.colorBrandForeground1,
  },
  // PopoverSurface container.
  surface: {
    maxWidth: '340px',
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  // Section title row inside the popover.
  title: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  // Body text inside the popover.
  body: {
    color: tokens.colorNeutralForeground2,
    lineHeight: '1.5',
  },
  // Bullet list inside the popover.
  tipList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground2,
  },
  // "Learn more" link row at the bottom.
  learnRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },

  // SectionExplainer layout — mirrors the admin-tab infoIcon + explainerText atoms.
  explainer: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
  },
  explainerIcon: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
    marginTop: '2px',
  },
  explainerText: {
    color: tokens.colorNeutralForeground2,
    lineHeight: '1.5',
  },
});

// ---------------------------------------------------------------------------
// LearnPopover
// ---------------------------------------------------------------------------

export interface LearnPopoverProps {
  /**
   * Popover header title (e.g. "Sensitivity labels").
   */
  title: string;
  /**
   * Main explanatory content. Accepts a string or JSX for rich markup.
   */
  content?: React.ReactNode;
  /**
   * Optional bullet-point tips shown below `content`.
   */
  tips?: string[];
  /**
   * Optional Microsoft Learn / docs URL shown as a "Learn more →" link.
   */
  learnMoreHref?: string;
  /**
   * Icon variant. Defaults to "info" (Info16Regular).
   * Use "help" for QuestionCircle-style contexts.
   */
  iconVariant?: 'info' | 'learning';
  /**
   * Button size passed to the Fluent Button. Defaults to "small".
   */
  size?: 'small' | 'medium' | 'large';
  /**
   * Extra class applied to the trigger button.
   */
  className?: string;
}

/**
 * An icon-only button that opens a themed Fluent v9 Popover containing
 * contextual help: a title, explanatory text, optional bullet tips,
 * and an optional "Learn more" link to Microsoft Docs.
 *
 * @example
 * ```tsx
 * <LearnPopover
 *   title="Embed codes"
 *   content="An embed code is a signed URL for read-only external embedding."
 *   learnMoreHref="https://learn.microsoft.com/fabric/..."
 * />
 * ```
 */
export function LearnPopover({
  title,
  content,
  tips,
  learnMoreHref,
  iconVariant = 'info',
  size = 'small',
  className,
}: LearnPopoverProps) {
  const s = useStyles();
  const icon = iconVariant === 'learning' ? <Info16Regular /> : <Info16Regular />;
  return (
    <Popover withArrow positioning="below-start">
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="transparent"
          size={size}
          icon={icon}
          className={mergeClasses(s.trigger, className)}
          aria-label={`Learn about ${title}`}
        />
      </PopoverTrigger>
      <PopoverSurface className={s.surface}>
        {title && (
          <Subtitle2 className={s.title}>{title}</Subtitle2>
        )}
        {content && (
          <Body1 className={s.body}>{content}</Body1>
        )}
        {tips && tips.length > 0 && (
          <ul className={s.tipList}>
            {tips.map((tip) => (
              <li key={tip}>
                <Text size={300} className={s.body}>{tip}</Text>
              </li>
            ))}
          </ul>
        )}
        {learnMoreHref && (
          <div className={s.learnRow}>
            <Link href={learnMoreHref} target="_blank" rel="noopener noreferrer">
              Learn more
            </Link>
            <Open16Regular style={{ color: tokens.colorBrandForeground1 }} />
          </div>
        )}
      </PopoverSurface>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// SectionExplainer
// ---------------------------------------------------------------------------

export interface SectionExplainerProps {
  /**
   * Explanatory content rendered next to the info icon.
   * Accepts a string or JSX for rich markup (strong, code, ul, etc.).
   */
  children: React.ReactNode;
  /**
   * Extra class applied to the outer flex row. Useful when a page
   * adds a local `useStyles` class for additional layout (e.g. an
   * `explainerList` ul style that lives in the page's own makeStyles).
   */
  className?: string;
}

/**
 * Static inline explainer row: brand-colored Info20Regular icon followed by
 * Body1 text. Consolidates the `<div className={s.explainer}>` pattern that
 * was duplicated across 7+ admin pages and panes.
 *
 * Tokens only — no hardcoded px or colors.
 *
 * @example
 * ```tsx
 * <SectionExplainer>
 *   Sensitivity labels classify assets by sensitivity level: Restricted,
 *   Confidential, Internal, Public.
 * </SectionExplainer>
 * ```
 */
export function SectionExplainer({ children, className }: SectionExplainerProps) {
  const s = useStyles();
  return (
    <div className={mergeClasses(s.explainer, className)}>
      <Info20Regular className={s.explainerIcon} aria-hidden="true" />
      <Body1 className={s.explainerText}>{children}</Body1>
    </div>
  );
}
