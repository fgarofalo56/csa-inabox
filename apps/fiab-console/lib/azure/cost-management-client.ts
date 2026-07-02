/**
 * Unified capacity + chargeback client — the Azure-native 1:1 of the Fabric
 * Capacity Metrics app ("who consumed what" across every engine, one number).
 *
 * Fabric answers capacity with a single Capacity Unit (CU) smoothed across
 * every workload. Loom has NO single Fabric SKU (per
 * .claude/rules/no-fabric-dependency.md every engine is a real Azure service),
 * so we synthesise the same story from two REAL Azure backends:
 *
 *   1. Azure Cost Management  (Microsoft.CostManagement/query)  → actual $ cost
 *      by service, by resource-group / workspace (chargeback), and a daily
 *      time-series + run-rate forecast. Delegates to the battle-tested
 *      multi-subscription cost-client for the throttle-aware query loop.
 *   2. Azure Monitor platform metrics (microsoft.insights/metrics) → live
 *      utilization per engine (Synapse DWU, ADX CPU/cache, Container Apps
 *      vCPU, Azure OpenAI tokens, Stream Analytics SU%). Each engine's native
 *      billable signal is mapped to a common **Loom Capacity Unit (LCU)** via a
 *      published coefficient, so there is ONE consumption + throttle number
 *      exactly like Fabric CU%.
 *
 * REAL only — no mock/sample cost or usage arrays. When the Console UAMI lacks
 * "Cost Management Reader" (or LOOM_BILLING_SCOPE / LOOM_SUBSCRIPTION_ID is
 * unset) the caller surfaces an honest 503 gate naming the exact remediation.
 *
 *   https://learn.microsoft.com/rest/api/cost-management/query/usage
 *   https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics
 */
import {
  getLoomCostSummary,
  loomSubscriptions,
  MonitorError,
  MonitorNotConfiguredError,
  type CostSummary,
  type CostTimeframe,
} from './cost-client';
import { armGet } from './arm-client';
import { fetchMetrics, listResources, type LoomResource } from './monitor-client';

export { MonitorError, MonitorNotConfiguredError };

/**
 * The resolved Cost Management scope. LOOM_BILLING_SCOPE lets an operator point
 * the chargeback rollup at a billing account / enrollment / management group
 * (e.g. "/providers/Microsoft.Billing/billingAccounts/{id}") instead of the
 * per-subscription default. Informational only here — the underlying cost query
 * still runs per Loom subscription (the widest scope the Console UAMI reliably
 * has Cost Management Reader on); the value is echoed so the UI can show which
 * scope the numbers roll up to and so the honest-gate names it.
 */
export function billingScope(): string {
  const explicit = (process.env.LOOM_BILLING_SCOPE || '').trim();
  if (explicit) return explicit;
  const subs = loomSubscriptions();
  return subs.length ? `/subscriptions/${subs[0]}` : '(unconfigured — set LOOM_BILLING_SCOPE)';
}

// ---------------------------------------------------------------------------
// Normalized Loom Capacity Unit (LCU) — the engine coefficient table.
//
// 1 LCU is defined as the smoothed consumption of ONE compute-hour of a
// baseline engine slice. Every engine's native billable signal is converted to
// LCU via `lcuPerUnit`, so a single LCU total spans Synapse, ADX, Container
// Apps, Azure OpenAI and Stream Analytics — the Loom analogue of a Fabric CU.
// Coefficients are published (returned in the model) so the UI can show the
// exact derivation — nothing here is hidden or fabricated.
// ---------------------------------------------------------------------------

type EngineKind = 'percent' | 'nanocores' | 'sum' | 'synapse-dwu' | 'note';

interface EngineDef {
  key: string;
  label: string;
  /** Lowercased ARM type this engine matches in the inventory. */
  type: string;
  kind: EngineKind;
  /** Azure Monitor metric + aggregation for the consumption signal. */
  metric?: string;
  agg?: string;
  /** Throttling metric (Total) — non-zero ⇒ the engine is being throttled. */
  throttleMetric?: string;
  nativeUnit: string;
  /** LCU per one native unit. */
  lcuPerUnit: number;
  note?: string;
}

