'use client';

/**
 * ObjectFacetCharts (WS-4.7) — the Object Explorer's facet / histogram panel.
 *
 * Presentation only over {@link FacetChart}[] computed by lib/foundry/object-facets
 * from the REAL AGE instance rows the explorer already fetched (no mock, no
 * extra network call). Each property renders as an elevated card with horizontal
 * mini bars — the same bar chrome the DataProfiling column-distribution surface
 * uses, so the explorer reads as the same product (web3-ui.md). Clicking a bar
 * toggles a property-type-aware filter (category value / numeric range / time
 * bucket / boolean) which the parent applies to the instance list.
 */
import {
  Subtitle2, Body1Strong, Caption1, Badge, Tooltip, Spinner,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import type { ReactElement } from 'react';
import {
  DataHistogram20Regular, TextCaseTitle20Regular, NumberSymbol20Regular,
  CalendarLtr20Regular, ToggleLeft20Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import {
  filterFromBin, sameFilter,
  type FacetChart, type FacetBin, type FacetFilter, type FacetKind,
} from '@/lib/foundry/object-facets';

const KIND_ICON: Record<FacetKind, ReactElement> = {
  category: <TextCaseTitle20Regular />,
  histogram: <NumberSymbol20Regular />,
  timebucket: <CalendarLtr20Regular />,
  boolean: <ToggleLeft20Regular />,
};
const KIND_LABEL: Record<FacetKind, string> = {
  category: 'Values', histogram: 'Distribution', timebucket: 'Over time', boolean: 'True / false',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  headIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  colIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorBrandForeground1,
  },
  colName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badges: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  dist: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  bar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalXXS, borderRadius: tokens.borderRadiusSmall,
    border: `1px solid transparent`, cursor: 'pointer', background: 'none', textAlign: 'left',
    // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },
  },
  barActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2 },
  barValue: {
    flexShrink: 0, width: '112px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200,
  },
  barTrack: {
    flex: 1, minWidth: 0, height: '14px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall, overflow: 'hidden',
  },
  barFill: {
    height: '100%', minWidth: '2px',
    backgroundImage: `linear-gradient(90deg, ${tokens.colorBrandBackground}, ${tokens.colorBrandBackground2Hover})`,
    borderRadius: tokens.borderRadiusSmall,
    transitionProperty: 'width', transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  barCount: {
    flexShrink: 0, minWidth: '68px', textAlign: 'right',
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  blank: { fontStyle: 'italic', color: tokens.colorNeutralForeground4 },
  muted: { color: tokens.colorNeutralForeground3 },
  loading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
});

function fmtInt(n: number): string { return Math.round(n).toLocaleString(); }

export interface ObjectFacetChartsProps {
  charts: FacetChart[];
  activeFilters: FacetFilter[];
  onToggle: (filter: FacetFilter) => void;
  busy?: boolean;
}

/** The facet / histogram panel — one card per property, click a bar to filter. */
export function ObjectFacetCharts({ charts, activeFilters, onToggle, busy }: ObjectFacetChartsProps) {
  const s = useStyles();

  const header = (
    <div className={s.head}>
      <span className={s.headIcon} aria-hidden="true"><DataHistogram20Regular /></span>
      <Subtitle2>Facets &amp; histograms</Subtitle2>
      {busy && <span className={s.loading}><Spinner size="tiny" /> <Caption1>Aggregating…</Caption1></span>}
    </div>
  );

  if (!busy && charts.length === 0) {
    return (
      <div className={s.root}>
        {header}
        <Caption1 className={s.muted}>
          No chartable properties for these instances yet — define typed properties on the object type,
          or create instances that carry values.
        </Caption1>
      </div>
    );
  }

  return (
    <div className={s.root}>
      {header}
      <TileGrid minTileWidth={300}>
        {charts.map((c) => (
          <FacetCard key={c.apiName} chart={c} activeFilters={activeFilters} onToggle={onToggle} styles={s} />
        ))}
      </TileGrid>
    </div>
  );
}

function FacetCard({
  chart, activeFilters, onToggle, styles: s,
}: {
  chart: FacetChart;
  activeFilters: FacetFilter[];
  onToggle: (f: FacetFilter) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const maxCount = chart.bins.reduce((m, b) => Math.max(m, b.count || 0), 0) || 1;

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.colIcon} aria-hidden="true">{KIND_ICON[chart.kind]}</span>
        <Tooltip content={chart.apiName} relationship="label">
          <Body1Strong className={s.colName}>{chart.displayName}</Body1Strong>
        </Tooltip>
        <span className={s.badges}>
          <Badge appearance="outline" color="brand">{KIND_LABEL[chart.kind]}</Badge>
          {chart.distinct != null && <Badge appearance="tint" color="informative">{fmtInt(chart.distinct)} distinct</Badge>}
        </span>
      </div>
      <div className={s.dist}>
        {chart.bins.map((b, i) => (
          <FacetBar key={`${chart.apiName}-${b.value ?? b.lo ?? i}-${i}`}
            chart={chart} bin={b} maxCount={maxCount}
            active={isBinActive(chart, b, activeFilters)}
            onToggle={onToggle} styles={s} />
        ))}
      </div>
      {chart.truncated && (
        <Caption1 className={s.muted}>Top {chart.bins.length} of {chart.distinct} values.</Caption1>
      )}
    </div>
  );
}

function isBinActive(chart: FacetChart, bin: FacetBin, filters: FacetFilter[]): boolean {
  const f = filterFromBin(chart, bin);
  return !!f && filters.some((af) => sameFilter(af, f));
}

function FacetBar({
  chart, bin, maxCount, active, onToggle, styles: s,
}: {
  chart: FacetChart;
  bin: FacetBin;
  maxCount: number;
  active: boolean;
  onToggle: (f: FacetFilter) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const widthPct = Math.max(2, Math.round((bin.count / maxCount) * 100));
  const blank = bin.label === '(blank)';
  const filter = filterFromBin(chart, bin);
  return (
    <button
      type="button"
      className={mergeClasses(s.bar, active && s.barActive)}
      aria-pressed={active}
      disabled={!filter}
      onClick={() => filter && onToggle(filter)}
      title={`${bin.label} — ${fmtInt(bin.count)}`}
    >
      <span className={mergeClasses(s.barValue, blank && s.blank)}>{bin.label}</span>
      <span className={s.barTrack} aria-hidden="true">
        <span className={s.barFill} style={{ width: `${widthPct}%` }} />
      </span>
      <span className={s.barCount}>{fmtInt(bin.count)}</span>
    </button>
  );
}

export default ObjectFacetCharts;
