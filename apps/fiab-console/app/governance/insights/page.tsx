'use client';

import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Toolbar } from '@/lib/components/ui/section';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
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

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXL,
  },
  statCard: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  statVal: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  bar: { height: '6px', background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden', marginTop: '2px' },
  barFill: { height: '100%', background: tokens.colorBrandBackground, borderRadius: tokens.borderRadiusSmall },
});

/** Coverage cell: a thin progress bar + "n (p%)" for a sortable LoomDataTable. */
function covCell(value: number, total: number, color: string) {
  const pct = total ? Math.round(100 * value / total) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 }}>
      <div style={{ flex: 1, height: 6, borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: tokens.borderRadiusSmall }} />
      </div>
      <span style={{ fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' }}>{value} ({pct}%)</span>
    </div>
  );
}

export default function InsightsPage() {
  const s = useStyles();
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <GovernanceShell sectionTitle="Insights">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
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

      {loading && !error && <Spinner label="Computing KPIs…" />}

      {data && (
        <>
          <div className={s.statsRow}>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.complianceScorePct}%</div>
              <div className={s.statLabel}>compliance score</div>
              <div className={s.bar}><div className={s.barFill} style={{ width: `${data.kpis.complianceScorePct}%` }} /></div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.totalItems}</div>
              <div className={s.statLabel}>total items</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.sensitiveCoveragePct}%</div>
              <div className={s.statLabel}>sensitivity coverage</div>
              <div className={s.bar}><div className={s.barFill} style={{ width: `${data.kpis.sensitiveCoveragePct}%` }} /></div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.classificationCoveragePct}%</div>
              <div className={s.statLabel}>classification coverage</div>
              <div className={s.bar}><div className={s.barFill} style={{ width: `${data.kpis.classificationCoveragePct}%` }} /></div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.ownershipCoveragePct}%</div>
              <div className={s.statLabel}>ownership coverage</div>
              <div className={s.bar}><div className={s.barFill} style={{ width: `${data.kpis.ownershipCoveragePct}%` }} /></div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.endorsementCoveragePct}%</div>
              <div className={s.statLabel}>endorsement coverage</div>
              <div className={s.bar}><div className={s.barFill} style={{ width: `${data.kpis.endorsementCoveragePct}%` }} /></div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.activePolicies}</div>
              <div className={s.statLabel}>active policies</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.auditEvents30d}</div>
              <div className={s.statLabel}>audit events (30d)</div>
            </div>
          </div>

          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>Coverage by item type</Subtitle2>
          {data.coverage.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No items yet.</Caption1>
          ) : (
            <div style={{ marginBottom: tokens.spacingVerticalXL }}>
              <LoomDataTable
                ariaLabel="Coverage by item type"
                getRowId={(c) => c.type}
                rows={data.coverage}
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
            </div>
          )}

          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>Policy effectiveness</Subtitle2>
          {(!data.policies || data.policies.length === 0) ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXL }}>
              No governance policies defined yet. Create policies in Governance → Policies.
            </Caption1>
          ) : (
            <div style={{ marginBottom: tokens.spacingVerticalXL }}>
              <LoomDataTable
                ariaLabel="Policy effectiveness"
                getRowId={(p) => p.name}
                rows={data.policies}
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
            </div>
          )}

          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>Most classified items</Subtitle2>
          {data.topClassified.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No classified items yet.</Caption1>
          ) : (
            <LoomDataTable
              ariaLabel="Most classified items"
              getRowId={(it) => it.id}
              rows={data.topClassified}
              columns={[
                {
                  key: 'displayName', label: 'Item', sortable: true, filterable: true,
                  getValue: (it) => it.displayName,
                  render: (it) => <><strong>{it.displayName}</strong><Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{it.itemType}</Caption1></>,
                },
                {
                  key: 'classifications', label: 'Classifications', sortable: false, filterable: true,
                  getValue: (it) => it.classifications.join(' '),
                  render: (it) => <>{it.classifications.map((c) => <Badge key={c} appearance="tint" size="small" style={{ marginRight: tokens.spacingHorizontalXS }}>{c}</Badge>)}<strong style={{ marginLeft: tokens.spacingHorizontalXS }}>({it.count})</strong></>,
                },
                {
                  key: 'open', label: '', sortable: false, filterable: false, width: 90,
                  render: (it) => (
                    <a href={`/items/${it.itemType}/${it.id}`}
                       style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 }}>
                      Open <Open16Regular />
                    </a>
                  ),
                },
              ] as LoomColumn<{ id: string; displayName: string; itemType: string; count: number; classifications: string[] }>[]}
            />
          )}
        </>
      )}
    </GovernanceShell>
  );
}
