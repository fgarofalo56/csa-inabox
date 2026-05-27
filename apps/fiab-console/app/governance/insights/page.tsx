'use client';

import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Insights {
  kpis: {
    totalItems: number; sensitiveCoveragePct: number; classificationCoveragePct: number;
    activePolicies: number; auditEvents30d: number;
  };
  coverage: Array<{ type: string; total: number; labeled: number; classified: number }>;
  topClassified: Array<{ id: string; displayName: string; itemType: string; count: number; classifications: string[] }>;
}

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12, marginBottom: 20,
  },
  statCard: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  pct: { fontSize: 14, color: tokens.colorNeutralForeground3 },
  bar: { height: 6, background: tokens.colorNeutralBackground3, borderRadius: 3, overflow: 'hidden', marginTop: 2 },
  barFill: { height: '100%', background: tokens.colorBrandBackground, borderRadius: 3 },
});

export default function InsightsPage() {
  const s = useStyles();
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/governance/insights');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <GovernanceShell sectionTitle="Insights">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Tenant-wide governance KPIs derived live from your Cosmos catalog + audit log.
      </Body1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

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
              <div className={s.statVal}>{data.kpis.activePolicies}</div>
              <div className={s.statLabel}>active policies</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.auditEvents30d}</div>
              <div className={s.statLabel}>audit events (30d)</div>
            </div>
          </div>

          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Coverage by item type</Subtitle2>
          {data.coverage.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No items yet.</Caption1>
          ) : (
            <Table aria-label="Coverage by item type" style={{ marginBottom: 20 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Sensitivity labeled</TableHeaderCell>
                  <TableHeaderCell>Classified</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.coverage.map((c) => {
                  const lp = c.total ? Math.round(100 * c.labeled / c.total) : 0;
                  const cp = c.total ? Math.round(100 * c.classified / c.total) : 0;
                  return (
                    <TableRow key={c.type}>
                      <TableCell>{c.type}</TableCell>
                      <TableCell>{c.total}</TableCell>
                      <TableCell>{c.labeled} <span className={s.pct}>({lp}%)</span></TableCell>
                      <TableCell>{c.classified} <span className={s.pct}>({cp}%)</span></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Most classified items</Subtitle2>
          {data.topClassified.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No classified items yet.</Caption1>
          ) : (
            <Table size="small" aria-label="Most classified">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Item</TableHeaderCell>
                  <TableHeaderCell>Classifications</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topClassified.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      <strong>{it.displayName}</strong>
                      <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{it.itemType}</Caption1>
                    </TableCell>
                    <TableCell>
                      {it.classifications.map((c) => (
                        <Badge key={c} appearance="outline" size="small" style={{ marginRight: 4 }}>{c}</Badge>
                      ))}
                      <strong style={{ marginLeft: 4 }}>({it.count})</strong>
                    </TableCell>
                    <TableCell>
                      <a href={`/items/${it.itemType}/${it.id}`}
                         style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        Open <Open16Regular />
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </GovernanceShell>
  );
}
