'use client';

/**
 * teaching-toast — dismissible per-surface teaching UI (PRP-ux-baseline-program
 * §3, SC-6). Fabric peppers its designers with teaching banners/toasts that
 * explain the next useful action ("Analyze your data — explore in a notebook,
 * SQL analytics endpoint, or eventhouse endpoint") with a dismiss control and a
 * Learn-more link (fabric-ux-observations §47, "Lakehouse explorer").
 *
 * Exports:
 *   • useTeachingToast(key)  — localStorage-backed dismiss state for a surface.
 *   • <TeachingBanner>       — an in-flow, dismissible teaching info banner keyed
 *                              per surface (auto-hides once dismissed, forever).
 *
 * Dismissal persists under `loom.teaching.<key>` so a user never re-sees a
 * banner they closed. SSR-safe (guards `window`). Every colour / space / radius
 * is a Fluent `tokens.*` value or a `--loom-accent-*` var — no raw px / hex.
 * This file has no default export.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Caption1, Body1, Button, Link, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss16Regular, Lightbulb20Regular, Open16Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { accentTint, accentGradient, LOOM_ACCENT } from './accent-tokens';

const STORAGE_PREFIX = 'loom.teaching.';

/** Read the persisted dismiss flag for a surface key (SSR-safe). */
function readDismissed(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(STORAGE_PREFIX + key, '1');
    else window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* storage may be unavailable (private mode / quota) — non-fatal. */
  }
}

export interface UseTeachingToast {
  /** True until the surface's teaching UI is dismissed. */
  visible: boolean;
  /** Persistently dismiss (hides on every future visit). */
  dismiss: () => void;
  /** Clear the persisted dismissal (teaching UI shows again). */
  reset: () => void;
}

/**
 * useTeachingToast — per-surface dismissible teaching state, persisted in
 * localStorage under `loom.teaching.<key>`. `visible` starts true and flips to
 * false once the persisted flag is read (post-mount, to stay hydration-safe).
 */
export function useTeachingToast(key: string): UseTeachingToast {
  // Start visible=true on both server and first client render (no persisted read
  // during SSR) → identical markup → no hydration mismatch. The effect then
  // reconciles from localStorage.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (readDismissed(key)) setVisible(false);
  }, [key]);

  const dismiss = useCallback(() => {
    writeDismissed(key, true);
    setVisible(false);
  }, [key]);

  const reset = useCallback(() => {
    writeDismissed(key, false);
    setVisible(true);
  }, [key]);

  return { visible, dismiss, reset };
}

const useStyles = makeStyles({
  banner: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
  },
  iconChip: {
    flexShrink: 0,
    width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  text: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  message: { color: tokens.colorNeutralForeground2 },
  learnRow: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, marginTop: tokens.spacingVerticalXXS },
  dismissBtn: { flexShrink: 0 },
});

export interface TeachingBannerProps {
  /** Stable per-surface key — the dismissal is persisted under this. */
  surfaceKey: string;
  /** Bold lead line, e.g. "Analyze your data". */
  title?: ReactNode;
  /** The teaching message. */
  message: ReactNode;
  /** Icon glyph (default lightbulb). */
  icon?: FluentIcon;
  /** Accent CSS var for the icon chip (default teal). */
  accent?: string;
  /** Learn-more link target. */
  learnMoreHref?: string;
  learnMoreLabel?: string;
  /** Hide the dismiss (X) control (banner then always shows). Default false. */
  nonDismissible?: boolean;
}

/**
 * TeachingBanner — an in-flow, dismissible teaching info banner. Renders nothing
 * once dismissed (persisted). Place it at the top of a surface's content.
 */
export function TeachingBanner({
  surfaceKey, title, message, icon, accent = LOOM_ACCENT.teal,
  learnMoreHref, learnMoreLabel = 'Learn more', nonDismissible = false,
}: TeachingBannerProps) {
  const s = useStyles();
  const { visible, dismiss } = useTeachingToast(surfaceKey);
  const Icon = icon ?? Lightbulb20Regular;

  if (!nonDismissible && !visible) return null;

  return (
    <div
      className={s.banner}
      style={{ background: accentGradient(accent) }}
      role="note"
      data-teaching-banner={surfaceKey}
    >
      <span
        className={s.iconChip}
        style={{ background: accentTint(accent, 18), color: accent, border: `1px solid ${accentTint(accent, 30)}` }}
        aria-hidden="true"
      >
        <Icon />
      </span>
      <span className={s.text}>
        {title != null && <Body1 style={{ fontWeight: tokens.fontWeightSemibold }}>{title}</Body1>}
        <Caption1 className={s.message}>{message}</Caption1>
        {learnMoreHref && (
          <Link className={s.learnRow} href={learnMoreHref} target="_blank" rel="noopener noreferrer">
            {learnMoreLabel} <Open16Regular />
          </Link>
        )}
      </span>
      {!nonDismissible && (
        <Button
          className={s.dismissBtn}
          appearance="subtle"
          size="small"
          icon={<Dismiss16Regular />}
          aria-label="Dismiss this tip"
          onClick={dismiss}
        />
      )}
    </div>
  );
}
