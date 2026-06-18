'use client';

/**
 * EmptyState — Fabric-style empty state with an illustration slot,
 * title, body, primary + secondary CTA. Used by every list/pane until
 * real data shows up.
 */

import { ReactNode } from 'react';
import { Subtitle1, Body1, Button, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXXL,
    paddingBottom: tokens.spacingVerticalXXXL,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    gap: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    minHeight: '320px',
  },
  illustration: {
    width: '88px',
    height: '88px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: '40px',
  },
  body: { color: tokens.colorNeutralForeground3, maxWidth: '480px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalM },
});

interface Action {
  label: string;
  onClick?: () => void;
  href?: string;
  appearance?: 'primary' | 'secondary' | 'outline' | 'transparent';
}

interface Props {
  icon?: ReactNode;
  title: string;
  body: string;
  primaryAction?: Action;
  secondaryAction?: Action;
}

export function EmptyState({ icon, title, body, primaryAction, secondaryAction }: Props) {
  const styles = useStyles();
  return (
    <div className={styles.root} role="status">
      <div className={styles.illustration} aria-hidden>{icon ?? '✦'}</div>
      <Subtitle1>{title}</Subtitle1>
      <Body1 className={styles.body}>{body}</Body1>
      {(primaryAction || secondaryAction) && (
        <div className={styles.actions}>
          {primaryAction && (
            <Button
              appearance={primaryAction.appearance ?? 'primary'}
              onClick={primaryAction.onClick}
              as={primaryAction.href ? 'a' : 'button'}
              {...(primaryAction.href ? { href: primaryAction.href } : {})}
            >
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              appearance={secondaryAction.appearance ?? 'secondary'}
              onClick={secondaryAction.onClick}
              as={secondaryAction.href ? 'a' : 'button'}
              {...(secondaryAction.href ? { href: secondaryAction.href } : {})}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
