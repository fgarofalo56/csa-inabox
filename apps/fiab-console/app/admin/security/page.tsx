'use client';

/**
 * /admin/security — REAL security & governance dashboard. Composes data
 * from existing routes:
 *   - /api/governance/sensitivity   → label distribution + coverage %
 *   - /api/governance/classifications → classification hits
 *   - /api/governance/insights      → KPIs + active policies + audit count
 *   - /api/admin/audit-logs (type=share) → recent share grants
 *
 * No new BFF route required — this is a composition layer over the
 * already-functional governance endpoints.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Shield24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';

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
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12, marginBottom: 20,
  },
  statCard: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 24, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  bar: { height: 6, background: tokens.colorNeutralBackground3, borderRadius: 3, overflow: 'hidden', marginTop: 4 },
  barFill: { height: '100%', background: tokens.colorBrandBackground, borderRadius: 3 },
  twoCol: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: 16, marginBottom: 20,
  },
  section: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  chip: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorPaletteBlueBackground2,
    color: tokens.colorPaletteBlueForeground2,
    marginRight: 4, display: 'inline-block', marginBottom: 4,
  },
});

function labelColor(l: string): any {
  if (l === 'Highly Confidential' || l === 'Restricted') return 'danger';
  if (l === 'Confidential') return 'warning';
  if (l === 'Internal') return 'informative';
  return 'subtle';
}

export default function SecurityPage() {
  const s = useStyles();
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
        fetch('/api/governance/insights').then((r) => r.json()),
        fetch('/api/governance/sensitivity').then((r) => r.json()),
        fetch('/api/governance/classifications').then((r) => r.json()),
        fetch('/api/admin/audit-logs?top=20').then((r) => r.json()),
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

  return (
    <AdminShell sectionTitle="Security & governance">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 16 }}>
        Tenant-wide security posture. Aggregates sensitivity coverage, classification activity, active
        governance policies, and recent permission changes.
      </Body1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load security dashboard</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Composing security view…" />}

      {!loading && (insights || sensitivity || classifications) && (
        <>
          <div className={s.statsRow}>
            {insights && (
              <>
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
              </>
            )}
          </div>

          <div className={s.twoCol}>
            <div className={s.section}>
              <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>
                <Shield24Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />
                Sensitivity label distribution
              </Subtitle2>
              {sensitivity && sensitivity.distribution.length > 0 ? (
                <Table size="small" aria-label="Label distribution">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Label</TableHeaderCell>
                      <TableHeaderCell>Items</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sensitivity.distribution.map((d) => (
                      <TableRow key={d.label}>
                        <TableCell>
                          <Badge appearance="filled" color={labelColor(d.label)} size="small">{d.label}</Badge>
                        </TableCell>
                        <TableCell><strong>{d.count}</strong></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No labels applied yet.</Caption1>
              )}
              {sensitivity && (
                <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                  {sensitivity.unlabeled} of {sensitivity.total} items are unlabeled.
                  <a href="/governance/sensitivity" style={{ marginLeft: 8 }}>Open full view</a>
                </Caption1>
              )}
            </div>

            <div className={s.section}>
              <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Top classifications</Subtitle2>
              {classifications && classifications.classifications.length > 0 ? (
                <>
                  {classifications.classifications.slice(0, 12).map((c) => (
                    <span key={c.name} className={s.chip}>{c.name} <strong>({c.count})</strong></span>
                  ))}
                  <Caption1 style={{ display: 'block', marginTop: 12, color: tokens.colorNeutralForeground3 }}>
                    <a href="/governance/classifications">Open full view</a>
                  </Caption1>
                </>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No classifications applied yet.</Caption1>
              )}
            </div>
          </div>

          <div className={s.section} style={{ marginBottom: 20 }}>
            <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Recent permission changes</Subtitle2>
            {shareEvents.length > 0 ? (
              <Table size="small" aria-label="Permission changes">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>When</TableHeaderCell>
                    <TableHeaderCell>Who</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Target</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shareEvents.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell><Caption1>{new Date(e.at).toLocaleString()}</Caption1></TableCell>
                      <TableCell>{e.who}</TableCell>
                      <TableCell><Badge appearance="outline" size="small">{e.kind}</Badge></TableCell>
                      <TableCell><code style={{ fontSize: 11 }}>{e.itemId}</code></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                No recent share / permission events in the last 30 days.
                <a href="/admin/audit-logs" style={{ marginLeft: 8 }}>Browse full audit log</a>
              </Caption1>
            )}
          </div>

          <div className={s.section}>
            <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>External governance systems</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              For deeper Purview-backed scanning, sensitivity label authoring, and DLP policy management
              that's enforced upstream, link out to the Microsoft 365 + Purview portals:
            </Caption1>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              <a href="https://web.purview.azure.com/" target="_blank" rel="noreferrer">
                <Button icon={<Open16Regular />} iconPosition="after">Microsoft Purview</Button>
              </a>
              <a href="https://compliance.microsoft.com/informationprotection" target="_blank" rel="noreferrer">
                <Button icon={<Open16Regular />} iconPosition="after">Information Protection</Button>
              </a>
              <a href="https://compliance.microsoft.com/datalossprevention" target="_blank" rel="noreferrer">
                <Button icon={<Open16Regular />} iconPosition="after">Microsoft 365 DLP</Button>
              </a>
            </div>
          </div>
        </>
      )}
    </AdminShell>
  );
}
