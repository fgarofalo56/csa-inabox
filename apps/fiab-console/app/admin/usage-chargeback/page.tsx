'use client';

/**
 * /admin/usage-chargeback — Unified capacity + chargeback dashboard.
 *
 * The Azure-native 1:1 of the Fabric Capacity Metrics app: "who consumed what"
 * across every engine, in one place. Real Azure Cost Management spend +
 * real Azure Monitor utilization, normalized to a single Loom Capacity Unit
 * (LCU) with a throttle/surge gauge. No mock/sample data — an honest MessageBar
 * gate names the exact remediation (Cost Management Reader + LOOM_BILLING_SCOPE)
 * when the role/scope isn't granted.
 *
 * Backend: GET /api/admin/capacity/chargeback?timeframe=… (tenant-admin gated).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Spinner, Dropdown, Option, Text, Button,
  TabList, Tab, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Title3, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Money20Regular, ArrowClockwise16Regular, TopSpeed20Regular, Server20Regular,
  CloudCube20Regular, Building20Regular, DataHistogram20Regular, Gauge20Regular,
  Warning20Filled, CheckmarkCircle20Filled,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { EmptyState } from '@/lib/components/empty-state';
import { MetricChart } from '@/lib/components/monitor/metric-chart';

// ---- model (mirrors lib/azure/cost-management-client.ts) --------------------

interface CostRow { key: string; cost: number; pctOfTotal: number }
interface WorkspaceChargeback { workspace: string; cost: number; pctOfTotal: number; lcu: number }
interface EngineCU {
  engine: string; label: string; resourceCount: number; nativeUnit: string; nativeUnits: number;
  lcuPerUnit: number; lcu: number; peakLcu: number; utilizationPct: number | null; throttleEvents: number; note?: string;
}
interface NormalizedCapacity {
  totalLcu: number; capacityLcu: number; capacitySource: 'env' | 'derived'; utilizationPct: number;
  throttled: boolean; throttleEvents: number; surge: 'none' | 'elevated' | 'critical';
  engines: EngineCU[]; windowHours: number; derivation: string;
}
interface ChargebackModel {
  currency: string; timeframe: string; windowHours: number; totalCost: number; forecast: number;
  trendPct: number | null; perService: CostRow[]; perResourceType: CostRow[]; compute: CostRow[]; storage: CostRow[];
  perWorkspace: WorkspaceChargeback[]; timeSeries: { date: string; cost: number }[];
  normalizedCU: NormalizedCapacity; scope: string; subscriptions: string[];
  subscriptionErrors: { subscription: string; error: string }[]; generatedAt: string;
}
interface Gate { missing: string[]; message: string; scope?: string }

type TabId = 'overview' | 'compute' | 'storage' | 'workspace' | 'timepoint';

/**
 * Longer client ceiling for the chargeback load. This route aggregates
 * Microsoft.CostManagement across every Loom subscription — a genuinely slow
 * query (often 10-30s, more across multiple subscriptions or under QPU
 * throttling). The shared `clientFetch` 6s page-load default aborted it before
 * the route could answer, so the dashboard almost always showed its timeout
 * state instead of data. Wait for the route (server `maxDuration = 90`) with a
 * still-bounded budget so a stalled route can't pin the spinner forever. The
 * honest timeout error remains the final fallback if even this is exceeded.
 */
const CHARGEBACK_FETCH_TIMEOUT_MS = 80_000;

const TIMEFRAMES: { value: string; label: string }[] = [
  { value: 'MonthToDate', label: 'Month to date' },
  { value: 'BillingMonthToDate', label: 'Billing month to date' },
  { value: 'Last7Days', label: 'Last 7 days' },
  { value: 'Last30Days', label: 'Last 30 days' },
  { value: 'TheLastMonth', label: 'Last month' },
];

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL,
  },
  grow: { flexGrow: 1 },
  kpiGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  kpi: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  kpiHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 },
  kpiValue: { fontSize: '28px', fontWeight: 700, color: tokens.colorNeutralForeground1, lineHeight: 1.1 },
  kpiSub: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  tabPanel: { paddingTop: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  chartRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM },
  gaugeWrap: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXL, flexWrap: 'wrap' },
  gaugeText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  gaugeBig: { fontSize: '40px', fontWeight: 800, lineHeight: 1 },
  legend: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  legendItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: '12px', color: tokens.colorNeutralForeground2 },
  derivation: { color: tokens.colorNeutralForeground3, fontSize: '11px', lineHeight: 1.5, maxWidth: '900px' },
});

