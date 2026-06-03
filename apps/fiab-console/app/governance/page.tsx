'use client';

/**
 * /governance — Governance overview, one-for-one with the Microsoft Purview
 * landing experience (Catalog management / Discovery / Data Map / Health
 * management). This is the answer to "what is the Governance tab for":
 *
 *   - Live posture KPIs (items, sensitivity/classification coverage, active
 *     policies, audit events) derived from the real Cosmos catalog +
 *     /api/governance/insights — no fake numbers.
 *   - Per-type coverage table (sortable / resizable / filterable) and the
 *     most-classified items, both from the same live insights payload.
 *   - Microsoft Purview connection status (live / not-wired / cross-cloud)
 *     via the shared PurviewGate probe.
 *   - A section grid mirroring Purview's left nav so every governance surface
 *     is one click away with a one-line "what it does".
 *   - The real tenant activity feed at the bottom.
 *
 * Web 3.0 standard (docs/fiab/design/ui-web3-guide.md): every collection lives
 * in a spaced, rounded Section card; stat/nav cards carry a color + icon chip
 * with breathing room; tabular data uses the LoomDataTable primitive (sort +
 * resize + filter); search is capped via Toolbar — no smushed tables.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, Caption1, Badge, Button, Text, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataTrending20Regular, Shield20Regular, Tag20Regular, Branch20Regular,
  DatabaseSearch20Regular, DocumentBulletList20Regular, Beaker20Regular,
  Open16Regular, ArrowSync20Regular, Box20Regular, ShieldCheckmark20Regular,
  History20Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface Kpis {
  totalItems: number; sensitiveCoveragePct: number; classificationCoveragePct: number;
  activePolicies: number; auditEvents30d: number;
}
interface CoverageRow { type: string; total: number; labeled: number; classified: number }
interface TopItem { id: string; displayName: string; itemType: string; count: number; classifications: string[] }
interface InsightsResponse { ok: boolean; kpis?: Kpis; coverage?: CoverageRow[]; topClassified?: TopItem[] }

/** A single KPI stat, with its own accent color + icon chip. */
interface StatDef {
  key: keyof Kpis;
  label: string;
  icon: FluentIcon;
  color: string;
  /** Render the value as a % with a coverage bar. */
  pct?: boolean;
}

// Accent palette echoes the governance/teal family used across Loom tiles.
const STATS: StatDef[] = [
  { key: 'totalItems', label: 'Governed items', icon: Box20Regular, color: '#0d7377' },
  { key: 'sensitiveCoveragePct', label: 'Sensitivity coverage', icon: Shield20Regular, color: '#7c3aed', pct: true },
  { key: 'classificationCoveragePct', label: 'Classification coverage', icon: Tag20Regular, color: '#0078d4', pct: true },
  { key: 'activePolicies', label: 'Active policies', icon: ShieldCheckmark20Regular, color: '#117865' },
  { key: 'auditEvents30d', label: 'Audit events (30d)', icon: History20Regular, color: '#c2410c' },
];

const useStyles = makeStyles({
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  statHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  chip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusLarge,
  },
  statVal: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1.1,
    color: tokens.colorNeutralForeground1,
  },
  statLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  bar: {
    height: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
    marginTop: tokens.spacingVerticalXS,
  },
  barFill: { height: '100%', borderRadius: tokens.borderRadiusCircular },
  navGroup: { marginBottom: tokens.spacingVerticalL },
  groupLabel: {
    display: 'block',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalS,
  },
  navCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    cursor: 'pointer',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform, border-color',
    minWidth: 0,
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
    },
  },
  navBody: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  navTitle: { fontWeight: tokens.fontWeightSemibold },
  navDesc: { color: tokens.colorNeutralForeground3 },
  typeChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  typeChipIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    flexShrink: 0,
  },
  classTags: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  pctCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  miniBar: {
    flex: 1,
    minWidth: '48px',
    maxWidth: '120px',
    height: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
  },
});

