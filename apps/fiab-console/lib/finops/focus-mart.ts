/**
 * B-N19e — FOCUS cost-per-query / per-dashboard attribution mart.
 *
 * Loom records every query run (SQL Lab / DuckDB, Synapse dedicated + serverless,
 * ADX/KQL, Trino, Databricks SQL, AAS DAX, dashboard tiles) in the BR-COSTATTR
 * `cost-attribution` Cosmos ledger with WHO ran it, in WHICH item / workspace /
 * dashboard, and HOW LONG it ran (see `lib/finops/query-run.ts`). Azure Cost
 * Management meters the REAL dollars per ARM resource type. This module joins
 * the two into a **FOCUS 1.1-conformant mart** so a FinOps practitioner can ask
 * "what did this query cost?" / "what does this dashboard cost per month?" in
 * the same column names their other clouds already emit.
 *
 * FOCUS column names + semantics are grounded in the FinOps Foundation spec and
 * Microsoft's own Cost-Management→FOCUS mapping, NOT from memory:
 *   - https://focus.finops.org/focus-specification/
 *   - https://learn.microsoft.com/cloud-computing/finops/focus/convert
 *   - https://learn.microsoft.com/cloud-computing/finops/focus/what-is-focus
 * Notes taken from those sources and honored below: `BillingPeriodEnd` and
 * `ChargePeriodEnd` are EXCLUSIVE; `SubAccountId`/`SubAccountName` are the Azure
 * subscription; `ProviderName`/`PublisherName`/`InvoiceIssuerName` are
 * `Microsoft`; every non-spec column carries the mandated `x_` prefix.
 *
 * ── HONESTY CONTRACT (no-vaporware.md) ──────────────────────────────────────
 * A query's cost is NEVER invented. Each run is priced by ALLOCATING the real
 * Cost Management spend of the ARM resource type that actually executed it,
 * across every run recorded against that resource type, weighted by recorded
 * Loom Capacity Units (LCU). Every row states its derivation in
 * `x_LoomCostSource`:
 *   'cost-management-allocated' — real metered dollars, LCU-weighted share.
 *   'unmetered'                 — Cost Management data unavailable (or that
 *                                 resource type shows no spend in the window):
 *                                 BilledCost/EffectiveCost are 0 and the
 *                                 transparent LCU estimate is carried in
 *                                 `x_LoomEstimatedCost` only. The surface shows
 *                                 an honest gate; nothing is fabricated.
 * Metered spend on an engine resource type with NO recorded runs is surfaced as
 * `unattributedCost` rather than being silently spread over the runs that exist.
 *
 * PURE MODULE — no I/O, no Azure SDK, no Cosmos. Everything here is unit-tested
 * with fixtures (`__tests__/focus-mart.test.ts`); the route does the fetching.
 * Azure-native end to end (no Fabric dependency).
 */

/** FOCUS specification release this mart conforms to. */
export const FOCUS_SPEC_VERSION = '1.1';

/** FOCUS `ChargeCategory` allowed values (spec §ChargeCategory). */
export type FocusChargeCategory = 'Usage' | 'Purchase' | 'Tax' | 'Credit' | 'Adjustment';

/** How a row's dollars were derived — surfaced verbatim in the UI. */
export type FocusCostSource = 'cost-management-allocated' | 'unmetered';

/**
 * One FOCUS 1.1 cost row = one recorded query run, priced from real metered
 * spend. Spec columns use the spec's exact PascalCase names; every Loom-specific
 * column carries the mandated `x_` prefix.
 */
export interface FocusCostRow {
  // ── Billing + charge period (End columns are EXCLUSIVE per FOCUS) ────────
  BillingAccountId: string;
  BillingAccountName: string;
  BillingCurrency: string;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;

  // ── Charge classification ───────────────────────────────────────────────
  ChargeCategory: FocusChargeCategory;
  /** `Correction` for a restatement; null for a normal charge. */
  ChargeClass: string | null;
  ChargeDescription: string;
  ChargeFrequency: 'Usage-Based';

  // ── Cost ────────────────────────────────────────────────────────────────
  BilledCost: number;
  EffectiveCost: number;
  ListCost: number;
  ContractedCost: number;

  // ── Provider / service ──────────────────────────────────────────────────
  ProviderName: 'Microsoft';
  PublisherName: 'Microsoft';
  InvoiceIssuerName: 'Microsoft';
  ServiceName: string;
  ServiceCategory: string;
  /** New in FOCUS 1.1. */
  ServiceSubcategory: string | null;

