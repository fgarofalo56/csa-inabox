'use client';

/**
 * /admin/security — full Purview + Information Protection + DLP
 * management surface inside CSA Loom. Goal: users never leave Loom for
 * portal.azure.com / compliance.microsoft.com / purview.microsoft.com.
 *
 * Tabs:
 *   - Overview              KPI dashboard (existing — sensitivity, classifications,
 *                            policies, audit count, recent permission changes).
 *   - Purview               Inline management of data sources, scans, glossary,
 *                            domains, DQ + links to existing /governance/{sensitivity,lineage}.
 *   - Information Protection Tenant sensitivity labels + label policies + apply-label
 *                            action. Backed by Microsoft Graph (UAMI ChainedTokenCredential).
 *   - DLP                   Purview DLP policies + rules + alerts + simulate.
 *   - Audit                 Filterable + CSV-exportable audit log.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Badge, Caption1, Body1, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Shield24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { PurviewPanel } from '@/lib/components/admin-security/purview-panel';
import { MipPanel } from '@/lib/components/admin-security/mip-panel';
import { DlpPanel } from '@/lib/components/admin-security/dlp-panel';
import { AuditPanel } from '@/lib/components/admin-security/audit-panel';
import { DspmAiPanel } from '@/lib/components/admin-security/dspm-ai-panel';
import { Section } from '@/lib/components/ui/section';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Insights {
  kpis: { totalItems: number; sensitiveCoveragePct: number; classificationCoveragePct: number; activePolicies: number; auditEvents30d: number };
  coverage: Array<{ type: string; total: number; labeled: number; classified: number }>;
}
interface Sensitivity {
  total: number; labeled: number; unlabeled: number;
  distribution: Array<{ label: string; count: number }>;
}
interface Classifications {
  classifications: Array<{ name: string; count: number }>;
}
interface AuditRow {
  id: string; at: string; who: string; kind: string; itemId: string;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  topTabs: { marginBottom: tokens.spacingVerticalL },
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  statCard: {
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  statVal: { fontSize: '24px', fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3, marginTop: '2px' },
  bar: { height: '6px', backgroundColor: tokens.colorNeutralBackground3, borderRadius: '3px', overflow: 'hidden', marginTop: '8px' },
  barFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: '3px' },
  twoCol: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  chip: {
    fontSize: '11px', padding: '4px 10px', borderRadius: '999px',
    backgroundColor: tokens.colorPaletteBlueBackground2,
    color: tokens.colorPaletteBlueForeground2,
    marginRight: '6px', display: 'inline-block', marginBottom: '6px',
  },
  refresh: { display: 'flex', justifyContent: 'flex-end', marginBottom: tokens.spacingVerticalM },
});

function labelColor(l: string): any {
  if (l === 'Highly Confidential' || l === 'Restricted') return 'danger';
  if (l === 'Confidential') return 'warning';
  if (l === 'Internal') return 'informative';
  return 'subtle';
}

type TopTab = 'overview' | 'purview' | 'mip' | 'dlp' | 'dspm' | 'audit';

export default function SecurityPage() {
  const s = useStyles();
  const [tab, setTab] = useState<TopTab>('overview');

  // Honor the ?tab= deep-link (e.g. the "DSPM for AI" admin-shell nav entry).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && ['overview', 'purview', 'mip', 'dlp', 'dspm', 'audit'].includes(t)) {
      setTab(t as TopTab);
    }
  }, []);

  return (
    <AdminShell sectionTitle="Security & governance">
      <Body1 className={s.intro}>
        Tenant-wide security posture + inline management of Microsoft Purview, Information Protection, and
        DLP. Every operation is wired to a real Azure / Microsoft Graph backend — when an upstream isn't
        wired in this deployment, the affected tab surfaces a precise remediation (env var, AppRole, bicep
        module, bootstrap script).
      </Body1>

      <TabList
        className={s.topTabs}
        selectedValue={tab}
        onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setTab(d.value as TopTab)}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="purview">Purview</Tab>
        <Tab value="mip">Information Protection</Tab>
        <Tab value="dlp">DLP</Tab>
        <Tab value="dspm">DSPM for AI</Tab>
        <Tab value="audit">Audit</Tab>
      </TabList>

      {tab === 'overview' && <OverviewTab />}
      {/* Gated panels own their internal layout/logic; the page only frames them. */}
      {tab === 'purview' && <Section bare><PurviewPanel /></Section>}
      {tab === 'mip' && <Section bare><MipPanel /></Section>}
      {tab === 'dlp' && <Section bare><DlpPanel /></Section>}
      {tab === 'dspm' && <Section bare><DspmAiPanel /></Section>}
      {tab === 'audit' && <Section bare><AuditPanel /></Section>}
    </AdminShell>
  );
}

