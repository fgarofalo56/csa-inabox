'use client';

/**
 * /admin/usage — REAL usage metrics page. Aggregates from Cosmos:
 *   - items per type (bar)
 *   - items per workspace (bar)
 *   - daily audit activity (sparkline)
 *   - top-10 most-active items (LoomDataTable: sort / resize / filter)
 *
 * UI: KPI stat cards + spaced Section cards (nothing touches edges), and the
 * most-active-items table is a LoomDataTable on the real /api/admin/usage data.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, Body1, Subtitle2, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface Usage {
  totals: { workspaces: number; items: number; itemTypes: number; auditEvents30d: number };
  itemsByType: Array<{ type: string; count: number }>;
  itemsByWorkspace: Array<{ workspaceId: string; workspaceName: string; count: number }>;
  activity: Array<{ day: string; count: number }>;
  topItems: Array<{ itemId: string; auditCount: number; displayName?: string; itemType?: string; workspaceName?: string }>;
  since: string;
}

type TopItem = Usage['topItems'][number];

const useStyles = makeStyles({
  intro: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL,
    display: 'block',
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  statCard: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  statVal: {
    fontSize: '30px',
    lineHeight: '34px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  statLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  twoCol: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  barLabel: {
    fontSize: '13px',
    minWidth: '150px',
    maxWidth: '150px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  barTrack: {
    flex: 1,
    height: '8px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: tokens.borderRadiusSmall,
  },
  barCount: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    minWidth: '36px',
    textAlign: 'right',
  },
  sparkRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    height: '80px',
    marginTop: tokens.spacingVerticalS,
  },
  sparkBar: {
    flex: 1,
    minWidth: '4px',
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: tokens.borderRadiusSmall,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  typeCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  openLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontSize: '12px',
    color: tokens.colorBrandForeground1,
  },
  loadingBox: {
    display: 'flex',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXL,
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxType = Math.max(1, ...((data?.itemsByType || []).map((x) => x.count)));
  const maxWs = Math.max(1, ...((data?.itemsByWorkspace || []).map((x) => x.count)));
  const maxDay = Math.max(1, ...((data?.activity || []).map((x) => x.count)));

  const topColumns = useMemo<LoomColumn<TopItem>[]>(() => [
    {
      key: 'displayName',
      label: 'Item',
      width: 280,
      getValue: (r) => r.displayName || r.itemId,
      render: (r) => <span>{r.displayName || r.itemId}</span>,
    },
    {
      key: 'itemType',
      label: 'Type',
      width: 180,
      getValue: (r) => r.itemType || '',
      render: (r) =>
        r.itemType ? (
          <span className={s.typeCell}>
            <Badge appearance="outline" size="small">{itemVisual(r.itemType).label}</Badge>
          </span>
        ) : (
          <span className={s.muted}>—</span>
        ),
    },
    {
      key: 'workspaceName',
      label: 'Workspace',
      width: 220,
      getValue: (r) => r.workspaceName || '',
      render: (r) => r.workspaceName || <span className={s.muted}>—</span>,
    },
    {
      key: 'auditCount',
      label: 'Events',
      width: 110,
      getValue: (r) => r.auditCount,
      render: (r) => <strong>{r.auditCount}</strong>,
    },
    {
      key: 'open',
      label: '',
      width: 100,
      sortable: false,
      filterable: false,
      render: (r) =>
        r.itemType ? (
          <a className={s.openLink} href={`/items/${r.itemType}/${r.itemId}`}>
            Open <Open16Regular />
          </a>
        ) : null,
    },
  ], [s.typeCell, s.muted, s.openLink]);

  return (
    <AdminShell sectionTitle="Usage metrics">
      <Body1 className={s.intro}>
        30-day rolling activity and live tenant inventory. Aggregated from Cosmos workspaces / items / audit-log.
      </Body1>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load usage</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && (
        <div className={s.loadingBox}>
          <Spinner label="Computing usage…" />
        </div>
      )}

      {data && (
        <>
          <Section
            title="Tenant inventory"
            actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>}
            bare
          >
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
          </Section>

          <Section title="Distribution" bare>
            <div className={s.twoCol}>
              <Section title={undefined}>
                <div className={s.panel}>
                  <Subtitle2>Items by type</Subtitle2>
                  {data.itemsByType.length === 0 && <Caption1 className={s.muted}>No items yet.</Caption1>}
                  {data.itemsByType.slice(0, 15).map((row) => (
                    <div key={row.type} className={s.bar}>
                      <span className={s.barLabel}>{itemVisual(row.type).label}</span>
                      <div className={s.barTrack}>
                        <div className={s.barFill} style={{ width: `${(row.count / maxType) * 100}%` }} />
                      </div>
                      <span className={s.barCount}>{row.count}</span>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title={undefined}>
                <div className={s.panel}>
                  <Subtitle2>Items by workspace (top 20)</Subtitle2>
                  {data.itemsByWorkspace.length === 0 && <Caption1 className={s.muted}>No items yet.</Caption1>}
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
              </Section>
            </div>
          </Section>

          <Section title="Activity (last 30 days)">
            <div className={s.panel}>
              <Caption1 className={s.muted}>
                Since {new Date(data.since).toLocaleDateString()} · {data.totals.auditEvents30d} events
              </Caption1>
              {data.activity.length === 0 && (
                <Caption1 className={s.muted}>
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
          </Section>

          <Section title="Most active items (30d)">
            <LoomDataTable
              columns={topColumns}
              rows={data.topItems}
              getRowId={(r) => r.itemId}
              ariaLabel="Most active items"
              empty="No item-level activity yet. Activity appears as users edit, run, save, and share items."
            />
          </Section>
        </>
      )}
    </AdminShell>
  );
}
