'use client';

import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Section, Toolbar } from '@/lib/components/ui/section';
import {
  ArrowSync24Regular, Open16Regular, ShieldCheckmark20Regular,
  Box20Regular, Tag20Regular, Shield20Regular, PersonAvailable20Regular,
  Ribbon20Regular, History20Regular, DataTrending20Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { clientFetch } from '@/lib/client-fetch';

interface CoverageRow { type: string; total: number; labeled: number; classified: number; owned: number; endorsed: number }
interface PolicyRow { name: string; type?: string; scope?: string; enabled: boolean; updatedAt?: string }
interface Insights {
  kpis: {
    totalItems: number; sensitiveCoveragePct: number; classificationCoveragePct: number;
    ownershipCoveragePct: number; endorsementCoveragePct: number; complianceScorePct: number;
    activePolicies: number; auditEvents30d: number;
  };
  coverage: CoverageRow[];
  topClassified: Array<{ id: string; displayName: string; itemType: string; count: number; classifications: string[] }>;
  policies: PolicyRow[];
}

/** A single KPI stat, with its own accent color + icon chip. */
interface StatDef {
  key: keyof Insights['kpis'];
  label: string;
  icon: FluentIcon;
  color: string;
  /** Render the value as a % with a coverage bar. */
  pct?: boolean;
}

// Accent palette echoes the governance/teal family used across Loom tiles.
const STATS: StatDef[] = [
  { key: 'complianceScorePct', label: 'compliance score', icon: ShieldCheckmark20Regular, color: 'var(--loom-accent-green)', pct: true },
  { key: 'totalItems', label: 'total items', icon: Box20Regular, color: 'var(--loom-accent-teal)' },
  { key: 'sensitiveCoveragePct', label: 'sensitivity coverage', icon: Shield20Regular, color: 'var(--loom-accent-violet)', pct: true },
  { key: 'classificationCoveragePct', label: 'classification coverage', icon: Tag20Regular, color: 'var(--loom-accent-blue)', pct: true },
  { key: 'ownershipCoveragePct', label: 'ownership coverage', icon: PersonAvailable20Regular, color: 'var(--loom-accent-indigo)', pct: true },
  { key: 'endorsementCoveragePct', label: 'endorsement coverage', icon: Ribbon20Regular, color: 'var(--loom-accent-amber)', pct: true },
  { key: 'activePolicies', label: 'active policies', icon: Shield20Regular, color: 'var(--loom-accent-orange)' },
  { key: 'auditEvents30d', label: 'audit events (30d)', icon: History20Regular, color: 'var(--loom-accent-cyan)' },
];

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL, width: '100%',
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform',
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-2px)',
    },
  },
  statHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, minWidth: 0 },
  chip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusLarge,
  },
  chipIcon20: { width: '20px', height: '20px' },
  statVal: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1.1,
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  statLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  bar: {
    height: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
    marginTop: tokens.spacingVerticalXS,
  },
  barFill: { display: 'block', height: '100%', borderRadius: tokens.borderRadiusCircular },
  spinnerStart: { justifyContent: 'flex-start' },
  sectionTitle: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionIcon: { color: tokens.colorBrandForeground1, width: '20px', height: '20px' },
  muted: { color: tokens.colorNeutralForeground3 },
  topItemName: { minWidth: 0, overflowWrap: 'anywhere' },
  classTags: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  covCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  covTrack: { flex: 1, height: '6px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground4, overflow: 'hidden' },
  covFill: { height: '100%', borderRadius: tokens.borderRadiusCircular },
  covPct: { fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  openLink: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 },
});

/** A themed section header: a brand icon chip + the section title. */
function sectionHead(s: ReturnType<typeof useStyles>, Icon: FluentIcon, label: string) {
  return (
    <span className={s.sectionTitle}>
      <Icon className={s.sectionIcon} aria-hidden />
      {label}
    </span>
  );
}