// Section grid mirroring the Purview portal left nav. Each card carries an
// accent color so the surface reads as Web 3.0, not a flat menu.
const SECTIONS: {
  group: string;
  items: { href: string; label: string; desc: string; icon: FluentIcon; color: string }[];
}[] = [
  {
    group: 'Catalog management',
    items: [
      { href: '/governance/catalog', label: 'Data catalog', desc: 'Unified inventory across OneLake, Synapse, Databricks, ADLS.', icon: DatabaseSearch20Regular, color: '#0d7377' },
      { href: '/catalog/domains', label: 'Governance domains', desc: 'Domains, data products, glossary terms.', icon: DocumentBulletList20Regular, color: '#3d2e80' },
    ],
  },
  {
    group: 'Discovery & lineage',
    items: [
      { href: '/governance/lineage', label: 'Lineage', desc: 'End-to-end column & item lineage graph.', icon: Branch20Regular, color: '#5e4dc0' },
      { href: '/catalog', label: 'Search', desc: 'Federated search across Purview, Unity, OneLake.', icon: DatabaseSearch20Regular, color: '#0078d4' },
    ],
  },
  {
    group: 'Data Map',
    items: [
      { href: '/governance/scans', label: 'Scans & sources', desc: 'Register sources, schedule + run scans.', icon: ArrowSync20Regular, color: '#0050b3' },
      { href: '/admin/classifications', label: 'Classification rules', desc: 'Define custom classification rules (Loom-native, no Purview).', icon: Tag20Regular, color: '#117865' },
      { href: '/admin/sensitivity-labels', label: 'Sensitivity labels', desc: 'Define + manage sensitivity labels (Loom-native).', icon: Shield20Regular, color: '#7c3aed' },
    ],
  },
  {
    group: 'Governance & health',
    items: [
      { href: '/governance/policies', label: 'Access policies', desc: 'DLP, masking, RLS, retention, access.', icon: Shield20Regular, color: '#c2410c' },
      { href: '/catalog/data-quality', label: 'Data quality rules', desc: 'Define + manage data-quality checks (Loom-native).', icon: Beaker20Regular, color: '#0a7ea4' },
      { href: '/governance/insights', label: 'Insights & reports', desc: 'Coverage KPIs, data-health reporting.', icon: DataTrending20Regular, color: '#ad6800' },
      { href: '/governance/purview', label: 'Microsoft Purview', desc: 'Connection status + embedded portal.', icon: Beaker20Regular, color: '#0d7377' },
    ],
  },
];

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((100 * n) / d) : 0;
}