function OverviewTab() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [sensitivity, setSensitivity] = useState<Sensitivity | null>(null);
  const [classifications, setClassifications] = useState<Classifications | null>(null);
  const [shareEvents, setShareEvents] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [iR, sR, cR, aR] = await Promise.allSettled([
        clientFetch('/api/governance/insights').then((r) => r.json()),
        clientFetch('/api/governance/sensitivity').then((r) => r.json()),
        clientFetch('/api/governance/classifications').then((r) => r.json()),
        clientFetch('/api/admin/audit-logs?top=20').then((r) => r.json()),
      ]);
      if (iR.status === 'fulfilled' && iR.value.ok) setInsights(iR.value);
      if (sR.status === 'fulfilled' && sR.value.ok) setSensitivity(sR.value);
      if (cR.status === 'fulfilled' && cR.value.ok) setClassifications(cR.value);
      if (aR.status === 'fulfilled' && aR.value.ok) {
        const recent = (aR.value.rows || []).filter((r: AuditRow) =>
          r.kind?.includes('share') || r.kind?.includes('permission') || r.kind?.includes('role')
        ).slice(0, 10);
        setShareEvents(recent);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const labelColumns: LoomColumn<{ label: string; count: number }>[] = [
    {
      key: 'label', label: 'Label', width: 240, getValue: (d) => d.label,
      render: (d) => <Badge appearance="filled" color={labelColor(d.label)} size="small">{d.label}</Badge>,
    },
    { key: 'count', label: 'Items', width: 120, getValue: (d) => d.count, render: (d) => <strong>{d.count}</strong> },
  ];

  const shareColumns: LoomColumn<AuditRow>[] = [
    {
      key: 'at', label: 'When', width: 190, getValue: (e) => new Date(e.at).getTime(),
      render: (e) => <Caption1>{new Date(e.at).toLocaleString()}</Caption1>,
    },
    { key: 'who', label: 'Who', width: 200 },
    { key: 'kind', label: 'Action', width: 160, render: (e) => <Badge appearance="outline" size="small">{e.kind}</Badge> },
    { key: 'itemId', label: 'Target', width: 220, render: (e) => <code className={a.codeCell}>{e.itemId}</code> },
  ];

  return (
    <>
      <div className={s.refresh}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Could not load security dashboard</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Section><Spinner label="Composing security view…" /></Section>}

      {!loading && (insights || sensitivity || classifications) && (
        <>
          {insights && (
            <Section title="Posture">
              <div className={s.statsRow}>
                <div className={s.statCard}>
                  <div className={s.statVal}>{insights.kpis.totalItems}</div>
                  <div className={s.statLabel}>data items</div>
                </div>
                <div className={s.statCard}>
                  <div className={s.statVal}>{insights.kpis.sensitiveCoveragePct}%</div>
                  <div className={s.statLabel}>sensitivity coverage</div>
                  <div className={s.bar}>
                    <div className={s.barFill} style={{ width: `${insights.kpis.sensitiveCoveragePct}%` }} />
                  </div>
                </div>
                <div className={s.statCard}>
                  <div className={s.statVal}>{insights.kpis.classificationCoveragePct}%</div>
                  <div className={s.statLabel}>classification coverage</div>
                  <div className={s.bar}>
                    <div className={s.barFill} style={{ width: `${insights.kpis.classificationCoveragePct}%` }} />
                  </div>
                </div>
                <div className={s.statCard}>
                  <div className={s.statVal}>{insights.kpis.activePolicies}</div>
                  <div className={s.statLabel}>active policies</div>
                </div>
                <div className={s.statCard}>
                  <div className={s.statVal}>{insights.kpis.auditEvents30d}</div>
                  <div className={s.statLabel}>audit events (30d)</div>
                </div>
              </div>
            </Section>
          )}

          <div className={s.twoCol}>
            <Section title={<span><Shield24Regular className={a.headIcon} />Sensitivity label distribution</span>}>
              {sensitivity && sensitivity.distribution.length > 0 ? (
                <LoomDataTable
                  columns={labelColumns}
                  rows={sensitivity.distribution}
                  getRowId={(d) => d.label}
                  noFilters
                  ariaLabel="Label distribution"
                  empty="No labels applied yet."
                />
              ) : (
                <Caption1 className={a.muted}>No labels applied yet.</Caption1>
              )}
              {sensitivity && (
                <Caption1 className={a.mutedBlock}>
                  {sensitivity.unlabeled} of {sensitivity.total} items are unlabeled.
                  <a href="/governance/sensitivity" className={a.badgeGap}>Open full view</a>
                </Caption1>
              )}
            </Section>

            <Section title="Top classifications">
              {classifications && classifications.classifications.length > 0 ? (
                <>
                  <div>
                    {classifications.classifications.slice(0, 12).map((c) => (
                      <span key={c.name} className={s.chip}>{c.name} <strong>({c.count})</strong></span>
                    ))}
                  </div>
                  <Caption1 className={a.mutedBlock}>
                    <a href="/governance/classifications">Open full view</a>
                  </Caption1>
                </>
              ) : (
                <Caption1 className={a.muted}>No classifications applied yet.</Caption1>
              )}
            </Section>
          </div>

          <Section title="Recent permission changes">
            {shareEvents.length > 0 ? (
              <LoomDataTable
                columns={shareColumns}
                rows={shareEvents}
                getRowId={(e) => e.id}
                ariaLabel="Permission changes"
                empty="No recent permission changes."
              />
            ) : (
              <Caption1 className={a.muted}>
                No recent share / permission events in the last 30 days. Use the <strong>Audit</strong> tab for full history + CSV export.
              </Caption1>
            )}
          </Section>
        </>
      )}
    </>
  );
}