  // ── Resource / account ──────────────────────────────────────────────────
  ResourceId: string | null;
  ResourceName: string | null;
  ResourceType: string | null;
  RegionId: string | null;
  RegionName: string | null;
  SubAccountId: string | null;
  SubAccountName: string | null;

  // ── SKU + quantity ──────────────────────────────────────────────────────
  SkuId: string | null;
  SkuPriceId: string | null;
  /** New in FOCUS 1.1 (renamed from x_SkuMeterName). */
  SkuMeter: string | null;
  PricingCategory: 'Standard';
  PricingQuantity: number;
  PricingUnit: string;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  CommitmentDiscountId: string | null;
  /** FOCUS `Tags` — the resource tags Loom stamps for chargeback. */
  Tags: Record<string, string>;

  // ── x_ extension columns (Loom query attribution) ───────────────────────
  x_LoomQueryId: string;
  x_LoomStatementHash: string | null;
  x_LoomEngine: string;
  x_LoomItemId: string | null;
  x_LoomItemType: string | null;
  x_LoomWorkspaceId: string | null;
  x_LoomDashboardId: string | null;
  x_LoomDashboardTile: string | null;
  x_LoomDomainId: string | null;
  x_LoomUserOid: string;
  x_LoomUserName: string | null;
  x_LoomLcu: number;
  x_LoomDurationMs: number | null;
  x_LoomRowCount: number | null;
  /** 'cost-management-allocated' | 'unmetered' — the derivation, stated. */
  x_LoomCostSource: FocusCostSource;
  /** Transparent LCU-only estimate; the ONLY figure present when unmetered. */
  x_LoomEstimatedCost: number;
  /** This run's share (0–100) of its resource type's metered spend. */
  x_LoomPctOfResourceType: number;
}

/**
 * The engine → Azure service mapping the mart prices against. `resourceType` is
 * the lowercase ARM type Cost Management reports in its `ResourceType` grouping
 * (cost-client's `byResourceType`), so the join is against REAL metered spend.
 *
 * Every entry is Azure-native — no Fabric / Power BI resource types appear on
 * the default path (no-fabric-dependency.md).
 */
export interface FocusEngineMeter {
  serviceName: string;
  serviceCategory: string;
  serviceSubcategory: string | null;
  /** Lowercase ARM resource type this engine's spend is metered under. */
  resourceType: string;
  /** FOCUS `SkuMeter` label for the engine's billable meter. */
  skuMeter: string;
}

export const FOCUS_ENGINE_METERS: Record<string, FocusEngineMeter> = {
  adx: {
    serviceName: 'Azure Data Explorer',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Analytics Platform',
    resourceType: 'microsoft.kusto/clusters',
    skuMeter: 'Engine Instance',
  },
  'synapse-sql': {
    serviceName: 'Azure Synapse Analytics',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Warehouse',
    resourceType: 'microsoft.synapse/workspaces',
    skuMeter: 'Dedicated SQL Pool cDWU',
  },
  'synapse-serverless': {
    serviceName: 'Azure Synapse Analytics',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Warehouse',
    resourceType: 'microsoft.synapse/workspaces',
    skuMeter: 'Serverless SQL Data Processed',
  },
  spark: {
    serviceName: 'Azure Synapse Analytics',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Processing',
    resourceType: 'microsoft.synapse/workspaces',
    skuMeter: 'Apache Spark vCore Hours',
  },
  duckdb: {
    serviceName: 'Azure Container Apps',
    serviceCategory: 'Compute',
    serviceSubcategory: 'Serverless Compute',
    resourceType: 'microsoft.app/containerapps',
    skuMeter: 'vCPU + Memory Seconds',
  },
  trino: {
    serviceName: 'Azure Kubernetes Service',
    serviceCategory: 'Compute',
    serviceSubcategory: 'Containers',
    resourceType: 'microsoft.containerservice/managedclusters',
    skuMeter: 'Node vCPU Hours',
  },
  'databricks-sql': {
    serviceName: 'Azure Databricks',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Processing',
    resourceType: 'microsoft.databricks/workspaces',
    skuMeter: 'SQL Warehouse DBU',
  },
  databricks: {
    serviceName: 'Azure Databricks',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Processing',
    resourceType: 'microsoft.databricks/workspaces',
    skuMeter: 'All-purpose DBU',
  },
  'aas-dax': {
    serviceName: 'Azure Analysis Services',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Analytics Platform',
    resourceType: 'microsoft.analysisservices/servers',
    skuMeter: 'Query Processing Unit Hours',
  },
  pipeline: {
    serviceName: 'Azure Data Factory',
    serviceCategory: 'Analytics',
    serviceSubcategory: 'Data Processing',
    resourceType: 'microsoft.datafactory/factories',
    skuMeter: 'Pipeline Activity Runs',
  },
  aoai: {
    serviceName: 'Azure OpenAI Service',
    serviceCategory: 'AI and Machine Learning',
    serviceSubcategory: 'Generative AI',
    resourceType: 'microsoft.cognitiveservices/accounts',
    skuMeter: 'Tokens',
  },
};