const money = (n: number, ccy: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy || 'USD', maximumFractionDigits: 2 }).format(n || 0);
const num = (n: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 }).format(n || 0);

const surgeColor: Record<NormalizedCapacity['surge'], string> = {
  none: tokens.colorPaletteGreenForeground1,
  elevated: tokens.colorPaletteYellowForeground1,
  critical: tokens.colorPaletteRedForeground1,
};
const surgeLabel: Record<NormalizedCapacity['surge'], string> = {
  none: 'Healthy', elevated: 'Elevated', critical: 'Throttling / at capacity',
};

/** Radial LCU gauge — the Loom analogue of the Fabric CU% dial. */
function CuGauge({ cap }: { cap: NormalizedCapacity }) {
  const styles = useStyles();
  const pct = Math.max(0, Math.min(150, cap.utilizationPct));
  const R = 70, C = 80, STROKE = 14;
  const circ = Math.PI * R; // half circle
  const frac = Math.min(1, pct / 100);
  const dash = `${circ * frac} ${circ}`;
  const color = surgeColor[cap.surge];
  return (
    <div className={styles.gaugeWrap}>
      <svg viewBox="0 0 160 100" width="200" height="120" role="img" aria-label={`Loom Capacity Unit utilization ${pct}%`}>
        <path d={`M ${C - R} 90 A ${R} ${R} 0 0 1 ${C + R} 90`} fill="none" stroke={tokens.colorNeutralStroke2} strokeWidth={STROKE} strokeLinecap="round" />
        <path
          d={`M ${C - R} 90 A ${R} ${R} 0 0 1 ${C + R} 90`}
          fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round"
          strokeDasharray={dash} style={{ transition: 'stroke-dasharray 400ms ease' }}
        />
        <text x={C} y="78" textAnchor="middle" fontSize="26" fontWeight="800" fill={tokens.colorNeutralForeground1}>{num(pct)}%</text>
      </svg>
      <div className={styles.gaugeText}>
        <span className={styles.gaugeBig} style={{ color }}>{num(cap.totalLcu)} <Text size={300} style={{ fontWeight: 400 }}>LCU</Text></span>
        <Caption1>of {num(cap.capacityLcu)} LCU capacity ({cap.capacitySource === 'env' ? 'LOOM_CAPACITY_LCU' : 'auto-derived + 25% headroom'})</Caption1>
        <div>
          {cap.throttled
            ? <Badge appearance="filled" color="danger" icon={<Warning20Filled />}>Throttled · {cap.throttleEvents} events</Badge>
            : <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled />}>No throttling</Badge>}
          {' '}
          <Badge appearance="tint" style={{ color }}>{surgeLabel[cap.surge]}</Badge>
        </div>
        <Caption1>Over the last {Math.round(cap.windowHours / 24)} days across {cap.engines.length} engines.</Caption1>
      </div>
    </div>
  );
}

