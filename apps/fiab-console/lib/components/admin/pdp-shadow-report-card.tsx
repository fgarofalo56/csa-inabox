'use client';

/**
 * PdpShadowReportCard — PDP shadow-mode decision report for /admin/permissions.
 *
 * Surfaces GET /api/admin/pdp/shadow-report (previously ops-only): the
 * `pdp.shadow` rows the policy decision point writes to `_auditLog` while
 * `LOOM_PDP_ENFORCE=shadow`, so a tenant admin can vet what the PDP WOULD
 * decide against real traffic — especially DENYs and divergences from today's
 * behavior — BEFORE flipping `LOOM_PDP_ENFORCE=enforce`.
 *
 * Real Cosmos data only (no-vaporware.md): KPI cards (total / allows / denies
 * / divergences), deny-only + divergent-only filters that re-query the BFF,
 * per-source tallies, and the raw decision rows in the shared LoomDataTable.
 * Loading skeleton, honest 403 remediation, and an honest "no shadow rows yet"
 * state naming the exact env var. Fluent v9 + Loom tokens — matches the
 * sibling RetrievalMetricsCard (web3-ui.md, ux-baseline.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Caption1, Switch, Text,
  Skeleton, SkeletonItem,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ShieldQuestion20Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface ShadowRow {
  id: string;
  ts?: string;
  oid?: string;
  action?: string;
  route?: string;
  effect?: 'allow' | 'deny' | string;
  reason?: string;
  source?: string;
  obligations?: unknown;
  divergence?: boolean;
}

interface ShadowReport {
  ok: true;
  mode: string;
  tenantScope: string;
  note?: string;
  summary: {
    total: number;
    allows: number;
    denies: number;
    divergences: number;
    bySource: Record<string, number>;
    byRoute: Record<string, number>;
    byAction: Record<string, number>;
  };
  rows: ShadowRow[];
}

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalM,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  label: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  value: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  sub: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  filters: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalM,
  },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS, minWidth: 0 },
  skeleton: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

function modeColor(mode: string): 'success' | 'warning' | 'informative' {
  if (mode === 'enforce') return 'success';
  if (mode === 'shadow') return 'warning';
  return 'informative';
}

const COLUMNS: LoomColumn<ShadowRow>[] = [
  {
    key: 'ts', label: 'When', width: 170, filterType: 'date',
    render: (r) => <Caption1>{r.ts ? new Date(r.ts).toLocaleString() : '—'}</Caption1>,
    getValue: (r) => r.ts || '',
  },
  {
    key: 'effect', label: 'Decision', width: 110, filterType: 'select',
    render: (r) =>
      r.effect === 'deny'
        ? <Badge appearance="tint" color="danger" size="small">deny</Badge>
        : r.effect === 'allow'
          ? <Badge appearance="tint" color="success" size="small">allow</Badge>
          : <Badge appearance="tint" color="subtle" size="small">{String(r.effect ?? 'unknown')}</Badge>,
    getValue: (r) => String(r.effect ?? 'unknown'),
  },
  {
    key: 'divergence', label: 'Divergent', width: 110, filterType: 'select',
    render: (r) => (r.divergence === true
      ? <Badge appearance="tint" color="severe" size="small">divergent</Badge>
      : <Caption1>—</Caption1>),
    getValue: (r) => (r.divergence === true ? 'divergent' : '—'),
  },
  { key: 'action', label: 'Action', width: 160 },
  { key: 'route', label: 'Route', width: 240 },
  { key: 'source', label: 'Source', width: 130, filterType: 'select' },
  {
    key: 'reason', label: 'Reason', minWidth: 160,
    render: (r) => <Caption1 style={{ display: 'block', overflowWrap: 'anywhere' }}>{r.reason || '—'}</Caption1>,
    getValue: (r) => r.reason || '',
  },
];

export function PdpShadowReportCard() {
  const s = useStyles();
  const [report, setReport] = useState<ShadowReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<{ message: string; remediation?: string } | null>(null);
  const [denyOnly, setDenyOnly] = useState(false);
  const [divergentOnly, setDivergentOnly] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({ limit: '200' });
    if (denyOnly) qs.set('denyOnly', 'true');
    if (divergentOnly) qs.set('divergentOnly', 'true');
    clientFetch(`/api/admin/pdp/shadow-report?${qs}`, { cache: 'no-store' }, 20_000)
      .then(async (r) => {
        const j: any = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { setReport(j as ShadowReport); return; }
        setErr({
          message: j?.error || `Failed to load the PDP shadow report (HTTP ${r.status})`,
          remediation: j?.remediation,
        });
      })
      .catch((e) => setErr({ message: String(e?.message || e) }))
      .finally(() => setLoading(false));
  }, [denyOnly, divergentOnly]);

  useEffect(() => { load(); }, [load]);

  const sum = report?.summary;

  return (
    <Section
      title="PDP shadow decisions"
      actions={
        <div className={s.toolbar}>
          {report && (
            <Badge appearance="tint" color={modeColor(report.mode)}>
              LOOM_PDP_ENFORCE = {report.mode}
            </Badge>
          )}
          <LearnPopover
            title="PDP shadow report"
            content="While LOOM_PDP_ENFORCE=shadow, the policy decision point evaluates every request and records what it WOULD decide — without changing behavior. Review its denies and divergences here against real traffic before flipping enforcement on."
            tips={[
              'deny rows show what enforcement would block',
              'divergent rows disagree with today’s legacy behavior — vet these first',
              'Set LOOM_PDP_ENFORCE=enforce only after the report looks right',
            ]}
            learnMoreHref="https://learn.microsoft.com/entra/identity-platform/custom-rbac-for-developers"
          />
          <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>
      }
    >
      {err ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{err.message}</MessageBarTitle>
            {err.remediation && <Caption1 className={s.sub}>{err.remediation}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      ) : loading && !report ? (
        <div className={s.skeleton} aria-label="Loading PDP shadow report">
          <div className={s.grid}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} aria-label=""><SkeletonItem shape="rectangle" style={{ height: '88px' }} /></Skeleton>
            ))}
          </div>
          <Skeleton aria-label=""><SkeletonItem shape="rectangle" style={{ height: '200px' }} /></Skeleton>
        </div>
      ) : report && sum ? (
        <>
          <div className={s.grid}>
            <div className={s.card}>
              <span className={s.label}>
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS, color: tokens.colorBrandForeground1 }}>
                  <ShieldQuestion20Regular />
                </span>
                Decisions
              </span>
              <span className={s.value}>{sum.total}</span>
              <Caption1 className={s.sub}>latest {sum.total} shadow rows · tenant {report.tenantScope}</Caption1>
            </div>
            <div className={s.card}>
              <span className={s.label}>Allows</span>
              <span className={s.value} style={{ color: tokens.colorPaletteGreenForeground1 }}>{sum.allows}</span>
              <Caption1 className={s.sub}>PDP agrees the call proceeds</Caption1>
            </div>
            <div className={s.card}>
              <span className={s.label}>Denies</span>
              <span className={s.value} style={{ color: sum.denies > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground1 }}>
                {sum.denies}
              </span>
              <Caption1 className={s.sub}>would be blocked under enforce</Caption1>
            </div>
            <div className={s.card}>
              <span className={s.label}>Divergences</span>
              <span className={s.value} style={{ color: sum.divergences > 0 ? tokens.colorPaletteYellowForeground1 : tokens.colorNeutralForeground1 }}>
                {sum.divergences}
              </span>
              <Caption1 className={s.sub}>PDP disagrees with today&apos;s behavior</Caption1>
            </div>
          </div>

          {Object.entries(sum.bySource).length > 0 && (
            <div className={s.chips}>
              {Object.entries(sum.bySource).map(([src, n]) => (
                <Badge key={src} appearance="outline">{src}: {n}</Badge>
              ))}
            </div>
          )}

          {report.note && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>No shadow decisions recorded yet</MessageBarTitle>
                {report.note}
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.filters}>
            <Switch
              label="Denies only"
              checked={denyOnly}
              onChange={(_, d) => setDenyOnly(d.checked)}
            />
            <Switch
              label="Divergent only"
              checked={divergentOnly}
              onChange={(_, d) => setDivergentOnly(d.checked)}
            />
            {loading && <Text className={s.sub}>Refreshing…</Text>}
          </div>

          <LoomDataTable<ShadowRow>
            columns={COLUMNS}
            rows={report.rows}
            getRowId={(r) => r.id}
            density="compact"
            loading={loading}
            empty="No PDP shadow decisions match the current filters."
          />
        </>
      ) : null}
    </Section>
  );
}

export default PdpShadowReportCard;