/** The engines that represent an interactive QUERY run (the N19e scope). */
export const FOCUS_QUERY_ENGINES = [
  'adx', 'synapse-sql', 'synapse-serverless', 'duckdb', 'trino',
  'databricks-sql', 'aas-dax',
] as const;

export type FocusQueryEngine = (typeof FOCUS_QUERY_ENGINES)[number];

/** Ledger row shape the mart consumes (structural — matches CostAttributionRow). */
export interface FocusRunInput {
  id: string;
  occurredAt: string;
  userOid: string;
  userName?: string;
  engine: string;
  workspaceId?: string;
  itemId?: string;
  itemType?: string;
  domainId?: string;
  resourceId?: string;
  unit: string;
  quantity: number;
  lcu: number;
  estCostUsd: number;
  queryId?: string;
  statementHash?: string;
  durationMs?: number;
  rowCount?: number;
  dashboardId?: string;
  dashboardTile?: string;
}

export interface FocusMartInput {
  runs: FocusRunInput[];
  /** Real Cost Management spend keyed by LOWERCASE ARM resource type. */
  costByResourceType: Record<string, number>;
  /** True when Cost Management answered; false → every row is `unmetered`. */
  costManagementAvailable: boolean;
  currency: string;
  billingAccountId: string;
  billingAccountName: string;
  /** subscriptionId → display name, for SubAccountName. */
  subAccountNames?: Record<string, string>;
  /** Charge window (ISO). `periodEnd` is EXCLUSIVE, per FOCUS. */
  periodStart: string;
  periodEnd: string;
  windowDays: number;
  /** Deterministic clock for tests. */
  generatedAt?: string;
}

export interface FocusUnattributedRow {
  resourceType: string;
  serviceName: string;
  cost: number;
}

export interface FocusMart {
  specVersion: string;
  currency: string;
  rows: FocusCostRow[];
  totalBilledCost: number;
  totalEffectiveCost: number;
  /** Transparent LCU estimate total (the only figure when unmetered). */
  totalEstimatedCost: number;
  /** Metered engine spend with no recorded run to receive it — surfaced, never hidden. */
  unattributedCost: number;
  unattributed: FocusUnattributedRow[];
  costSource: FocusCostSource;
  runCount: number;
  windowDays: number;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
}

const round = (n: number, dp = 6): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Best-effort subscription id out of a fully-qualified ARM resource id. */
export function subscriptionOfResourceId(resourceId?: string): string | null {
  if (!resourceId) return null;
  const m = /\/subscriptions\/([0-9a-f-]{36})/i.exec(resourceId);
  return m ? m[1] : null;
}

