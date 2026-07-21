/**
 * BR-COSTATTR — per-execution cost attribution.
 *
 * Every compute job/query submit (Synapse Spark, Databricks, ADX/KQL, Azure
 * OpenAI) is tagged with WHO ran it, in WHICH workspace/item, and HOW MUCH it
 * consumed, then persisted to the append-only `cost-attribution` Cosmos ledger
 * (PK /tenantId, TTL 90d). Two consumers:
 *
 *   - FGC-28 chargeback page — per-user drill-down within a domain (the real
 *     Cost Management per-domain $ is allocated across users by their recorded
 *     LCU share, so the drill-down is grounded in real consumption, not a guess).
 *   - FGC-25 surge protection — the per-workspace LCU/hour cap sums this hour's
 *     recorded LCU for a workspace.
 *
 * Consumption is normalized to Loom Capacity Units (LCU) via a published
 * coefficient table (echoed in the record) so nothing is hidden. The USD figure
 * is a transparent estimate from that LCU; the chargeback page prefers real
 * Cost Management dollars and uses these LCU numbers only for the per-user
 * SHARE. Writes are best-effort and NEVER throw — attribution must not be able
 * to fail a job submit.
 */
import { costAttributionContainer } from '@/lib/azure/cosmos-client';

export type AttributionEngine = 'spark' | 'databricks' | 'adx' | 'aoai' | 'pipeline' | 'marketplace';

/**
 * Published LCU coefficients per engine's billable unit. Aligned with the
 * normalized-CU model in cost-management-client.ts (1 LCU ≈ one smoothed
 * compute-hour of a baseline engine slice). Echoed on every record so the
 * derivation is transparent.
 */
export const ATTRIBUTION_RATES: Record<AttributionEngine, { unit: string; lcuPerUnit: number }> = {
  spark: { unit: 'session', lcuPerUnit: 30 }, // a Spark session ≈ a compute-hour slice
  databricks: { unit: 'run', lcuPerUnit: 25 },
  adx: { unit: 'query', lcuPerUnit: 0.5 },
  aoai: { unit: 'token', lcuPerUnit: 0.00002 }, // 50K tokens ≈ 1 LCU (matches CU model)
  pipeline: { unit: 'run', lcuPerUnit: 10 },
  // WS-10.4: a Living-Marketplace subscription meters the catalog/entitlement/
  // serving overhead of standing up a subscriber against a published product.
  // `quantity` carries the product's declared `lcuPerSubscription`, so
  // lcuPerUnit=1 makes the recorded LCU equal that declared figure (transparent).
  marketplace: { unit: 'subscription', lcuPerUnit: 1 },
};

/** Transparent published USD-per-LCU used for the estimate column. */
export const USD_PER_LCU = 0.1;

/** Default ledger retention (90 days) in seconds. */
const ATTRIBUTION_TTL_SECONDS = 90 * 24 * 3600;

export interface CostAttributionRow {
  id: string;
  tenantId: string; // partition key
  occurredAt: string; // ISO-8601
  /** `YYYY-MM-DDTHH` bucket for the per-hour workspace cap sum. */
  hourBucket: string;
  userOid: string;
  userName?: string;
  engine: AttributionEngine;
  workspaceId?: string;
  itemId?: string;
  itemType?: string;
  domainId?: string;
  resourceId?: string;
  unit: string;
  quantity: number;
  /** Normalized Loom Capacity Units consumed. */
  lcu: number;
  /** Transparent USD estimate (lcu × USD_PER_LCU). */
  estCostUsd: number;
  ttl: number;
}

export interface AttributionContext {
  tenantId: string;
  userOid: string;
  userName?: string;
  engine: AttributionEngine;
  /** Billable quantity in the engine's native unit (sessions/runs/queries/tokens). Default 1. */
  quantity?: number;
  workspaceId?: string;
  itemId?: string;
  itemType?: string;
  domainId?: string;
  resourceId?: string;
  /** Override occurrence time (defaults to now) — used by deterministic tests. */
  occurredAt?: string;
  /** Override id (defaults to a random uuid) — used by deterministic tests. */
  id?: string;
}

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Pure attribution-tagging function: turn an execution context into a fully
 * derived ledger row (LCU + USD estimate + hour bucket + TTL). No I/O — this is
 * the unit-tested core of BR-COSTATTR.
 */