const CU_ENGINES: EngineDef[] = [
  {
    key: 'synapse-sql',
    label: 'Synapse dedicated SQL (DWU)',
    type: 'microsoft.synapse/workspaces',
    kind: 'synapse-dwu',
    nativeUnit: 'DWU-hour',
    // A DW100c is ~1/64th of a mid Fabric F-family CU-hour; 0.5 LCU/DWU-hour
    // keeps a DW1000c ≈ 500 LCU-hour steady, on the same order as ADX/ACA.
    lcuPerUnit: 0.5,
  },
  {
    key: 'adx',
    label: 'Azure Data Explorer / Eventhouse',
    type: 'microsoft.kusto/clusters',
    kind: 'percent',
    metric: 'CPU',
    agg: 'Average',
    throttleMetric: 'TotalNumberOfThrottledQueries',
    nativeUnit: 'compute-hour',
    // A fully-utilized ADX cluster-hour = 100 LCU (baseline compute reference).
    lcuPerUnit: 100,
  },
  {
    key: 'aca',
    label: 'Container Apps (vCPU-seconds)',
    type: 'microsoft.app/containerapps',
    kind: 'nanocores',
    metric: 'UsageNanoCores',
    agg: 'Average',
    nativeUnit: 'vCPU-second',
    // 1 vCPU-hour = 36 LCU ⇒ 0.01 LCU per vCPU-second.
    lcuPerUnit: 0.01,
  },
  {
    key: 'aoai',
    label: 'Azure OpenAI (tokens)',
    type: 'microsoft.cognitiveservices/accounts',
    kind: 'sum',
    metric: 'TotalTokens',
    agg: 'Total',
    nativeUnit: 'token',
    // 50K tokens ≈ 1 LCU ⇒ 0.00002 LCU/token.
    lcuPerUnit: 0.00002,
  },
  {
    key: 'stream',
    label: 'Stream Analytics (SU %)',
    type: 'microsoft.streamanalytics/streamingjobs',
    kind: 'percent',
    metric: 'ResourceUtilization',
    agg: 'Average',
    nativeUnit: 'SU-hour',
    lcuPerUnit: 6, // a job's Streaming-Unit-hour at full util ≈ 6 LCU.
  },
  {
    key: 'databricks',
    label: 'Azure Databricks (DBU)',
    type: 'microsoft.databricks/workspaces',
    kind: 'note',
    nativeUnit: 'DBU',
    lcuPerUnit: 10,
    note:
      'DBU is not emitted to Azure Monitor platform metrics — it is read from the ' +
      'Databricks billable-usage system table / Account Usage API (opt-in). Databricks ' +
      'cost is still captured via Cost Management in the tables above; only its LCU ' +
      'contribution requires that opt-in feed.',
  },
];

export interface EngineCU {
  engine: string;
  label: string;
  resourceCount: number;
  nativeUnit: string;
  nativeUnits: number;
  lcuPerUnit: number;
  /** Consumed LCU over the window for this engine. */
  lcu: number;
  /** Provisioned/peak LCU (the 100%-utilization ceiling) over the window. */
  peakLcu: number;
  /** Blended utilization % for percent-based engines (else null). */
  utilizationPct: number | null;
  /** Throttling events observed in the window (0 = healthy). */
  throttleEvents: number;
  note?: string;
}

export interface NormalizedCapacity {
  /** Consumed LCU across every engine over the window (the Loom CU number). */
  totalLcu: number;
  /** Provisioned/peak LCU ceiling — the Loom analogue of the Fabric SKU cap. */
  capacityLcu: number;
  capacitySource: 'env' | 'derived';
  /** totalLcu / capacityLcu * 100 — the Loom CU % (Fabric-parity throttle gauge). */
  utilizationPct: number;
  throttled: boolean;
  throttleEvents: number;
  surge: 'none' | 'elevated' | 'critical';
  engines: EngineCU[];
  windowHours: number;
  /** How LCU is derived, echoed for full transparency (no hidden numbers). */
  derivation: string;
}

export interface CostRow {
  key: string;
  cost: number;
  pctOfTotal: number;
}

