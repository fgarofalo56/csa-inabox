'use client';

/**
 * StaleDataBadge — a subtle "serving cached data while it refreshes" indicator
 * for the observability surfaces (usage / chargeback / audit / copilot-usage /
 * monitor). Rendered when a route's `meta.stale` is true: the OBS-CACHE
 * stale-while-revalidate path served the last good value instantly and kicked a
 * background recompute, so the number on screen is a few minutes old and about
 * to update. Fluent v9 + Loom tokens only (no raw px).
 */

import { Badge, Caption1, tokens, makeStyles } from '@fluentui/react-components';
import { History16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
});

/** Coarse "N minutes/hours ago" from an epoch-ms timestamp. */
function relativeTime(cachedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - cachedAt) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
}

export function StaleDataBadge({ cachedAt }: { cachedAt?: number }) {
  const s = useStyles();
  const when = typeof cachedAt === 'number' ? relativeTime(cachedAt) : 'a moment ago';
  return (
    <span className={s.root}>
      <Badge appearance="tint" color="informative" size="small" icon={<History16Regular />}>
        Cached
      </Badge>
      <Caption1>data from {when} — refreshing…</Caption1>
    </span>
  );
}