export default function InsightsPage() {
  const s = useStyles();
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Coverage cell: a thin progress bar + "n (p%)" for a sortable LoomDataTable. */
  const covCell = (value: number, total: number, color: string) => {
    const pct = total ? Math.round(100 * value / total) : 0;
    return (
      <div className={s.covCell}>
        <div className={s.covTrack}>
          <div className={s.covFill} style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className={s.covPct}>{value} ({pct}%)</span>
      </div>
    );
  };

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/insights');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const statValue = (k: keyof Insights['kpis'], pctFlag?: boolean): string => {
    const v = data ? data.kpis[k] : 0;
    return pctFlag ? `${v}%` : String(v);
  };

  return (
    <GovernanceShell sectionTitle="Insights">
      <Body1 className={s.intro}>
        Tenant-wide governance KPIs derived live from your Cosmos catalog + audit log.
      </Body1>

      <Toolbar actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>} />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load insights</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!error && (
        <>
          <Section
            title={sectionHead(s, DataTrending20Regular, 'Compliance posture')}
            actions={<Badge appearance="tint" color="informative">live · Cosmos</Badge>}
          >
            {loading && <Spinner label="Computing KPIs…" className={s.spinnerStart} />}
            {!loading && data && (
              <div className={s.statsRow}>
                {STATS.map((stat) => {
                  const Icon = stat.icon;
                  const v = data.kpis[stat.key];
                  return (
                    <div key={stat.key} className={s.statCard}>
                      <div className={s.statHead}>
                        <span className={s.chip} style={{ backgroundColor: `${stat.color}1f` }} aria-hidden>
                          <Icon className={s.chipIcon20} style={{ color: stat.color }} />
                        </span>
                        <Text className={s.statVal}>{statValue(stat.key, stat.pct)}</Text>
                      </div>
                      <Text className={s.statLabel}>{stat.label}</Text>
                      {stat.pct && (
                        <div className={s.bar}>
                          <div className={s.barFill} style={{ width: `${v}%`, backgroundColor: stat.color }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title={sectionHead(s, Box20Regular, 'Coverage by item type')}>
            <LoomDataTable
              ariaLabel="Coverage by item type"
              getRowId={(c) => c.type}
              rows={data?.coverage ?? []}
              loading={loading}
              skeleton={5}
              empty="No items yet — register a source and run a scan to populate coverage."
              columns={[
                { key: 'type', label: 'Type', sortable: true, filterable: true, width: 220, render: (c) => <strong>{c.type}</strong> },
                { key: 'total', label: 'Total', sortable: true, width: 90, getValue: (c) => c.total },
                {
                  key: 'labeled', label: 'Sensitivity labeled', sortable: true, width: 260,
                  getValue: (c) => (c.total ? c.labeled / c.total : 0),
                  render: (c) => covCell(c.labeled, c.total, tokens.colorPaletteDarkOrangeForeground1),
                },
                {
                  key: 'classified', label: 'Classified', sortable: true, width: 220,
                  getValue: (c) => (c.total ? c.classified / c.total : 0),
                  render: (c) => covCell(c.classified, c.total, tokens.colorBrandForeground1),
                },
                {
                  key: 'owned', label: 'Owned', sortable: true, width: 220,
                  getValue: (c) => (c.total ? c.owned / c.total : 0),
                  render: (c) => covCell(c.owned, c.total, tokens.colorPalettePurpleForeground2),
                },
                {
                  key: 'endorsed', label: 'Endorsed', sortable: true, width: 220,
                  getValue: (c) => (c.total ? c.endorsed / c.total : 0),
                  render: (c) => covCell(c.endorsed, c.total, tokens.colorPaletteGreenForeground1),
                },
              ] as LoomColumn<CoverageRow>[]}
            />
          </Section>

          <Section title={sectionHead(s, Shield20Regular, 'Policy effectiveness')}>
            <LoomDataTable
              ariaLabel="Policy effectiveness"
              getRowId={(p) => p.name}
              rows={data?.policies ?? []}
              loading={loading}
              skeleton={5}
              empty="No governance policies defined yet. Create policies in Governance → Policies."
              columns={[
                { key: 'name', label: 'Policy', sortable: true, filterable: true, width: 260, render: (p) => <strong>{p.name}</strong> },
                { key: 'type', label: 'Type', sortable: true, filterable: true, width: 160, getValue: (p) => p.type || '', render: (p) => p.type || '—' },
                { key: 'scope', label: 'Scope', sortable: true, filterable: true, width: 200, getValue: (p) => p.scope || '', render: (p) => p.scope || 'All items' },
                {
                  key: 'enabled', label: 'Status', sortable: true, width: 130,
                  getValue: (p) => (p.enabled ? 1 : 0),
                  render: (p) => <Badge appearance="tint" color={p.enabled ? 'success' : 'warning'} size="small">{p.enabled ? 'Active' : 'Disabled'}</Badge>,
                },
                {
                  key: 'updatedAt', label: 'Updated', sortable: true, width: 170,
                  getValue: (p) => (p.updatedAt ? new Date(p.updatedAt).getTime() : 0),
                  render: (p) => p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—',
                },
              ] as LoomColumn<PolicyRow>[]}
            />
          </Section>

          <Section title={sectionHead(s, Tag20Regular, 'Most classified items')}>
            <LoomDataTable
              ariaLabel="Most classified items"
              getRowId={(it) => it.id}
              rows={data?.topClassified ?? []}
              loading={loading}
              skeleton={5}
              empty="No classified items yet — classify items to see your most-classified assets here."
              columns={[
                {
                  key: 'displayName', label: 'Item', sortable: true, filterable: true,
                  getValue: (it) => it.displayName,
                  render: (it) => <div className={s.topItemName}><strong>{it.displayName}</strong><Caption1 className={s.muted} style={{ display: 'block' }}>{it.itemType}</Caption1></div>,
                },
                {
                  key: 'classifications', label: 'Classifications', sortable: false, filterable: true,
                  getValue: (it) => it.classifications.join(' '),
                  render: (it) => (
                    <div className={s.classTags}>
                      {it.classifications.map((c) => <Badge key={c} appearance="tint" size="small">{c}</Badge>)}
                      <strong>({it.count})</strong>
                    </div>
                  ),
                },
                {
                  key: 'open', label: '', sortable: false, filterable: false, width: 90,
                  render: (it) => (
                    <a href={`/items/${it.itemType}/${it.id}`} className={s.openLink}>
                      Open <Open16Regular />
                    </a>
                  ),
                },
              ] as LoomColumn<{ id: string; displayName: string; itemType: string; count: number; classifications: string[] }>[]}
            />
          </Section>
        </>
      )}
    </GovernanceShell>
  );
}