function KpiCards({ m }: { m: ChargebackModel }) {
  const styles = useStyles();
  const trend = m.trendPct;
  return (
    <div className={styles.kpiGrid}>
      <div className={styles.kpi}>
        <span className={styles.kpiHead}><Money20Regular /> <Caption1>Total spend</Caption1></span>
        <span className={styles.kpiValue}>{money(m.totalCost, m.currency)}</span>
        <span className={styles.kpiSub}>{TIMEFRAMES.find((t) => t.value === m.timeframe)?.label || m.timeframe}</span>
      </div>
      <div className={styles.kpi}>
        <span className={styles.kpiHead}><TopSpeed20Regular /> <Caption1>Forecast (period end)</Caption1></span>
        <span className={styles.kpiValue}>{money(m.forecast, m.currency)}</span>
        <span className={styles.kpiSub}>linear run-rate projection</span>
      </div>
      <div className={styles.kpi}>
        <span className={styles.kpiHead}><DataHistogram20Regular /> <Caption1>Trend vs prior period</Caption1></span>
        <span className={styles.kpiValue} style={{ color: trend == null ? undefined : trend > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>
          {trend == null ? '—' : `${trend > 0 ? '+' : ''}${trend}%`}
        </span>
        <span className={styles.kpiSub}>{trend == null ? 'no comparable prior period' : 'change in actual cost'}</span>
      </div>
      <div className={styles.kpi}>
        <span className={styles.kpiHead}><Gauge20Regular /> <Caption1>Capacity utilization</Caption1></span>
        <span className={styles.kpiValue} style={{ color: surgeColor[m.normalizedCU.surge] }}>{num(m.normalizedCU.utilizationPct)}%</span>
        <span className={styles.kpiSub}>{num(m.normalizedCU.totalLcu)} / {num(m.normalizedCU.capacityLcu)} LCU</span>
      </div>
    </div>
  );
}

const costColumns = (ccy: string): LoomColumn<CostRow>[] => [
  { key: 'key', label: 'Service', width: 320 },
  { key: 'cost', label: `Cost (${ccy})`, getValue: (r) => r.cost, render: (r) => money(r.cost, ccy), width: 160 },
  { key: 'pctOfTotal', label: '% of total', getValue: (r) => r.pctOfTotal, render: (r) => `${r.pctOfTotal}%`, width: 120 },
];

// ARM types come back verbose + lower-cased (e.g. `microsoft.synapse/workspaces`);
// show the readable `synapse/workspaces` tail without the provider prefix.
const typeLabel = (k: string) => k.replace(/^microsoft\./i, '');
const resourceTypeColumns = (ccy: string): LoomColumn<CostRow>[] => [
  { key: 'key', label: 'Resource type', width: 320, getValue: (r) => typeLabel(r.key), render: (r) => <strong>{typeLabel(r.key)}</strong> },
  { key: 'cost', label: `Cost (${ccy})`, getValue: (r) => r.cost, render: (r) => money(r.cost, ccy), width: 160 },
  { key: 'pctOfTotal', label: '% of total', getValue: (r) => r.pctOfTotal, render: (r) => `${r.pctOfTotal}%`, width: 120 },
];

// ---- AI token consumption (Copilot + AI functions) --------------------------
// Real per-persona AOAI token counts from App Insights copilot.usage events
// (via /api/admin/copilot-usage), including the `ai-function` persona emitted by
// the AI Functions surface. estCostUsd is a list-price estimate over the REAL
// token counts — surfaced here so the chargeback view attributes AI spend the
// same way it attributes every other engine.

interface AiPersonaRow {
  persona: string; promptTokens: number; completionTokens: number; totalTokens: number; calls: number; estCostUsd?: number;
}
interface AiUsageData {
  byPersona: AiPersonaRow[];
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number; estCostUsd?: number };
  days: number;
}
interface AiUsageResp { ok: boolean; data?: AiUsageData | null; noEvents?: boolean; gate?: { message: string }; error?: string }

const AI_PERSONA_LABELS: Record<string, string> = {
  'cross-item': 'Cross-item Copilot',
  'help-chat': 'Help chat widget',
  'ai-function': 'AI functions',
  'data-agent': 'Data agent',
  notebook: 'Notebook Copilot',
  unknown: 'Other',
};

function AiTokenConsumption() {
  const styles = useStyles();
  const [resp, setResp] = useState<AiUsageResp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch('/api/admin/copilot-usage?days=30', { cache: 'no-store' }, 30_000);
      setResp(await r.json());
    } catch (e) {
      setResp({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const data = resp?.ok ? resp.data ?? null : null;
  const rows = data?.byPersona ?? [];
  const columns: LoomColumn<AiPersonaRow>[] = [
    { key: 'persona', label: 'Surface', width: 220, render: (r) => AI_PERSONA_LABELS[r.persona] || r.persona },
    { key: 'calls', label: 'Calls', getValue: (r) => r.calls, render: (r) => num(r.calls), width: 110 },
    { key: 'totalTokens', label: 'Total tokens', getValue: (r) => r.totalTokens, render: (r) => <strong>{num(r.totalTokens)}</strong>, width: 160 },
    { key: 'promptTokens', label: 'Prompt', getValue: (r) => r.promptTokens, render: (r) => num(r.promptTokens), width: 130 },
    { key: 'completionTokens', label: 'Completion', getValue: (r) => r.completionTokens, render: (r) => num(r.completionTokens), width: 130 },
    { key: 'estCostUsd', label: 'Est. cost', getValue: (r) => r.estCostUsd ?? 0, render: (r) => money(r.estCostUsd ?? 0, 'USD'), width: 130 },
  ];

  return (
    <Section title="AI token consumption (Copilot + AI functions)">
      <Caption1 className={styles.derivation}>
        Real Azure OpenAI prompt/completion tokens per surface over the last 30 days, from
        Application Insights <code>copilot.usage</code> events (includes the AI Functions surface).
        Estimated cost applies published list prices to the real token counts.
      </Caption1>
      {loading && !resp && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXL }}>
          <Spinner size="small" label="Querying App Insights…" />
        </div>
      )}
      {resp && !resp.ok && resp.gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>AI token metering not configured</MessageBarTitle>
            {resp.gate.message}
          </MessageBarBody>
        </MessageBar>
      )}
      {resp && resp.ok && resp.noEvents && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No AI calls recorded yet</MessageBarTitle>
            Run a Copilot or AI Function call — per-surface token counts appear here within ~5 minutes of App Insights ingestion.
          </MessageBarBody>
        </MessageBar>
      )}
      {resp && !resp.ok && !resp.gate && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t load AI token usage</MessageBarTitle>
            {resp.error || 'unknown error'}
          </MessageBarBody>
        </MessageBar>
      )}
      {data && (
        <>
          <div className={styles.kpiGrid}>
            <div className={styles.kpi}>
              <span className={styles.kpiHead}><DataHistogram20Regular /> <Caption1>AI tokens (30d)</Caption1></span>
              <span className={styles.kpiValue}>{num(data.totals.totalTokens)}</span>
              <span className={styles.kpiSub}>{num(data.totals.calls)} calls across all surfaces</span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiHead}><Money20Regular /> <Caption1>Estimated AI cost (30d)</Caption1></span>
              <span className={styles.kpiValue}>{money(data.totals.estCostUsd || 0, 'USD')}</span>
              <span className={styles.kpiSub}>real tokens × published list price</span>
            </div>
          </div>
          <LoomDataTable<AiPersonaRow>
            columns={columns} rows={rows} getRowId={(r) => r.persona}
            ariaLabel="AI token consumption by surface"
            empty={<EmptyState title="No AI usage in window" body="No copilot.usage events recorded in the last 30 days." />}
          />
        </>
      )}
    </Section>
  );
}