/** Last, most-specific segment of an ARM resource id (Microsoft's own ResourceName transform). */
export function resourceNameOfResourceId(resourceId?: string): string | null {
  if (!resourceId) return null;
  if (!resourceId.includes('/')) return resourceId || null;
  const parts = resourceId.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Build the FOCUS 1.1 mart: price every recorded query run by allocating the
 * REAL metered spend of the ARM resource type that executed it, LCU-weighted.
 *
 * Pure — deterministic for a given input (pass `generatedAt` in tests).
 */
export function buildFocusMart(input: FocusMartInput): FocusMart {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const currency = input.currency || 'USD';
  const subNames = input.subAccountNames || {};

  // Normalize the Cost Management map to lowercase keys once.
  const metered = new Map<string, number>();
  for (const [k, v] of Object.entries(input.costByResourceType || {})) {
    const key = (k || '').toLowerCase();
    if (!key) continue;
    metered.set(key, (metered.get(key) || 0) + (Number(v) || 0));
  }

  // Group runs by the resource type their engine is metered under.
  const byResourceType = new Map<string, FocusRunInput[]>();
  const unmapped: FocusRunInput[] = [];
  for (const r of input.runs || []) {
    const meter = FOCUS_ENGINE_METERS[r.engine];
    if (!meter) { unmapped.push(r); continue; }
    const list = byResourceType.get(meter.resourceType);
    if (list) list.push(r);
    else byResourceType.set(meter.resourceType, [r]);
  }

  const rows: FocusCostRow[] = [];
  let totalBilledCost = 0;
  let totalEffectiveCost = 0;
  let totalEstimatedCost = 0;

  const emit = (r: FocusRunInput, allocated: number | null, pct: number) => {
    const meter = FOCUS_ENGINE_METERS[r.engine];
    const costSource: FocusCostSource = allocated === null ? 'unmetered' : 'cost-management-allocated';
    const cost = allocated === null ? 0 : round(allocated, 6);
    const estimated = round(Number(r.estCostUsd) || 0, 6);
    const durationMs = Number.isFinite(r.durationMs) ? Number(r.durationMs) : null;
    const chargeStart = r.occurredAt;
    // ChargePeriodEnd is EXCLUSIVE — the instant the run finished (or +1ms for
    // an instantaneous record) so a window filter never double-counts.
    const chargeEnd = new Date(
      new Date(r.occurredAt).getTime() + Math.max(1, durationMs ?? 1),
    ).toISOString();
    const subId = subscriptionOfResourceId(r.resourceId);

    const tags: Record<string, string> = {};
    if (r.domainId) tags['loom-domain'] = r.domainId;
    if (r.workspaceId) tags['loom-workspace'] = r.workspaceId;

    rows.push({
      BillingAccountId: input.billingAccountId,
      BillingAccountName: input.billingAccountName,
      BillingCurrency: currency,
      BillingPeriodStart: input.periodStart,
      BillingPeriodEnd: input.periodEnd,
      ChargePeriodStart: chargeStart,
      ChargePeriodEnd: chargeEnd,

      ChargeCategory: 'Usage',
      ChargeClass: null,
      ChargeDescription: meter
        ? `${meter.serviceName} — ${meter.skuMeter} consumed by a Loom ${r.engine} query run`
        : `Loom ${r.engine} run`,
      ChargeFrequency: 'Usage-Based',

      BilledCost: cost,
      EffectiveCost: cost,
      // Loom has no list/contracted price signal per run; FOCUS permits these to
      // equal EffectiveCost when no discount data exists. Never inflated.
      ListCost: cost,
      ContractedCost: cost,

      ProviderName: 'Microsoft',
      PublisherName: 'Microsoft',
      InvoiceIssuerName: 'Microsoft',
      ServiceName: meter?.serviceName || 'Loom Platform',
      ServiceCategory: meter?.serviceCategory || 'Analytics',
      ServiceSubcategory: meter?.serviceSubcategory ?? null,

      ResourceId: r.resourceId || null,
      ResourceName: resourceNameOfResourceId(r.resourceId),
      ResourceType: meter?.resourceType || null,
      RegionId: null,
      RegionName: null,
      SubAccountId: subId,
      SubAccountName: subId ? (subNames[subId] || subId) : null,

      SkuId: null,
      SkuPriceId: null,
      SkuMeter: meter?.skuMeter ?? null,
      PricingCategory: 'Standard',
      PricingQuantity: round(Number(r.quantity) || 0, 6),
      PricingUnit: r.unit,
      ConsumedQuantity: round(Number(r.quantity) || 0, 6),
      ConsumedUnit: r.unit,
      CommitmentDiscountId: null,
      Tags: tags,

      x_LoomQueryId: r.queryId || r.id,
      x_LoomStatementHash: r.statementHash || null,
      x_LoomEngine: r.engine,
      x_LoomItemId: r.itemId || null,
      x_LoomItemType: r.itemType || null,
      x_LoomWorkspaceId: r.workspaceId || null,
      x_LoomDashboardId: r.dashboardId || null,
      x_LoomDashboardTile: r.dashboardTile || null,
      x_LoomDomainId: r.domainId || null,
      x_LoomUserOid: r.userOid,
      x_LoomUserName: r.userName || null,
      x_LoomLcu: round(Number(r.lcu) || 0, 6),
      x_LoomDurationMs: durationMs,
      x_LoomRowCount: Number.isFinite(r.rowCount) ? Number(r.rowCount) : null,
      x_LoomCostSource: costSource,
      x_LoomEstimatedCost: estimated,
      x_LoomPctOfResourceType: round(pct, 4),
    });

    totalBilledCost += cost;
    totalEffectiveCost += cost;
    totalEstimatedCost += estimated;
  };

  for (const [resourceType, runs] of byResourceType.entries()) {
    const meteredCost = input.costManagementAvailable ? (metered.get(resourceType) || 0) : 0;
    const lcuTotal = runs.reduce((s, r) => s + (Number(r.lcu) || 0), 0);
    // No metered spend for this resource type (or Cost Management unavailable)
    // → honest 'unmetered' rows, never a fabricated dollar figure.
    const priceable = input.costManagementAvailable && meteredCost > 0 && lcuTotal > 0;
    for (const r of runs) {
      const share = priceable ? (Number(r.lcu) || 0) / lcuTotal : 0;
      emit(r, priceable ? meteredCost * share : null, share * 100);
    }
  }
  // Runs on an engine with no FOCUS meter mapping still appear, honestly unmetered.
  for (const r of unmapped) emit(r, null, 0);

  // Metered engine spend with NO recorded run to receive it.
  const unattributed: FocusUnattributedRow[] = [];
  let unattributedCost = 0;
  if (input.costManagementAvailable) {
    const engineTypes = new Set(Object.values(FOCUS_ENGINE_METERS).map((m) => m.resourceType));
    for (const rt of engineTypes) {
      const cost = metered.get(rt) || 0;
      if (cost <= 0) continue;
      if (byResourceType.has(rt)) continue;
      const meter = Object.values(FOCUS_ENGINE_METERS).find((m) => m.resourceType === rt);
      unattributed.push({ resourceType: rt, serviceName: meter?.serviceName || rt, cost: round(cost, 2) });
      unattributedCost += cost;
    }
    unattributed.sort((a, b) => b.cost - a.cost);
  }

  rows.sort((a, b) => (b.EffectiveCost - a.EffectiveCost) || (b.x_LoomLcu - a.x_LoomLcu));

  return {
    specVersion: FOCUS_SPEC_VERSION,
    currency,
    rows,
    totalBilledCost: round(totalBilledCost, 2),
    totalEffectiveCost: round(totalEffectiveCost, 2),
    totalEstimatedCost: round(totalEstimatedCost, 4),
    unattributedCost: round(unattributedCost, 2),
    unattributed,
    costSource: input.costManagementAvailable ? 'cost-management-allocated' : 'unmetered',
    runCount: rows.length,
    windowDays: input.windowDays,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Rollups — the per-query / per-dashboard / per-item / per-user panels.
// ---------------------------------------------------------------------------

export type FocusGroupBy = 'query' | 'dashboard' | 'item' | 'user' | 'engine';

export interface FocusRollupRow {
  key: string;
  label: string;
  /** Secondary descriptor (engine for a query, item type for an item, …). */
  detail: string | null;
  effectiveCost: number;
  estimatedCost: number;
  lcu: number;
  runs: number;
  /** Total wall-clock the group consumed, ms (null when no run reported one). */
  durationMs: number | null;
  rowsReturned: number | null;
  /** Mean cost per run — the "cost per query" figure. */
  avgCostPerRun: number;
  costSource: FocusCostSource;
}

const groupKeyOf = (r: FocusCostRow, by: FocusGroupBy): string | null => {
  switch (by) {
    // A "query" identity is the STATEMENT (fingerprint), so re-running the same
    // query rolls up into one cost line; a run with no fingerprint falls back to
    // its own run id so it is never silently merged with an unrelated statement.
    case 'query': return r.x_LoomStatementHash || r.x_LoomQueryId;
    case 'dashboard': return r.x_LoomDashboardId;
    case 'item': return r.x_LoomItemId;
    case 'user': return r.x_LoomUserOid;
    case 'engine': return r.x_LoomEngine;
    default: return null;
  }
};

const groupLabelOf = (r: FocusCostRow, by: FocusGroupBy, key: string): string => {
  switch (by) {
    case 'query': return r.x_LoomStatementHash ? `stmt:${r.x_LoomStatementHash}` : `run:${key}`;
    case 'dashboard': return r.x_LoomDashboardId || key;
    case 'item': return r.x_LoomItemId || key;
    case 'user': return r.x_LoomUserName || r.x_LoomUserOid;
    case 'engine': return r.x_LoomEngine;
    default: return key;
  }
};

const groupDetailOf = (r: FocusCostRow, by: FocusGroupBy): string | null => {
  switch (by) {
    case 'query': return r.x_LoomEngine;
    case 'dashboard': return r.x_LoomDashboardTile ? `tile ${r.x_LoomDashboardTile}` : r.ServiceName;
    case 'item': return r.x_LoomItemType;
    case 'user': return r.x_LoomUserOid;
    case 'engine': return r.ServiceName;
    default: return null;
  }
};

/**
 * Fold FOCUS rows into a cost rollup. `dashboard` naturally yields the
 * per-dashboard cost panel; `query` yields cost-per-query (grouped by statement
 * fingerprint so repeated runs of the same query aggregate).
 */
export function rollupFocus(rows: FocusCostRow[], by: FocusGroupBy): FocusRollupRow[] {
  const acc = new Map<string, FocusRollupRow & { _anyMetered: boolean }>();
  for (const r of rows) {
    const key = groupKeyOf(r, by);
    if (!key) continue; // e.g. a non-dashboard run when grouping by dashboard
    const cur = acc.get(key) || {
      key,
      label: groupLabelOf(r, by, key),
      detail: groupDetailOf(r, by),
      effectiveCost: 0,
      estimatedCost: 0,
      lcu: 0,
      runs: 0,
      durationMs: null,
      rowsReturned: null,
      avgCostPerRun: 0,
      costSource: 'unmetered' as FocusCostSource,
      _anyMetered: false,
    };
    cur.effectiveCost = round(cur.effectiveCost + r.EffectiveCost, 6);
    cur.estimatedCost = round(cur.estimatedCost + r.x_LoomEstimatedCost, 6);
    cur.lcu = round(cur.lcu + r.x_LoomLcu, 6);
    cur.runs += 1;
    if (r.x_LoomDurationMs !== null) cur.durationMs = (cur.durationMs || 0) + r.x_LoomDurationMs;
    if (r.x_LoomRowCount !== null) cur.rowsReturned = (cur.rowsReturned || 0) + r.x_LoomRowCount;
    if (r.x_LoomCostSource === 'cost-management-allocated') cur._anyMetered = true;
    acc.set(key, cur);
  }
  return Array.from(acc.values())
    .map(({ _anyMetered, ...row }) => ({
      ...row,
      avgCostPerRun: row.runs > 0 ? round(row.effectiveCost / row.runs, 6) : 0,
      costSource: (_anyMetered ? 'cost-management-allocated' : 'unmetered') as FocusCostSource,
    }))
    .sort((a, b) => (b.effectiveCost - a.effectiveCost) || (b.lcu - a.lcu));
}

// ---------------------------------------------------------------------------
// FOCUS export — the mart in the spec's own column names (CSV).
// ---------------------------------------------------------------------------

/** Ordered FOCUS 1.1 + x_ column names, i.e. the export header. */
export const FOCUS_COLUMNS: (keyof FocusCostRow)[] = [
  'BillingAccountId', 'BillingAccountName', 'BillingCurrency',
  'BillingPeriodStart', 'BillingPeriodEnd', 'ChargePeriodStart', 'ChargePeriodEnd',
  'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency',
  'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost',
  'ProviderName', 'PublisherName', 'InvoiceIssuerName',
  'ServiceName', 'ServiceCategory', 'ServiceSubcategory',
  'ResourceId', 'ResourceName', 'ResourceType', 'RegionId', 'RegionName',
  'SubAccountId', 'SubAccountName',
  'SkuId', 'SkuPriceId', 'SkuMeter', 'PricingCategory',
  'PricingQuantity', 'PricingUnit', 'ConsumedQuantity', 'ConsumedUnit',
  'CommitmentDiscountId', 'Tags',
  'x_LoomQueryId', 'x_LoomStatementHash', 'x_LoomEngine',
  'x_LoomItemId', 'x_LoomItemType', 'x_LoomWorkspaceId',
  'x_LoomDashboardId', 'x_LoomDashboardTile', 'x_LoomDomainId',
  'x_LoomUserOid', 'x_LoomUserName', 'x_LoomLcu',
  'x_LoomDurationMs', 'x_LoomRowCount', 'x_LoomCostSource',
  'x_LoomEstimatedCost', 'x_LoomPctOfResourceType',
];

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Render the mart as FOCUS-column-named CSV (RFC-4180 quoting, CRLF rows). */
export function focusCsv(rows: FocusCostRow[]): string {
  const header = FOCUS_COLUMNS.join(',');
  const body = rows.map((r) => FOCUS_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return [header, ...body].join('\r\n') + '\r\n';
}
