'use client';

/**
 * /admin/usage — REAL usage metrics page. Aggregates from Cosmos:
 *   - items per type (bar)
 *   - items per workspace (bar)
 *   - daily audit activity (sparkline)
 *   - top-10 most-active items
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Caption1, Body1, Subtitle2, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';

interface Usage {
  totals: { workspaces: number; items: number; itemTypes: number; auditEvents30d: number };
  itemsByType: Array<{ type: string; count: number }>;
  itemsByWorkspace: Array<{ workspaceId: string; workspaceName: string; count: number }>;
  activity: Array<{ day: string; count: number }>;
  topItems: Array<{ itemId: string; auditCount: number; displayName?: string; itemType?: string; workspaceName?: string }>;
  since: string;
}

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 12, marginBottom: 20,
  },
  statCard: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  twoCol: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 16, marginBottom: 20,
  },
  section: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0',
  },
  barLabel: { fontSize: 13, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  barTrack: { flex: 1, height: 8, backgroundColor: tokens.colorNeutralBackground3, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: 4 },
  barCount: { fontSize: 12, color: tokens.colorNeutralForeground3, minWidth: 32, textAlign: 'right' },
  sparkRow: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, marginTop: 8 },
  sparkBar: {
    flex: 1, minWidth: 4,
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: 2,
  },
});

export default function UsagePage() {
  const s = useStyles();
  const [data, setData] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/usage');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setData(j);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxType = Math.max(1, ...((data?.itemsByType || []).map((x) => x.count)));
  const maxWs = Math.max(1, ...((data?.itemsByWorkspace || []).map((x) => x.count)));
  const maxDay = Math.max(1, ...((data?.activity || []).map((x) => x.count)));

  return (
    <AdminShell sectionTitle="Usage metrics">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 16 }}>
        30-day rolling activity and live tenant inventory. Aggregated from Cosmos workspaces / items / audit-log.
      </Body1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load usage</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Computing usage…" />}

      {data && (
        <>
          <div className={s.statsRow}>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.totals.workspaces}</div>
              <div className={s.statLabel}>workspaces</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.totals.items}</div>
              <div className={s.statLabel}>items</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.totals.itemTypes}</div>
              <div className={s.statLabel}>distinct types</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.totals.auditEvents30d}</div>
              <div className={s.statLabel}>audit events (30d)</div>
            </div>
          </div>

          <div className={s.twoCol}>
            <div className={s.section}>
              <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Items by type</Subtitle2>
              {data.itemsByType.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No items yet.</Caption1>}
              {data.itemsByType.slice(0, 15).map((row) => (
                <div key={row.type} className={s.bar}>
                  <span className={s.barLabel}>{row.type}</span>
                  <div className={s.barTrack}>
                    <div className={s.barFill} style={{ width: `${(row.count / maxType) * 100}%` }} />
                  </div>
                  <span className={s.barCount}>{row.count}</span>
                </div>
              ))}
            </div>

            <div className={s.section}>
              <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Items by workspace (top 20)</Subtitle2>
              {data.itemsByWorkspace.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No items yet.</Caption1>}
              {data.itemsByWorkspace.map((row) => (
                <div key={row.workspaceId} className={s.bar}>
                  <span className={s.barLabel}>{row.workspaceName}</span>
                  <div className={s.barTrack}>
                    <div className={s.barFill} style={{ width: `${(row.count / maxWs) * 100}%` }} />
                  </div>
                  <span className={s.barCount}>{row.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={s.section} style={{ marginBottom: 20 }}>
            <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Activity (last 30 days)</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Since {new Date(data.since).toLocaleDateString()} · {data.totals.auditEvents30d} events
            </Caption1>
            {data.activity.length === 0 && (
              <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginTop: 8 }}>
                No audit events in this window yet. Activity will appear here as users edit, run, save, and share items.
              </Caption1>
            )}
            {data.activity.length > 0 && (
              <div className={s.sparkRow}>
                {data.activity.map((d) => (
                  <div
                    key={d.day}
                    className={s.sparkBar}
                    style={{ height: `${Math.max(4, (d.count / maxDay) * 100)}%` }}
                    title={`${d.day}: ${d.count} events`}
                  />
                ))}
              </div>
            )}
          </div>

          <div className={s.section}>
            <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Most active items (30d)</Subtitle2>
            {data.topItems.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No item-level activity yet.</Caption1>}
            {data.topItems.length > 0 && (
              <Table size="small" aria-label="Top items">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Item</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Workspace</TableHeaderCell>
                    <TableHeaderCell>Events</TableHeaderCell>
                    <TableHeaderCell></TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topItems.map((t) => (
                    <TableRow key={t.itemId}>
                      <TableCell>{t.displayName || t.itemId}</TableCell>
                      <TableCell>{t.itemType && <Badge appearance="outline" size="small">{t.itemType}</Badge>}</TableCell>
                      <TableCell>{t.workspaceName || '—'}</TableCell>
                      <TableCell><strong>{t.auditCount}</strong></TableCell>
                      <TableCell>
                        {t.itemType && (
                          <a
                            href={`/items/${t.itemType}/${t.itemId}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                          >
                            Open <Open16Regular />
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </AdminShell>
  );
}