/**
 * ChargebackPane — the unified capacity + chargeback surface WITHOUT AdminShell
 * chrome, so it embeds both in the Admin page (below) and in the top-level
 * Reports hub (/org-reports). Real Cost Management + Azure Monitor; a non-admin
 * who reaches the tenant-admin-gated API sees the honest 403 message.
 */
export function ChargebackPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabId>('overview');
  const [timeframe, setTimeframe] = useState('MonthToDate');
  const [loading, setLoading] = useState(true);
  const [unauth, setUnauth] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ChargebackModel | null>(null);

  const load = useCallback(async (tf: string) => {
    setLoading(true); setError(null); setGate(null);
    try {
      const res = await clientFetch(`/api/admin/capacity/chargeback?timeframe=${encodeURIComponent(tf)}`, { cache: 'no-store' }, CHARGEBACK_FETCH_TIMEOUT_MS);
      if (res.status === 401) { setUnauth(true); setLoading(false); return; }
      const j = await res.json().catch(() => null);
      if (res.status === 403) { setError(j?.reason || j?.error || 'Tenant-admin access required.'); setLoading(false); return; }
      if (j?.ok === false && j?.gate) { setGate(j.gate as Gate); setLoading(false); return; }
      if (j?.ok === false) { setError(j?.error || 'Failed to load chargeback data.'); setLoading(false); return; }
      setModel(j.data as ChargebackModel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(timeframe); }, [timeframe, load]);

  const ccy = model?.currency || 'USD';

  return (
    <>
      {unauth && <SignInRequired subject="the usage & chargeback dashboard" />}
      {!unauth && (
        <>
          <TeachingBanner
            surfaceKey="admin-usage-chargeback"
            title="One capacity unit across every engine"
            message="Real Azure Cost Management spend and Azure Monitor utilization, normalized to a single Loom Capacity Unit (LCU) so you can compare Synapse, Databricks, ADX, and storage on one scale. This is the Azure-native 1:1 of the Fabric Capacity Metrics app — chart-first, with per-engine and per-workspace breakdowns."
            icon={Money20Regular}
            learnMoreHref="https://learn.microsoft.com/fabric/enterprise/metrics-app"
          />
          <div className={styles.toolbar}>
            <Body1>
              Unified capacity + chargeback across every engine — real Azure Cost Management spend and Azure Monitor
              utilization, normalized to one Loom Capacity Unit (LCU). The Azure-native 1:1 of the Fabric Capacity Metrics app.
            </Body1>
            <span className={styles.grow} />
            <Dropdown
              aria-label="Timeframe"
              value={TIMEFRAMES.find((t) => t.value === timeframe)?.label}
              selectedOptions={[timeframe]}
              onOptionSelect={(_, d) => d.optionValue && setTimeframe(d.optionValue)}
              style={{ minWidth: 190 }}
            >
              {TIMEFRAMES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
            </Dropdown>
            <Button icon={<ArrowClockwise16Regular />} appearance="secondary" onClick={() => void load(timeframe)} disabled={loading}>
              Refresh
            </Button>
          </div>

          {error && (
            <MessageBar intent="error" className={styles.toolbar}>
              <MessageBarBody><MessageBarTitle>Couldn’t load chargeback data</MessageBarTitle> {error}</MessageBarBody>
            </MessageBar>
          )}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Grant Cost Management Reader to light up this dashboard</MessageBarTitle>
                {gate.message}
                {gate.scope ? <><br /><Caption1>Current billing scope: <code>{gate.scope}</code></Caption1></> : null}
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => void load(timeframe)}>Retry</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {loading && !model && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXXL }}><Spinner label="Aggregating cost + utilization…" /></div>
          )}

          {model && !gate && (
            <>
              <KpiCards m={model} />

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)}>
                <Tab value="overview" icon={<Gauge20Regular />}>Overview</Tab>
                <Tab value="compute" icon={<Server20Regular />}>Compute</Tab>
                <Tab value="storage" icon={<CloudCube20Regular />}>Storage</Tab>
                <Tab value="workspace" icon={<Building20Regular />}>By workspace</Tab>
                <Tab value="timepoint" icon={<DataHistogram20Regular />}>Timepoint</Tab>
              </TabList>

              {tab === 'overview' && (
                <div className={styles.tabPanel}>
                  <Section title="Normalized capacity (Loom Capacity Unit)">
                    <CuGauge cap={model.normalizedCU} />
                    <div className={styles.legend}>
                      {model.normalizedCU.engines.map((e) => (
                        <span key={e.engine} className={styles.legendItem}>
                          <Server20Regular /> {e.label}: <strong>{num(e.lcu)} LCU</strong>
                          {e.resourceCount ? ` · ${e.resourceCount} resource${e.resourceCount > 1 ? 's' : ''}` : ' · none'}
                          {e.throttleEvents ? ` · ⚠ ${e.throttleEvents} throttled` : ''}
                        </span>
                      ))}
                    </div>
                    <Text className={styles.derivation}>{model.normalizedCU.derivation}</Text>
                  </Section>

                  <Section title="Spend over time">
                    {model.timeSeries.length
                      ? <MetricChart title={`Daily cost (${ccy})`} unit={ccy} points={model.timeSeries.map((d) => ({ timeStamp: d.date, value: d.cost }))} />
                      : <EmptyState title="No daily cost yet" body="Cost Management has not returned a daily series for this window. It backfills within ~24h of first spend." />}
                  </Section>

                  <Section title="Cost by service">
                    <LoomDataTable<CostRow>
                      columns={costColumns(ccy)} rows={model.perService} getRowId={(r) => r.key}
                      ariaLabel="Cost by service"
                      empty={<EmptyState title="No spend in window" body="No Azure Cost Management line items for the Loom resource groups in this timeframe." />}
                    />
                  </Section>

                  <Section title="Cost by resource type">
                    <Caption1 className={styles.derivation}>
                      Every Loom-managed Azure resource type — Synapse, Data Explorer, ADLS/Storage, Databricks, Cosmos,
                      Container Apps, Event Hubs, API Management and the rest — grouped + totaled across every Loom
                      subscription from the real Cost Management <code>ResourceType</code> dimension.
                    </Caption1>
                    <LoomDataTable<CostRow>
                      columns={resourceTypeColumns(ccy)} rows={model.perResourceType} getRowId={(r) => r.key}
                      ariaLabel="Cost by resource type"
                      empty={<EmptyState title="No spend in window" body="Cost Management returned no per-resource-type line items for the Loom resource groups in this timeframe." />}
                    />
                  </Section>
                </div>
              )}

              {tab === 'compute' && (
                <div className={styles.tabPanel}>
                  <Section title="Per-engine consumption (normalized-CU)">
                    <LoomDataTable<EngineCU>
                      columns={[
                        { key: 'label', label: 'Engine', width: 260 },
                        { key: 'resourceCount', label: 'Resources', getValue: (r) => r.resourceCount, width: 100 },
                        { key: 'nativeUnits', label: 'Native usage', getValue: (r) => r.nativeUnits, render: (r) => `${num(r.nativeUnits)} ${r.nativeUnit}`, width: 200 },
                        { key: 'utilizationPct', label: 'Utilization', getValue: (r) => r.utilizationPct ?? -1, render: (r) => (r.utilizationPct == null ? '—' : `${r.utilizationPct}%`), width: 120 },
                        { key: 'lcu', label: 'LCU', getValue: (r) => r.lcu, render: (r) => <strong>{num(r.lcu)}</strong>, width: 120 },
                        { key: 'throttleEvents', label: 'Throttling', getValue: (r) => r.throttleEvents, render: (r) => (r.throttleEvents ? <Badge color="danger" appearance="tint">{r.throttleEvents}</Badge> : '—'), width: 110 },
                      ]}
                      rows={model.normalizedCU.engines} getRowId={(r) => r.engine}
                      ariaLabel="Per-engine normalized capacity"
                      empty={<EmptyState title="No engine metrics" body="Azure Monitor returned no utilization for the mapped engines in this window." />}
                    />
                  </Section>
                  <Section title="Compute cost by service">
                    <LoomDataTable<CostRow>
                      columns={costColumns(ccy)} rows={model.compute} getRowId={(r) => r.key}
                      ariaLabel="Compute cost by service"
                      empty={<EmptyState title="No compute spend" body="No compute-classified Cost Management line items in this timeframe." />}
                    />
                  </Section>
                </div>
              )}

              {tab === 'storage' && (
                <div className={styles.tabPanel}>
                  <Section title="Storage cost by service">
                    <LoomDataTable<CostRow>
                      columns={costColumns(ccy)} rows={model.storage} getRowId={(r) => r.key}
                      ariaLabel="Storage cost by service"
                      empty={<EmptyState title="No storage spend" body="No storage-classified Cost Management line items (ADLS, Blob, Cosmos storage, backup) in this timeframe." />}
                    />
                  </Section>
                </div>
              )}

              {tab === 'workspace' && (
                <div className={styles.tabPanel}>
                  <Section title="Chargeback by workspace">
                    <Caption1 className={styles.derivation}>
                      Cost is allocated by resource group — the Loom workspace boundary. LCU is charged back cost-weighted so
                      each workspace carries its share of the single consumption number.
                    </Caption1>
                    <LoomDataTable<WorkspaceChargeback>
                      columns={[
                        { key: 'workspace', label: 'Workspace (resource group)', width: 360 },
                        { key: 'cost', label: `Cost (${ccy})`, getValue: (r) => r.cost, render: (r) => money(r.cost, ccy), width: 160 },
                        { key: 'pctOfTotal', label: '% of total', getValue: (r) => r.pctOfTotal, render: (r) => `${r.pctOfTotal}%`, width: 120 },
                        { key: 'lcu', label: 'LCU (allocated)', getValue: (r) => r.lcu, render: (r) => num(r.lcu), width: 140 },
                      ]}
                      rows={model.perWorkspace} getRowId={(r) => r.workspace}
                      ariaLabel="Chargeback by workspace"
                      empty={<EmptyState title="No workspace spend" body="No Cost Management line items grouped by resource group in this timeframe." />}
                    />
                  </Section>
                </div>
              )}

              {tab === 'timepoint' && (
                <div className={styles.tabPanel}>
                  <Section title="Timepoint explorer">
                    {model.timeSeries.length ? (
                      <>
                        <MetricChart title={`Daily cost (${ccy})`} unit={ccy} points={model.timeSeries.map((d) => ({ timeStamp: d.date, value: d.cost }))} />
                        {(() => {
                          const peak = [...model.timeSeries].sort((a, b) => b.cost - a.cost)[0];
                          return peak ? <Caption1>Busiest day: <strong>{peak.date}</strong> at {money(peak.cost, ccy)}.</Caption1> : null;
                        })()}
                      </>
                    ) : <EmptyState title="No timepoints" body="No daily cost series available for this window yet." />}
                  </Section>
                  <Section title="By subscription">
                    <div className={styles.chartRow}>
                      {model.subscriptions.map((sub) => (
                        <div key={sub} className={styles.kpi}>
                          <Caption1>Subscription</Caption1>
                          <Text style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{sub}</Text>
                          {model.subscriptionErrors.find((e) => e.subscription === sub)
                            ? <Badge appearance="tint" color="warning">No Cost Management access</Badge>
                            : <Badge appearance="tint" color="success">Reporting</Badge>}
                        </div>
                      ))}
                    </div>
                    {model.subscriptionErrors.length > 0 && (
                      <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>Some subscriptions are missing Cost Management Reader</MessageBarTitle>
                          {model.subscriptionErrors.map((e) => <div key={e.subscription}><code>{e.subscription}</code>: {e.error}</div>)}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </Section>
                </div>
              )}

              <Caption1 className={styles.derivation} style={{ marginTop: tokens.spacingVerticalL }}>
                Scope: <code>{model.scope}</code> · generated {new Date(model.generatedAt).toLocaleString()} · source: Azure Cost Management + Azure Monitor (real, no sample data).
              </Caption1>

              <AiTokenConsumption />
            </>
          )}
        </>
      )}
    </>
  );
}

export default function UsageChargebackPage() {
  return (
    <AdminShell
      sectionTitle="Usage & chargeback"
      learn={{
        title: 'Usage & chargeback',
        content: 'Unified capacity and chargeback across every engine, combining real Azure Cost Management spend with Azure Monitor utilization, normalized to one Loom Capacity Unit (LCU) with a throttle/surge gauge. This is the Azure-native 1:1 of the Fabric Capacity Metrics app — actual dollars and real utilization, not estimates.',
        tips: [
          'Change the timeframe dropdown to move between billing windows; Refresh re-pulls live spend and utilization.',
          'The dashboard needs the Console UAMI to hold Cost Management Reader on the billing scope — an honest gate names it when missing.',
          'LCU normalization lets you compare cost and load across engines that bill in different units.',
        ],
      }}
    >
      <ChargebackPane />
    </AdminShell>
  );
}
