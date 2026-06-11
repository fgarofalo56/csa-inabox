'use client';

/**
 * /admin/usage — REAL usage metrics page (F21). Two real backends:
 *
 *   Cosmos (always on):
 *     - items per type / per workspace (bars)
 *     - daily audit activity (sparkline)
 *     - most-active items (LoomDataTable: sort / resize / filter)
 *
 *   Log Analytics (when LOOM_LOG_ANALYTICS_WORKSPACE_ID is set):
 *     - active-users trend (daily DAU, sparkline)
 *     - feature adoption (events + distinct users per route prefix, bars)
 *
 * Drill-through: a day-window selector (7/14/30d) + a feature filter re-fetch
 * /api/admin/usage?days=N&feature=X live. When Log Analytics is unconfigured
 * the LA sections show an honest MessageBar (the exact env var to set) — never
 * a promotional EmptyState. An optional "Open analytics" embed renders Power BI
 * Embedded (Commercial) or Managed Grafana (Gov) via /api/admin/usage/embed.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, Body1, Subtitle2, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dropdown, Option, Link as FluentLink,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Dismiss16Regular, Open24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';

interface Usage {
  days: number;
  since: string;
  featureFilter: string | null;
  laConfigured: boolean;
  laError: string | null;
  totals: { workspaces: number; items: number; itemTypes: number; auditEvents30d: number };
  itemsByType: Array<{ type: string; count: number }>;
  itemsByWorkspace: Array<{ workspaceId: string; workspaceName: string; count: number }>;
  activity: Array<{ day: string; count: number }>;
  topItems: Array<{ itemId: string; auditCount: number; requestEvents: number; displayName?: string; itemType?: string; workspaceName?: string }>;
  activeUsersTrend: Array<{ day: string; dau: number }>;
  featureAdoption: Array<{ feature: string; events: number; users: number }>;
}

type TopItem = Usage['topItems'][number];

interface Embed {
  ok: boolean;
  kind?: 'powerbi' | 'grafana';
  reportId?: string;
  embedUrl?: string;
  accessToken?: string;
  iframeUrl?: string;
  code?: string;
  error?: string;
  hint?: { missingEnvVar?: string; followUp?: string; bicepStatus?: string };
}

const WINDOWS = [7, 14, 30] as const;

const useStyles = makeStyles({
  intro: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL,
    display: 'block',
  },
  filterBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  filterGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  filterLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
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
  barClickable: {
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
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
  barFillUsers: {
    height: '100%',
    backgroundColor: tokens.colorPaletteGreenBackground3,
    borderRadius: tokens.borderRadiusSmall,
  },
  barCount: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    minWidth: '64px',
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
  sparkBarUsers: {
    flex: 1,
    minWidth: '4px',
    backgroundColor: tokens.colorPaletteGreenBackground3,
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
  grafanaFrame: {
    width: '100%',
    height: '640px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
});

export default function UsagePage() {
  const s = useStyles();
  const [data, setData] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(30);
  const [featureFilter, setFeatureFilter] = useState<string | null>(null);

  // Embedded analytics (Power BI / Grafana) — optional, env-gated.
  const [embed, setEmbed] = useState<Embed | null>(null);

  const load = useCallback(async (d: number, feat: string | null) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ days: String(d) });
      if (feat) qs.set('feature', feat);
      const r = await clientFetch(`/api/admin/usage?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setData(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(days, featureFilter); }, [load, days, featureFilter]);

  // Resolve the embed backend once on mount; 503 → honest gate, not an error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/admin/usage/embed');
        const j = await r.json();
        if (!cancelled) setEmbed(j);
      } catch { if (!cancelled) setEmbed(null); }
    })();
    return () => { cancelled = true; };
  }, []);

  const maxType = Math.max(1, ...((data?.itemsByType || []).map((x) => x.count)));
  const maxWs = Math.max(1, ...((data?.itemsByWorkspace || []).map((x) => x.count)));
  const maxDay = Math.max(1, ...((data?.activity || []).map((x) => x.count)));
  const maxDau = Math.max(1, ...((data?.activeUsersTrend || []).map((x) => x.dau)));
  const maxFeatureEvents = Math.max(1, ...((data?.featureAdoption || []).map((x) => x.events)));
  const peakDau = Math.max(0, ...((data?.activeUsersTrend || []).map((x) => x.dau)));

  const featureOptions = useMemo(
    () => (data?.featureAdoption || []).map((r) => r.feature),
    [data?.featureAdoption],
  );

  const topColumns = useMemo<LoomColumn<TopItem>[]>(() => [
    {
      key: 'displayName',
      label: 'Item',
      width: 260,
      getValue: (r) => r.displayName || r.itemId,
      render: (r) => <span>{r.displayName || r.itemId}</span>,
    },
    {
      key: 'itemType',
      label: 'Type',
      width: 160,
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
      width: 200,
      getValue: (r) => r.workspaceName || '',
      render: (r) => r.workspaceName || <span className={s.muted}>—</span>,
    },
    {
      key: 'requestEvents',
      label: 'Requests',
      width: 110,
      getValue: (r) => r.requestEvents,
      render: (r) => (r.requestEvents ? <strong>{r.requestEvents}</strong> : <span className={s.muted}>—</span>),
    },
    {
      key: 'auditCount',
      label: 'Edits',
      width: 100,
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
        Rolling activity, active-user telemetry, and live tenant inventory. Cosmos workspaces / items / audit-log
        plus Log Analytics request telemetry (active users, feature adoption, item traffic).
      </Body1>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load usage</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Drill-through filter bar */}
      <div className={s.filterBar}>
        <div className={s.filterGroup}>
          <span className={s.filterLabel}>Window</span>
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="small"
              appearance={days === w ? 'primary' : 'secondary'}
              onClick={() => setDays(w)}
              disabled={loading}
            >
              {w}d
            </Button>
          ))}
        </div>
        <div className={s.filterGroup}>
          <span className={s.filterLabel}>Feature</span>
          <Dropdown
            size="small"
            placeholder="All features"
            value={featureFilter ?? 'All features'}
            selectedOptions={featureFilter ? [featureFilter] : []}
            disabled={loading || featureOptions.length === 0}
            onOptionSelect={(_, d2) => setFeatureFilter(d2.optionValue === '__all__' ? null : (d2.optionValue ?? null))}
            style={{ minWidth: 180 }}
          >
            <Option value="__all__" text="All features">All features</Option>
            {featureOptions.map((f) => (
              <Option key={f} value={f} text={f}>{f}</Option>
            ))}
          </Dropdown>
          {featureFilter && (
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss16Regular />}
              onClick={() => setFeatureFilter(null)}
            >
              Clear
            </Button>
          )}
        </div>
        <Button size="small" icon={<ArrowSync24Regular />} onClick={() => load(days, featureFilter)} disabled={loading}>
          Refresh
        </Button>
        {loading && <Spinner size="tiny" />}
      </div>

      {loading && !data && !error && (
        <div className={s.loadingBox}>
          <Spinner label="Computing usage…" />
        </div>
      )}

      {data && (
        <>
          <Section title="Tenant inventory" bare>
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
                <div className={s.statVal}>{peakDau || '—'}</div>
                <div className={s.statLabel}>peak daily active users ({data.days}d)</div>
              </div>
              <div className={s.statCard}>
                <div className={s.statVal}>{data.totals.auditEvents30d}</div>
                <div className={s.statLabel}>edits ({data.days}d)</div>
              </div>
            </div>
          </Section>

          {/* Active users — Log Analytics DAU */}
          <Section title="Active users">
            <div className={s.panel}>
              {!data.laConfigured ? (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Active-user telemetry not connected</MessageBarTitle>
                    Set <code>LOOM_LOG_ANALYTICS_WORKSPACE_ID</code> (and grant the Console UAMI{' '}
                    <strong>Log Analytics Reader</strong> on the workspace) to read daily active users from the
                    Loom Console request telemetry. Inventory and edit activity below come from Cosmos and are
                    always live.
                  </MessageBarBody>
                </MessageBar>
              ) : data.activeUsersTrend.length === 0 ? (
                <Caption1 className={s.muted}>
                  No request telemetry in this window yet. Active users appear here as people use the Console.
                </Caption1>
              ) : (
                <>
                  <Caption1 className={s.muted}>
                    Daily distinct users · peak {peakDau} · last {data.days} days
                  </Caption1>
                  <div className={s.sparkRow}>
                    {data.activeUsersTrend.map((d) => (
                      <div
                        key={d.day}
                        className={s.sparkBarUsers}
                        style={{ height: `${Math.max(4, (d.dau / maxDau) * 100)}%` }}
                        title={`${d.day}: ${d.dau} active users`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </Section>

          {/* Feature adoption — Log Analytics events/users per route prefix */}
          <Section title="Feature adoption">
            <div className={s.panel}>
              {!data.laConfigured ? (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Feature-adoption telemetry not connected</MessageBarTitle>
                    Set <code>LOOM_LOG_ANALYTICS_WORKSPACE_ID</code> to break down requests + distinct users by
                    feature. Click a feature to drill the most-active-items table to that feature&apos;s traffic.
                  </MessageBarBody>
                </MessageBar>
              ) : data.featureAdoption.length === 0 ? (
                <Caption1 className={s.muted}>No feature traffic in this window yet.</Caption1>
              ) : (
                <>
                  <Caption1 className={s.muted}>
                    Requests (blue) and distinct users (green) per feature · click to drill through
                  </Caption1>
                  {data.featureAdoption.slice(0, 15).map((row) => {
                    const active = featureFilter === row.feature;
                    return (
                      <div
                        key={row.feature}
                        className={`${s.bar} ${s.barClickable}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setFeatureFilter(active ? null : row.feature)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFeatureFilter(active ? null : row.feature); } }}
                        style={active ? { backgroundColor: tokens.colorNeutralBackground2Selected } : undefined}
                      >
                        <span className={s.barLabel}>
                          {row.feature}{active ? ' ✓' : ''}
                        </span>
                        <div className={s.barTrack}>
                          <div className={s.barFill} style={{ width: `${(row.events / maxFeatureEvents) * 100}%` }} />
                        </div>
                        <span className={s.barCount}>{row.events} · {row.users}u</span>
                      </div>
                    );
                  })}
                </>
              )}
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

          <Section title={`Activity (last ${data.days} days)`}>
            <div className={s.panel}>
              <Caption1 className={s.muted}>
                Since {new Date(data.since).toLocaleDateString()} · {data.totals.auditEvents30d} edits
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

          <Section
            title={featureFilter ? `Most active items — ${featureFilter} (${data.days}d)` : `Most active items (${data.days}d)`}
            actions={featureFilter ? (
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setFeatureFilter(null)}>
                Clear filter
              </Button>
            ) : undefined}
          >
            <LoomDataTable
              columns={topColumns}
              rows={data.topItems}
              getRowId={(r) => r.itemId}
              ariaLabel="Most active items"
              empty="No item-level activity yet. Activity appears as users edit, run, save, and share items."
            />
          </Section>

          {/* Embedded analytics — optional Power BI / Grafana, env-gated */}
          {embed && (
            <Section title="Open analytics">
              {embed.ok && embed.kind === 'powerbi' && embed.embedUrl && embed.accessToken && embed.reportId ? (
                <PowerBIEmbedFrame
                  embedType="report"
                  id={embed.reportId}
                  embedUrl={embed.embedUrl}
                  accessToken={embed.accessToken}
                  height={640}
                />
              ) : embed.ok && embed.kind === 'grafana' && embed.iframeUrl ? (
                <iframe
                  className={s.grafanaFrame}
                  src={embed.iframeUrl}
                  title="Usage analytics (Managed Grafana)"
                  allow="fullscreen"
                />
              ) : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Embedded analytics not configured</MessageBarTitle>
                    The native charts above are fully live. To embed a curated report, set{' '}
                    <code>{embed.hint?.missingEnvVar || 'LOOM_USAGE_REPORT_KIND'}</code>
                    {embed.hint?.followUp ? ` — ${embed.hint.followUp}` : '.'}
                  </MessageBarBody>
                  {embed.hint?.bicepStatus && (
                    <MessageBarActions>
                      <FluentLink href="https://learn.microsoft.com/azure/managed-grafana/" target="_blank">
                        <Open24Regular style={{ fontSize: 14, verticalAlign: 'middle' }} /> Managed Grafana docs
                      </FluentLink>
                    </MessageBarActions>
                  )}
                </MessageBar>
              )}
            </Section>
          )}
        </>
      )}
    </AdminShell>
  );
}
