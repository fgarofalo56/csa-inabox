'use client';

/**
 * CloudBadge — always-visible cloud-boundary assurance in the app header
 * (operator ask 2026-07-14): users see at a glance whether this Loom runs in
 * Commercial, GCC, GCC-High (Azure Government), or DoD, so there is never
 * doubt about which sovereignty boundary their data operations execute in.
 *
 * Reads /api/cloud (unauthenticated, derived from the same detectLoomCloud()
 * that routes every Azure client), renders once resolved — no flicker, no
 * guess. Distinct color per boundary; tooltip carries the full sentence +
 * region when the deployment stamped one.
 */

import * as React from 'react';
import { Badge, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

const useStyles = makeStyles({
  badge: {
    marginLeft: tokens.spacingHorizontalS,
    flexShrink: 0,
    cursor: 'default',
  },
});

type LoomCloud = 'Commercial' | 'GCC' | 'GCC-High' | 'DoD';

const BADGE_STYLE: Record<LoomCloud, {
  color: 'brand' | 'informative' | 'success' | 'severe';
  appearance: 'tint' | 'filled';
  label: string;
  full: string;
}> = {
  Commercial: {
    color: 'brand', appearance: 'tint', label: 'Commercial',
    full: 'Running in Azure Commercial cloud',
  },
  GCC: {
    color: 'informative', appearance: 'filled', label: 'GCC',
    full: 'Running in Azure Government Community Cloud (GCC — Commercial endpoints)',
  },
  'GCC-High': {
    color: 'success', appearance: 'filled', label: 'GCC-High',
    full: 'Running in Azure Government (GCC-High) — US sovereign cloud boundary',
  },
  DoD: {
    color: 'severe', appearance: 'filled', label: 'DoD',
    full: 'Running in Azure Government (DoD / IL5) — US DoD sovereign cloud boundary',
  },
};

export function CloudBadge(): React.ReactElement | null {
  const styles = useStyles();
  const [cloud, setCloud] = React.useState<LoomCloud | null>(null);
  const [region, setRegion] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    clientFetch('/api/cloud')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.cloud || !(d.cloud in BADGE_STYLE)) return;
        setCloud(d.cloud as LoomCloud);
        setRegion(typeof d.region === 'string' && d.region ? d.region : null);
      })
      .catch(() => { /* badge is best-effort — never break the header */ });
    return () => { cancelled = true; };
  }, []);

  if (!cloud) return null;
  const s = BADGE_STYLE[cloud];
  return (
    <Tooltip content={region ? `${s.full} · ${region}` : s.full} relationship="label">
      <Badge
        className={styles.badge}
        appearance={s.appearance}
        color={s.color}
        size="medium"
        shape="rounded"
        aria-label={s.full}
        data-testid="cloud-badge"
      >
        {s.label}
      </Badge>
    </Tooltip>
  );
}