export function buildAttributionRecord(ctx: AttributionContext): CostAttributionRow {
  const rate = ATTRIBUTION_RATES[ctx.engine];
  const quantity = Number.isFinite(ctx.quantity) && (ctx.quantity as number) > 0 ? (ctx.quantity as number) : 1;
  const lcu = round(quantity * rate.lcuPerUnit);
  const estCostUsd = round(lcu * USD_PER_LCU, 4);
  const occurredAt = ctx.occurredAt || new Date().toISOString();
  return {
    id: ctx.id || (globalThis.crypto?.randomUUID?.() ?? `attr-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    tenantId: ctx.tenantId,
    occurredAt,
    hourBucket: occurredAt.slice(0, 13), // YYYY-MM-DDTHH
    userOid: ctx.userOid,
    userName: ctx.userName,
    engine: ctx.engine,
    workspaceId: ctx.workspaceId,
    itemId: ctx.itemId,
    itemType: ctx.itemType,
    domainId: ctx.domainId,
    resourceId: ctx.resourceId,
    unit: rate.unit,
    quantity,
    lcu,
    estCostUsd,
    ttl: ATTRIBUTION_TTL_SECONDS,
  };
}

/** Record one execution to the ledger. Best-effort — never throws. */
export async function recordCostAttribution(ctx: AttributionContext): Promise<CostAttributionRow | null> {
  try {
    const row = buildAttributionRecord(ctx);
    const c = await costAttributionContainer();
    await c.items.create(row);
    return row;
  } catch {
    return null; // attribution must never fail a job submit
  }
}

/**
 * Sum LCU a workspace consumed in the CURRENT clock hour (for the FGC-25 cap).
 * Returns null when the ledger has no rows yet (so the cap stays fail-open).
 */
export async function workspaceLcuThisHour(tenantId: string, workspaceId: string): Promise<number | null> {
  try {
    const c = await costAttributionContainer();
    const hourBucket = new Date().toISOString().slice(0, 13);
    const { resources } = await c.items
      .query<number>({
        query:
          'SELECT VALUE SUM(c.lcu) FROM c WHERE c.tenantId=@t AND c.workspaceId=@w AND c.hourBucket=@h',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@w', value: workspaceId },
          { name: '@h', value: hourBucket },
        ],
      }, { partitionKey: tenantId })
      .fetchAll();
    const sum = resources?.[0];
    return typeof sum === 'number' ? sum : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rollups for the chargeback drill-down API.
// ---------------------------------------------------------------------------

export interface AttributionRollupRow {
  key: string;
  displayName?: string;
  lcu: number;
  estCostUsd: number;
  executions: number;
}

export interface AttributionRollup {
  byUser: AttributionRollupRow[];
  byEngine: AttributionRollupRow[];
  byDomain: AttributionRollupRow[];
  totalLcu: number;
  totalEstCostUsd: number;
  totalExecutions: number;
  windowDays: number;
  generatedAt: string;
}

/**
 * Fold raw ledger rows into per-user / per-engine / per-domain rollups — a pure
 * aggregation over the fetched rows (unit-tested alongside the tagging fn).
 */
export function rollupAttribution(rows: CostAttributionRow[], windowDays: number): AttributionRollup {
  const bump = (m: Map<string, AttributionRollupRow>, key: string, name: string | undefined, r: CostAttributionRow) => {
    const cur = m.get(key) || { key, displayName: name, lcu: 0, estCostUsd: 0, executions: 0 };
    cur.lcu = round(cur.lcu + r.lcu);
    cur.estCostUsd = round(cur.estCostUsd + r.estCostUsd, 4);
    cur.executions += 1;
    if (!cur.displayName && name) cur.displayName = name;
    m.set(key, cur);
  };
  const byUser = new Map<string, AttributionRollupRow>();
  const byEngine = new Map<string, AttributionRollupRow>();
  const byDomain = new Map<string, AttributionRollupRow>();
  let totalLcu = 0;
  let totalEstCostUsd = 0;
  for (const r of rows) {
    bump(byUser, r.userOid, r.userName || r.userOid, r);
    bump(byEngine, r.engine, r.engine, r);
    bump(byDomain, r.domainId || '(no domain)', r.domainId || '(no domain)', r);
    totalLcu = round(totalLcu + r.lcu);
    totalEstCostUsd = round(totalEstCostUsd + r.estCostUsd, 4);
  }
  const sortDesc = (m: Map<string, AttributionRollupRow>) => Array.from(m.values()).sort((a, b) => b.lcu - a.lcu);
  return {
    byUser: sortDesc(byUser),
    byEngine: sortDesc(byEngine),
    byDomain: sortDesc(byDomain),
    totalLcu,
    totalEstCostUsd,
    totalExecutions: rows.length,
    windowDays,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Sum recorded LCU per workspace over the last `windowDays` — the usage signal
 * the per-workspace chargeback ALLOCATION prefers (WS-CHGBK). Real Cosmos
 * GROUP BY on the same ledger; returns a `{ workspaceId: lcu }` map. Empty when
 * nothing has been attributed yet, so the allocator falls back to item-weighting
 * (never a fabricated number). Only rows carrying a `workspaceId` are counted.
 */
export async function queryWorkspaceLcu(
  tenantId: string,
  windowDays = 30,
): Promise<Record<string, number>> {
  const wd = Math.max(1, Math.min(90, windowDays));
  const since = new Date(Date.now() - wd * 24 * 3600 * 1000).toISOString();
  const c = await costAttributionContainer();
  const { resources } = await c.items
    .query<{ workspaceId: string; lcu: number }>(
      {
        query:
          'SELECT c.workspaceId AS workspaceId, SUM(c.lcu) AS lcu FROM c ' +
          'WHERE c.tenantId=@t AND c.occurredAt >= @since AND IS_DEFINED(c.workspaceId) ' +
          'GROUP BY c.workspaceId',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@since', value: since },
        ],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  const out: Record<string, number> = {};
  for (const r of resources || []) {
    if (r?.workspaceId) out[r.workspaceId] = Number(r.lcu) || 0;
  }
  return out;
}

/**
 * Query the ledger over the last `windowDays` (optionally scoped to one domain)
 * and return the rollups. Real Cosmos read — empty rollups when nothing has been
 * recorded yet (the honest empty state, never fabricated numbers).
 */
export async function queryAttributionRollup(
  tenantId: string,
  opts: { windowDays?: number; domainId?: string } = {},
): Promise<AttributionRollup> {
  const windowDays = Math.max(1, Math.min(90, opts.windowDays || 30));
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const c = await costAttributionContainer();
  const params: { name: string; value: unknown }[] = [
    { name: '@t', value: tenantId },
    { name: '@since', value: since },
  ];
  let where = 'c.tenantId=@t AND c.occurredAt >= @since';
  if (opts.domainId) { where += ' AND c.domainId=@d'; params.push({ name: '@d', value: opts.domainId }); }
  const { resources } = await c.items
    .query<CostAttributionRow>({ query: `SELECT * FROM c WHERE ${where}`, parameters: params as any }, { partitionKey: tenantId })
    .fetchAll();
  return rollupAttribution(resources || [], windowDays);
}