export interface WorkspaceChargeback {
  workspace: string;
  cost: number;
  pctOfTotal: number;
  /** Cost-weighted LCU allocation (consumption charged back to the workspace). */
  lcu: number;
}

export interface ChargebackModel {
  currency: string;
  timeframe: CostTimeframe;
  windowHours: number;
  totalCost: number;
  forecast: number;
  trendPct: number | null;
  perService: CostRow[];
  compute: CostRow[];
  storage: CostRow[];
  perWorkspace: WorkspaceChargeback[];
  timeSeries: { date: string; cost: number }[];
  normalizedCU: NormalizedCapacity;
  scope: string;
  subscriptions: string[];
  subscriptionErrors: { subscription: string; error: string }[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TIMEFRAME_WINDOW: Record<CostTimeframe, { iso: string; hours: number }> = {
  Last7Days: { iso: 'P7D', hours: 7 * 24 },
  Last30Days: { iso: 'P30D', hours: 30 * 24 },
  MonthToDate: { iso: 'P30D', hours: 30 * 24 },
  BillingMonthToDate: { iso: 'P30D', hours: 30 * 24 },
  TheLastMonth: { iso: 'P30D', hours: 30 * 24 },
};

const COMPUTE_HINTS = [
  'synapse', 'data explorer', 'kusto', 'databricks', 'container apps', 'container instances',
  'app service', 'functions', 'cognitive', 'openai', 'machine learning', 'stream analytics',
  'event hubs', 'data factory', 'virtual machines', 'compute', 'api management', 'analysis services',
];
const STORAGE_HINTS = ['storage', 'data lake', 'cosmos', 'backup', 'blob', 'disks', 'files', 'sql database'];

function classify(rows: CostRow[]): { compute: CostRow[]; storage: CostRow[] } {
  const compute: CostRow[] = [];
  const storage: CostRow[] = [];
  for (const r of rows) {
    const s = r.key.toLowerCase();
    if (STORAGE_HINTS.some((h) => s.includes(h)) && !COMPUTE_HINTS.some((h) => s.includes(h))) storage.push(r);
    else if (COMPUTE_HINTS.some((h) => s.includes(h))) compute.push(r);
    else compute.push(r); // default unclassified spend to compute (conservative).
  }
  return { compute, storage };
}

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function withPct(rows: { key: string; cost: number }[], total: number): CostRow[] {
  return rows.map((r) => ({ key: r.key, cost: round(r.cost), pctOfTotal: total > 0 ? round((r.cost / total) * 100, 1) : 0 }));
}

/** Average of the present numeric metric points. */
function avg(points: { value: number | null }[]): number {
  const v = points.map((p) => p.value).filter((x): x is number => typeof x === 'number');
  if (!v.length) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
/** Sum of the present numeric metric points. */
function sum(points: { value: number | null }[]): number {
  return points.map((p) => p.value).filter((x): x is number => typeof x === 'number').reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// normalized CU — real Azure Monitor metrics per engine
// ---------------------------------------------------------------------------

async function computeEngineCU(def: EngineDef, resources: LoomResource[], win: { iso: string; hours: number }): Promise<EngineCU> {
  const matches = resources.filter((r) => r.type.toLowerCase() === def.type);
  const base: EngineCU = {
    engine: def.key,
    label: def.label,
    resourceCount: matches.length,
    nativeUnit: def.nativeUnit,
    nativeUnits: 0,
    lcuPerUnit: def.lcuPerUnit,
    lcu: 0,
    peakLcu: 0,
    utilizationPct: def.kind === 'percent' ? 0 : null,
    throttleEvents: 0,
    note: def.note,
  };
  if (matches.length === 0) return base;

  // Databricks: no Monitor DBU signal — honest note, zero LCU contribution.
  if (def.kind === 'note') return base;

  let nativeUnits = 0;
  let peakLcu = 0;
  let utilAccum = 0;
  let utilCount = 0;
  let throttle = 0;
  const windowSeconds = win.hours * 3600;

  await Promise.all(
    matches.map(async (res) => {
      try {
        if (def.kind === 'synapse-dwu') {
          // Enumerate the workspace's dedicated SQL pools and read DWU per pool.
          let pools: any[] = [];
          try {
            const j = await armGet<any>(`${res.id}/sqlPools?api-version=2021-06-01`);
            pools = j?.value || [];
          } catch { pools = []; }
          for (const p of pools) {
            try {
              const [limitR, usedR] = await Promise.all([
                fetchMetrics({ resourceId: p.id, metricNames: ['DWULimit'], timespan: win.iso, interval: 'PT1H', aggregation: 'Maximum' }),
                fetchMetrics({ resourceId: p.id, metricNames: ['DWUUsedPercent'], timespan: win.iso, interval: 'PT1H', aggregation: 'Average' }),
              ]);
              const dwuLimit = Math.max(0, avg(limitR[0]?.points || []));
              const usedPct = Math.max(0, avg(usedR[0]?.points || []));
              const consumedDwuHours = (dwuLimit * (usedPct / 100)) * win.hours;
              const peakDwuHours = dwuLimit * win.hours;
              nativeUnits += consumedDwuHours;
              peakLcu += peakDwuHours * def.lcuPerUnit;
              utilAccum += usedPct;
              utilCount += 1;
            } catch { /* pool metric unavailable — skip, honest zero */ }
          }
          return;
        }

        const series = await fetchMetrics({ resourceId: res.id, metricNames: [def.metric!], timespan: win.iso, interval: 'PT1H', aggregation: def.agg });
        const pts = series[0]?.points || [];

        if (def.kind === 'percent') {
          const pct = Math.max(0, Math.min(100, avg(pts)));
          const consumedHours = (pct / 100) * win.hours;
          nativeUnits += consumedHours;
          peakLcu += win.hours * def.lcuPerUnit; // 100%-utilization ceiling.
          utilAccum += pct;
          utilCount += 1;
        } else if (def.kind === 'nanocores') {
          const vcpu = avg(pts) / 1_000_000_000; // nanocores → vCPUs
          const vcpuSeconds = vcpu * windowSeconds;
          nativeUnits += vcpuSeconds;
          peakLcu += vcpuSeconds * def.lcuPerUnit; // ACA scales-to-consumption; peak≈consumed
        } else if (def.kind === 'sum') {
          const total = sum(pts);
          nativeUnits += total;
          peakLcu += total * def.lcuPerUnit; // token workloads have no idle cap.
        }

        if (def.throttleMetric) {
          try {
            const tSeries = await fetchMetrics({ resourceId: res.id, metricNames: [def.throttleMetric], timespan: win.iso, interval: 'PT1H', aggregation: 'Total' });
            throttle += Math.round(sum(tSeries[0]?.points || []));
          } catch { /* throttle metric unavailable */ }
        }
      } catch { /* one resource's metrics unavailable — honest zero contribution */ }
    }),
  );

  // nativeUnits is already in the coefficient's base unit (*-hour, vCPU-second,
  // or token) for every kind, so LCU is a single multiply.
  const lcu = nativeUnits * def.lcuPerUnit;
  return {
    ...base,
    nativeUnits: round(nativeUnits, 3),
    lcu: round(lcu),
    peakLcu: round(peakLcu),
    utilizationPct: utilCount ? round(utilAccum / utilCount, 1) : (def.kind === 'percent' ? 0 : null),
    throttleEvents: throttle,
  };
}

async function computeNormalizedCU(win: { iso: string; hours: number }): Promise<NormalizedCapacity> {
  let resources: LoomResource[] = [];
  try { resources = await listResources(); } catch { resources = []; }

  const engines = await Promise.all(CU_ENGINES.map((d) => computeEngineCU(d, resources, win)));
  const totalLcu = round(engines.reduce((a, e) => a + e.lcu, 0));
  const peakLcu = round(engines.reduce((a, e) => a + e.peakLcu, 0));
  const throttleEvents = engines.reduce((a, e) => a + e.throttleEvents, 0);

  // Capacity ceiling: an operator can pin the LCU SKU cap via env (the Loom
  // analogue of choosing a Fabric F-SKU); otherwise derive it as the observed
  // peak with 25% headroom so the gauge is meaningful out of the box.
  const envCap = Number(process.env.LOOM_CAPACITY_LCU);
  const capacitySource: 'env' | 'derived' = Number.isFinite(envCap) && envCap > 0 ? 'env' : 'derived';
  const capacityLcu = capacitySource === 'env'
    ? round(envCap)
    : round(Math.max(peakLcu, totalLcu * 1.25, 1));

  const utilizationPct = capacityLcu > 0 ? round((totalLcu / capacityLcu) * 100, 1) : 0;
  const throttled = throttleEvents > 0;
  const surge: NormalizedCapacity['surge'] =
    throttled || utilizationPct >= 100 ? 'critical' : utilizationPct >= 80 ? 'elevated' : 'none';

  return {
    totalLcu,
    capacityLcu,
    capacitySource,
    utilizationPct,
    throttled,
    throttleEvents,
    surge,
    engines,
    windowHours: win.hours,
    derivation:
      '1 LCU = one smoothed compute-hour of a baseline engine slice. Per-engine native ' +
      'usage (Synapse DWU-hours, ADX/Stream compute-hours at observed utilization, Container ' +
      'Apps vCPU-seconds, Azure OpenAI tokens) is read from Azure Monitor and multiplied by the ' +
      'published lcuPerUnit coefficient. Capacity ceiling = LOOM_CAPACITY_LCU when set, else the ' +
      'observed peak + 25% headroom.',
  };
}

// ---------------------------------------------------------------------------
// public entrypoint
// ---------------------------------------------------------------------------

export interface ChargebackOptions {
  timeframe?: CostTimeframe;
}

/**
 * Build the unified capacity + chargeback model. Throws
 * MonitorNotConfiguredError (billing scope unset) or MonitorError 401/403/404
 * (no Cost Management Reader) — the route maps both to an honest 503 gate.
 */
export async function getChargebackModel(opts: ChargebackOptions = {}): Promise<ChargebackModel> {
  const timeframe: CostTimeframe = opts.timeframe || 'MonthToDate';
  const win = TIMEFRAME_WINDOW[timeframe];

  // 1) Real Cost Management summary (throws when unconfigured / no access).
  const cost: CostSummary = await getLoomCostSummary({ timeframe });

  // 2) Real Azure Monitor normalized-CU (best-effort; never fails the model —
  //    Monitor gaps degrade to honest zeros, cost remains authoritative).
  let normalizedCU: NormalizedCapacity;
  try {
    normalizedCU = await computeNormalizedCU(win);
  } catch {
    normalizedCU = {
      totalLcu: 0, capacityLcu: 1, capacitySource: 'derived', utilizationPct: 0,
      throttled: false, throttleEvents: 0, surge: 'none', engines: [], windowHours: win.hours,
      derivation: 'Azure Monitor metrics unavailable in this window; LCU rollup skipped.',
    };
  }

  const total = cost.monthToDate;
  const perService = withPct(cost.byService, total);
  const { compute, storage } = classify(perService);

  // Chargeback allocation: resource-group is the Loom workspace boundary. LCU is
  // charged back cost-weighted (documented) so each workspace gets its share of
  // the single consumption number.
  const perWorkspace: WorkspaceChargeback[] = cost.byResourceGroup.map((r) => {
    const pct = total > 0 ? r.cost / total : 0;
    return {
      workspace: r.key,
      cost: round(r.cost),
      pctOfTotal: round(pct * 100, 1),
      lcu: round(normalizedCU.totalLcu * pct),
    };
  });

  return {
    currency: cost.currency,
    timeframe,
    windowHours: win.hours,
    totalCost: round(total),
    forecast: round(cost.forecast),
    trendPct: cost.trendPct,
    perService,
    compute,
    storage,
    perWorkspace,
    timeSeries: cost.daily.map((d) => ({ date: d.date, cost: round(d.cost) })),
    normalizedCU,
    scope: billingScope(),
    subscriptions: cost.subscriptions,
    subscriptionErrors: cost.subscriptionErrors,
    generatedAt: new Date().toISOString(),
  };
}