export default function GovernancePage() {
  const s = useStyles();
  const router = useRouter();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [topClassified, setTopClassified] = useState<TopItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [navQuery, setNavQuery] = useState('');
  const [coverageView, setCoverageView] = useState<LoomView>('list');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/governance/insights');
        const j: InsightsResponse = await r.json();
        if (j.ok) {
          if (j.kpis) setKpis(j.kpis);
          if (Array.isArray(j.coverage)) setCoverage(j.coverage);
          if (Array.isArray(j.topClassified)) setTopClassified(j.topClassified);
        }
      } catch { /* leave empty */ }
      finally { setLoading(false); }
    })();
  }, []);

  // Filter the nav cards by the capped Toolbar search.
  const nav = useMemo(() => {
    const f = navQuery.trim().toLowerCase();
    if (!f) return SECTIONS;
    return SECTIONS
      .map((grp) => ({
        ...grp,
        items: grp.items.filter(
          (it) => it.label.toLowerCase().includes(f) || it.desc.toLowerCase().includes(f),
        ),
      }))
      .filter((grp) => grp.items.length > 0);
  }, [navQuery]);

  // Per-type coverage columns — sortable + filterable per the design guide.
  const coverageColumns = useMemo<LoomColumn<CoverageRow>[]>(() => [
    {
      key: 'type',
      label: 'Item type',
      sortable: true,
      filterable: true,
      width: 280,
      getValue: (r) => itemVisual(r.type).label,
      render: (r) => {
        const v = itemVisual(r.type);
        const Icon = v.icon;
        return (
          <span className={s.typeChip}>
            <span
              className={s.typeChipIcon}
              style={{ backgroundColor: `${v.color}1f` }}
              aria-hidden
            >
              <Icon style={{ width: 16, height: 16, color: v.color }} />
            </span>
            <Text weight="semibold">{v.label}</Text>
          </span>
        );
      },
    },
    {
      key: 'total', label: 'Items', sortable: true, filterable: false, width: 100,
      getValue: (r) => r.total,
    },
    {
      key: 'labeled', label: 'Sensitivity', sortable: true, filterable: false, width: 200,
      getValue: (r) => pct(r.labeled, r.total),
      render: (r) => {
        const p = pct(r.labeled, r.total);
        return (
          <span className={s.pctCell}>
            <span className={s.miniBar}>
              <span className={s.barFill} style={{ width: `${p}%`, backgroundColor: '#7c3aed', display: 'block', height: '100%' }} />
            </span>
            <Text size={200}>{p}%</Text>
          </span>
        );
      },
    },
    {
      key: 'classified', label: 'Classification', sortable: true, filterable: false, width: 200,
      getValue: (r) => pct(r.classified, r.total),
      render: (r) => {
        const p = pct(r.classified, r.total);
        return (
          <span className={s.pctCell}>
            <span className={s.miniBar}>
              <span className={s.barFill} style={{ width: `${p}%`, backgroundColor: '#0078d4', display: 'block', height: '100%' }} />
            </span>
            <Text size={200}>{p}%</Text>
          </span>
        );
      },
    },
  ], [s]);

  const statValue = (k: keyof Kpis, pctFlag?: boolean): string => {
    const v = kpis ? kpis[k] : 0;
    return pctFlag ? `${v}%` : String(v);
  };

  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — the Microsoft Purview governance framework, woven into Loom. Real posture from your tenant; no fake numbers."
    >
      {/* Purview connection status (live chip or honest gate). */}
      <PurviewGate status={purview} surface="Governance" reload={reloadStatus} />

      {/* Posture KPIs — real, from Cosmos. */}
      <Section
        title="Governance posture"
        actions={<Badge appearance="tint" color="informative">live · Cosmos</Badge>}
      >
        {loading && <Spinner label="Computing posture…" style={{ justifyContent: 'flex-start' }} />}
        {!loading && (
          <div className={s.statsRow}>
            {STATS.map((stat) => {
              const Icon = stat.icon;
              return (
                <div key={stat.key} className={s.statCard}>
                  <div className={s.statHead}>
                    <span className={s.chip} style={{ backgroundColor: `${stat.color}1f` }} aria-hidden>
                      <Icon style={{ width: 20, height: 20, color: stat.color }} />
                    </span>
                    <Text className={s.statVal}>{statValue(stat.key, stat.pct)}</Text>
                  </div>
                  <Text className={s.statLabel}>{stat.label}</Text>
                  {stat.pct && (
                    <div className={s.bar}>
                      <div
                        className={s.barFill}
                        style={{ width: `${kpis ? kpis[stat.key] : 0}%`, backgroundColor: stat.color, height: '100%' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Per-type coverage — sortable / resizable / filterable table. */}
      <Section
        title="Coverage by item type"
        actions={
          coverage.length > 0
            ? <ViewToggle value={coverageView} onChange={setCoverageView} ariaLabel="Coverage view" />
            : undefined
        }
      >
        {coverageView === 'list' ? (
          <LoomDataTable
            columns={coverageColumns}
            rows={coverage}
            getRowId={(r) => r.type}
            loading={loading}
            ariaLabel="Coverage by item type"
            empty="No governed items yet — register a source and run a scan to populate coverage."
          />
        ) : (
          <TileGrid>
            {coverage.map((r) => (
              <ItemTile
                key={r.type}
                type={r.type}
                title={itemVisual(r.type).label}
                subtitle={`${r.total} item${r.total === 1 ? '' : 's'}`}
                meta={`${pct(r.labeled, r.total)}% labeled · ${pct(r.classified, r.total)}% classified`}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Most-classified items — recognition-first tiles. */}
      {topClassified.length > 0 && (
        <Section
          title="Most-classified items"
          actions={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Top items by classification count</Caption1>}
        >
          <TileGrid>
            {topClassified.map((it) => (
              <ItemTile
                key={it.id}
                type={it.itemType}
                title={it.displayName}
                subtitle={itemVisual(it.itemType).label}
                badge={<Badge appearance="tint" color="brand" size="small">{it.count}</Badge>}
                meta={
                  <span className={s.classTags}>
                    {it.classifications.slice(0, 4).map((c) => (
                      <Badge key={c} appearance="outline" size="small" color="informative">{c}</Badge>
                    ))}
                    {it.classifications.length > 4 && (
                      <Badge appearance="outline" size="small">+{it.classifications.length - 4}</Badge>
                    )}
                  </span>
                }
              />
            ))}
          </TileGrid>
        </Section>
      )}

      {/* Section grid — mirrors the Purview portal left nav. */}
      <Section
        title="Governance framework"
        actions={
          <Tooltip content="Microsoft Learn: Purview Unified Catalog" relationship="label">
            <Button
              size="small"
              appearance="transparent"
              icon={<Open16Regular />}
              as="a"
              href="https://learn.microsoft.com/purview/unified-catalog"
              target="_blank"
              rel="noreferrer"
            >
              What is the Unified Catalog?
            </Button>
          </Tooltip>
        }
      >
        <Toolbar
          search={navQuery}
          onSearch={setNavQuery}
          searchPlaceholder="Find a governance surface…"
        />
        {nav.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            No governance surface matches &quot;{navQuery}&quot;.
          </Caption1>
        )}
        {nav.map((grp) => (
          <div key={grp.group} className={s.navGroup}>
            <Text size={200} className={s.groupLabel}>{grp.group}</Text>
            <TileGrid>
              {grp.items.map((it) => {
                const Icon = it.icon;
                return (
                  <div
                    key={it.href}
                    className={s.navCard}
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(it.href)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        router.push(it.href);
                      }
                    }}
                  >
                    <span className={s.chip} style={{ backgroundColor: `${it.color}1f` }} aria-hidden>
                      <Icon style={{ width: 20, height: 20, color: it.color }} />
                    </span>
                    <span className={s.navBody}>
                      <Text className={s.navTitle}>{it.label}</Text>
                      <Caption1 className={s.navDesc}>{it.desc}</Caption1>
                    </span>
                  </div>
                );
              })}
            </TileGrid>
          </div>
        ))}
      </Section>

      {/* Real tenant activity. */}
      <Section
        title="Recent activity"
        actions={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Every audit, comment, and share across your tenant — from Cosmos.</Caption1>}
      >
        <ActivityFeedPane />
      </Section>
    </PageShell>
  );
}
