'use client';

/**
 * /governance — Governance overview, one-for-one with the Microsoft Purview
 * landing experience (Catalog management / Discovery / Data Map / Health
 * management). This is the answer to "what is the Governance tab for":
 *
 *   - Live posture KPIs (items, sensitivity/classification coverage, active
 *     policies, audit events) derived from the real Cosmos catalog +
 *     /api/governance/insights — no fake numbers.
 *   - Microsoft Purview connection status (live / not-wired / cross-cloud)
 *     via the shared PurviewGate probe.
 *   - A section grid mirroring Purview's left nav so every governance surface
 *     is one click away with a one-line "what it does".
 *   - The real tenant activity feed at the bottom.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Spinner, Caption1, Subtitle2, Title3, Body1, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataTrending20Regular, Shield20Regular, Tag20Regular, Branch20Regular,
  DatabaseSearch20Regular, DocumentBulletList20Regular, Beaker20Regular,
  Open16Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';

interface Kpis {
  totalItems: number; sensitiveCoveragePct: number; classificationCoveragePct: number;
  activePolicies: number; auditEvents30d: number;
}

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12, marginBottom: 24,
  },
  statCard: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  bar: { height: 6, background: tokens.colorNeutralBackground3, borderRadius: 3, overflow: 'hidden', marginTop: 4 },
  barFill: { height: '100%', background: tokens.colorBrandBackground, borderRadius: 3 },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 12, marginBottom: 24,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: 16,
    borderRadius: 8, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { borderColor: tokens.colorBrandStroke1, backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8 },
  groupLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: tokens.colorNeutralForeground3, margin: '4px 0 8px' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
});

// Section grid mirroring the Purview portal left nav.
const SECTIONS: { group: string; items: { href: string; label: string; desc: string; icon: JSX.Element }[] }[] = [
  {
    group: 'Catalog management',
    items: [
      { href: '/governance/catalog', label: 'Data catalog', desc: 'Unified inventory across OneLake, Synapse, Databricks, ADLS.', icon: <DatabaseSearch20Regular /> },
      { href: '/catalog/domains', label: 'Governance domains', desc: 'Domains, data products, glossary terms.', icon: <DocumentBulletList20Regular /> },
    ],
  },
  {
    group: 'Discovery & lineage',
    items: [
      { href: '/governance/lineage', label: 'Lineage', desc: 'End-to-end column & item lineage graph.', icon: <Branch20Regular /> },
      { href: '/catalog', label: 'Search', desc: 'Federated search across Purview, Unity, OneLake.', icon: <DatabaseSearch20Regular /> },
    ],
  },
  {
    group: 'Data Map',
    items: [
      { href: '/governance/scans', label: 'Scans & sources', desc: 'Register sources, schedule + run scans.', icon: <ArrowSync16Regular /> },
      { href: '/governance/classifications', label: 'Classifications', desc: 'Sensitive-info types across the estate.', icon: <Tag20Regular /> },
      { href: '/governance/sensitivity', label: 'Sensitivity labels', desc: 'MIP label distribution and coverage.', icon: <Shield20Regular /> },
    ],
  },
  {
    group: 'Governance & health',
    items: [
      { href: '/governance/policies', label: 'Access policies', desc: 'DLP, masking, RLS, retention, access.', icon: <Shield20Regular /> },
      { href: '/governance/insights', label: 'Insights & reports', desc: 'Coverage KPIs, data-health reporting.', icon: <DataTrending20Regular /> },
      { href: '/governance/purview', label: 'Microsoft Purview', desc: 'Connection status + embedded portal.', icon: <Beaker20Regular /> },
    ],
  },
];

export default function GovernancePage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/governance/insights');
        const j = await r.json();
        if (j.ok) setKpis(j.kpis);
      } catch { /* leave null */ }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — the Microsoft Purview governance framework, woven into Loom. Real posture from your tenant; no fake numbers."
    >
      {/* Purview connection status (live chip or honest gate). */}
      <PurviewGate status={purview} surface="Governance" reload={reloadStatus} />

      {/* Posture KPIs — real, from Cosmos. */}
      <div className={s.sectionHead}>
        <Title3 as="h2">Governance posture</Title3>
        <Badge appearance="outline" color="informative">live · Cosmos</Badge>
      </div>
      {loading && <Spinner label="Computing posture…" style={{ justifyContent: 'flex-start', marginBottom: 24 }} />}
      {kpis && (
        <div className={s.statsRow}>
          <div className={s.statCard}>
            <div className={s.statVal}>{kpis.totalItems}</div>
            <div className={s.statLabel}>governed items</div>
          </div>
          <div className={s.statCard}>
            <div className={s.statVal}>{kpis.sensitiveCoveragePct}%</div>
            <div className={s.statLabel}>sensitivity coverage</div>
            <div className={s.bar}><div className={s.barFill} style={{ width: `${kpis.sensitiveCoveragePct}%` }} /></div>
          </div>
          <div className={s.statCard}>
            <div className={s.statVal}>{kpis.classificationCoveragePct}%</div>
            <div className={s.statLabel}>classification coverage</div>
            <div className={s.bar}><div className={s.barFill} style={{ width: `${kpis.classificationCoveragePct}%` }} /></div>
          </div>
          <div className={s.statCard}>
            <div className={s.statVal}>{kpis.activePolicies}</div>
            <div className={s.statLabel}>active policies</div>
          </div>
          <div className={s.statCard}>
            <div className={s.statVal}>{kpis.auditEvents30d}</div>
            <div className={s.statLabel}>audit events (30d)</div>
          </div>
        </div>
      )}

      {/* Section grid — mirrors the Purview portal left nav. */}
      <div className={s.sectionHead}>
        <Title3 as="h2">Governance framework</Title3>
        <Button size="small" appearance="transparent" icon={<Open16Regular />} as="a"
          href="https://learn.microsoft.com/purview/unified-catalog" target="_blank" rel="noreferrer">
          What is the Purview Unified Catalog?
        </Button>
      </div>
      {SECTIONS.map((grp) => (
        <div key={grp.group}>
          <div className={s.groupLabel}>{grp.group}</div>
          <div className={s.grid}>
            {grp.items.map((it) => (
              <Link key={it.href} href={it.href} className={s.card}>
                <div className={s.cardHead}>
                  {it.icon}
                  <Subtitle2>{it.label}</Subtitle2>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{it.desc}</Caption1>
              </Link>
            ))}
          </div>
        </div>
      ))}

      {/* Real tenant activity. */}
      <div className={s.sectionHead}>
        <Title3 as="h2">Recent activity</Title3>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Every audit, comment, and share across your tenant — from Cosmos.</Caption1>
      </div>
      <ActivityFeedPane />
    </PageShell>
  );
}
