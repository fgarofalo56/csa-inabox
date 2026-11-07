'use client';

/**
 * "Always on, not pausable" - the resources of this estate that keep billing while
 * the estate is paused, each with why and what it costs (#5099 phase C).
 *
 * Honest states, none of them blank:
 *   - loading            -> skeleton cards
 *   - inventory failed   -> a warning "inventory incomplete: <reason>", never an empty list
 *   - complete but empty -> a designed empty state saying nothing is always on
 *   - rows               -> one card each: name, type, cost (actual / estimate / unknown), reason
 *
 * COST HONESTY: a figure is never shown without its provenance. "actual month-to-date"
 * comes from Cost Management for that resource; "estimate (list price, East US)" is a
 * list price and is labelled an estimate on the badge AND in the detail; "cost unknown"
 * shows no number. The two kinds of figure are totalled separately, never added.
 *
 * The held-out Container Apps and pinned databases are NOT repeated here: their reasons
 * live in the "deliberately NOT paused" list above, which this section links to.
 */
import { useEffect, useState } from 'react';
import {
  Badge, Caption1, MessageBar, MessageBarBody, MessageBarTitle, Skeleton, SkeletonItem, Subtitle2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Power24Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { jsonGet } from '@/lib/components/admin-scaling/json-get';

interface AlwaysOnCost {
  source: 'actual-mtd' | 'estimate' | 'unknown';
  amount?: number;
  currency?: string;
  label: string;
  detail: string;
}
interface AlwaysOnRow {
  resourceId: string;
  name: string;
  resourceType: string;
  typeLabel: string;
  location?: string;
  reason: string;
  cost: AlwaysOnCost;
}
interface AlwaysOnData {
  rows: AlwaysOnRow[];
  incomplete: boolean;
  note?: string;
  costNote?: string;
  totals: {
    actualMtd: { amount: number; currency?: string; rows: number };
    estimateMonthly: { amount: number; currency: string; rows: number };
    unknownRows: number;
  };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  // A cost badge carries a long provenance label: let it wrap inside the card instead of overflowing it.
  costBadge: { maxWidth: '100%', height: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start' },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  headerIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', flexShrink: 0 },
  badgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  name: { minWidth: 0, overflowWrap: 'anywhere', fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', minWidth: 0 },
  skeletonCard: { padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge },
});

/** "$1,234.50" for a known currency; "1,234.50 (currency not reported)" otherwise. Pure, exported for the test. */
export function formatMoney(amount: number, currency?: string): string {
  const n = Number.isFinite(amount) ? amount : 0;
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(n);
    } catch {
      /* fall through */
    }
  }
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} (currency not reported)`;
}

/** The badge text: always carries the provenance, so colour is never the only signal. Pure, exported for the test. */
export function costBadgeText(cost: AlwaysOnCost): string {
  if (cost.source === 'unknown' || typeof cost.amount !== 'number') return 'cost unknown';
  if (cost.source === 'estimate') return `~${formatMoney(cost.amount, cost.currency)} / month, ${cost.label}`;
  return `${formatMoney(cost.amount, cost.currency)} ${cost.label}`;
}

const COST_COLOR: Record<AlwaysOnCost['source'], 'brand' | 'warning' | 'subtle'> = {
  'actual-mtd': 'brand',
  estimate: 'warning',
  unknown: 'subtle',
};

/** A response is only trusted if it has the shape we render; anything else is an incomplete inventory. */
function parse(j: any): { data?: AlwaysOnData; error?: string } {
  if (j && j.ok !== false && Array.isArray(j.rows) && typeof j.incomplete === 'boolean' && j.totals) return { data: j as AlwaysOnData };
  return { error: typeof j?.error === 'string' && j.error ? j.error : 'the always-on inventory returned an unexpected response' };
}

export function EstateAlwaysOnSection() {
  const s = useStyles();
  const [state, setState] = useState<{ loading: boolean; data?: AlwaysOnData; error?: string }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    void jsonGet('/api/admin/estate/always-on').then((j) => {
      if (!cancelled) setState({ loading: false, ...parse(j) });
    });
    return () => { cancelled = true; };
  }, []);

  const { loading, data, error } = state;

  return (
    <section data-testid="estate-always-on" aria-label="Always on, not pausable" className={s.root}>
      <div className={s.header}>
        <span className={s.headerIcon} aria-hidden><Power24Regular /></span>
        <Subtitle2>Always on, not pausable</Subtitle2>
      </div>
      <Caption1 className={s.muted}>
        These resources keep billing while the estate is paused. Each is listed with why Loom does not pause it and what it costs.
        Container Apps and databases that are held out of the pause set are listed above under
        {' '}<a href="#estate-held-out">&quot;deliberately NOT paused&quot;</a>.
      </Caption1>

      {loading && (
        <Skeleton aria-label="Loading the always-on inventory" data-testid="estate-always-on-loading">
          <TileGrid minTileWidth={320}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={s.skeletonCard}>
                <SkeletonItem size={16} />
                <SkeletonItem size={12} />
                <SkeletonItem size={12} />
              </div>
            ))}
          </TileGrid>
        </Skeleton>
      )}

      {!loading && (error || data?.incomplete) && (
        <MessageBar intent="warning" data-testid="estate-always-on-incomplete">
          <MessageBarBody>
            <MessageBarTitle>Always-on inventory incomplete</MessageBarTitle>
            {error ? `inventory incomplete: ${error}` : data?.note}
            {' '}This is not a statement that nothing is always on.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && data?.costNote && (
        <MessageBar intent="info" data-testid="estate-always-on-cost-note">
          <MessageBarBody>{data.costNote}</MessageBarBody>
        </MessageBar>
      )}

      {!loading && data && data.rows.length === 0 && !data.incomplete && (
        <div data-testid="estate-always-on-empty">
          <EmptyState
            icon={<Power24Regular />}
            title="Nothing always-on found for this estate"
            body="No Firewall, Bastion, gateway, API Management, Redis, AI Search, OpenAI, Event Hubs, Purview, Front Door or Container Registry carries this estate's tag, so nothing outside the pause set is known to be billing."
          />
        </div>
      )}

      {!loading && data && data.rows.length > 0 && (
        <>
          <div className={s.badgeRow} data-testid="estate-always-on-totals">
            <Badge appearance="tint" color="brand">
              actual month-to-date: {data.totals.actualMtd.rows > 0 ? formatMoney(data.totals.actualMtd.amount, data.totals.actualMtd.currency) : 'none read'} ({data.totals.actualMtd.rows})
            </Badge>
            <Badge appearance="tint" color="warning">
              estimate, list price per month: {data.totals.estimateMonthly.rows > 0 ? `~${formatMoney(data.totals.estimateMonthly.amount, data.totals.estimateMonthly.currency)}` : 'none'} ({data.totals.estimateMonthly.rows})
            </Badge>
            <Badge appearance="tint" color="subtle">cost unknown: {data.totals.unknownRows}</Badge>
          </div>
          <TileGrid minTileWidth={320}>
            {data.rows.map((r) => (
              <div key={r.resourceId} className={s.card} data-testid="estate-always-on-row">
                <div className={s.name}>{r.name}</div>
                <div className={s.badgeRow}>
                  <Badge appearance="outline" color="informative">{r.typeLabel}</Badge>
                  {r.location && <Badge appearance="outline" color="subtle">{r.location}</Badge>}
                </div>
                <div className={s.badgeRow}>
                  <Badge appearance="tint" color={COST_COLOR[r.cost.source]} className={s.costBadge} data-testid="estate-always-on-cost">
                    {costBadgeText(r.cost)}
                  </Badge>
                </div>
                <Caption1 className={s.muted}>{r.reason}</Caption1>
                <Caption1 className={s.muted}>{r.cost.detail}</Caption1>
              </div>
            ))}
          </TileGrid>
        </>
      )}
    </section>
  );
}
