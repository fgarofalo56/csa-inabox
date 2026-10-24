/**
 * ESTATE POWER - the "Always on, not pausable" disclosure (#5099 phase C).
 *
 * WHY. Estate Power pauses what Azure lets it pause. Everything else the estate
 * owns keeps billing, and an operator looking at a PAUSED estate would otherwise
 * have no way to see that a Firewall, a Bastion, an APIM instance or a Redis cache
 * is still running up the bill, or why. This lists those resources (same
 * `loom-estate-id` tag ownership and the same Resource Graph transport as
 * `./pause-tag-discovery`), each with a plain-words reason and a cost.
 *
 * COST HONESTY (deploy-integrity R7). Each row's cost carries its own provenance:
 *   - `actual-mtd`  month-to-date spend from Azure Cost Management for THAT resource id
 *   - `estimate`    a list-price figure from the small table below, only in Commercial
 *   - `unknown`     neither could be established; the row says why
 * An estimate is never presented as actual, the two are never summed together, and
 * an actual cost that could not be read is disclosed (never silently replaced).
 *
 * FAIL CLOSED. A Resource Graph failure, or a configured subscription the identity
 * cannot read, is reported as `incomplete` with the reason. It is never rendered as
 * "nothing is always on".
 *
 * Pure parts (`buildAlwaysOnQuery`, `classifyAlwaysOnRows`, `estimateMonthly`,
 * `parseCostRows`) are split from the transport so every branch is testable
 * without a network.
 */
import { kqlEscapeSingle } from '@/lib/azure/kql-escape';
import { classifyTagReadFailure } from './pause-discovery-classify';
import { LOOM_ESTATE_TAG_KEY } from './pause-inventory';
import {
  READABLE_SUBSCRIPTIONS_QUERY,
  configuredSubscriptions,
  queryAllPages,
  type ArgPost,
  type ArgRow,
} from './pause-tag-discovery';

const RESOURCE_GRAPH_PATH = '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01';
const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;
/** Resource ids per Cost Management filter (keeps the request body small). */
const COST_ID_CHUNK = 40;

/** What Azure Resource Graph projects for one always-on candidate (see {@link buildAlwaysOnQuery}). */
export interface AlwaysOnArgRow extends ArgRow {
  kind?: string;
  skuName?: string;
  skuTier?: string;
  skuCapacity?: number | null;
  fwTier?: string;
  gwType?: string;
  gwSku?: string;
  redisFamily?: string;
  redisCapacity?: number | null;
  replicaCount?: number | null;
  partitionCount?: number | null;
}

export type CostSource = 'actual-mtd' | 'estimate' | 'unknown';

export interface AlwaysOnCost {
  source: CostSource;
  /** actual-mtd: month-to-date spend. estimate: list-price monthly. Absent for `unknown`. */
  amount?: number;
  currency?: string;
  /** The words the UI shows next to the number (or instead of it). Never "actual" for an estimate. */
  label: string;
  /** How the figure was derived, or why there is none. */
  detail: string;
}

export interface AlwaysOnRow {
  resourceId: string;
  name: string;
  resourceType: string;
  typeLabel: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
  /** Plain-words reason this is not paused. */
  reason: string;
  cost: AlwaysOnCost;
}

interface AlwaysOnSpec {
  type: string;
  label: string;
  reason: (row: AlwaysOnArgRow) => string;
  /** List-price estimate (USD per month, East US) or null when the SKU is not in the table. */
  estimate: (row: AlwaysOnArgRow) => { monthly: number; basis: string } | null;
}

const hourly = (perHour: number, units: number, basis: string) => ({
  monthly: round2(perHour * units * HOURS_PER_MONTH),
  basis: `${basis}, ${perHour} USD/h x ${units > 1 ? `${units} units x ` : ''}${HOURS_PER_MONTH} h`,
});
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
const units = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
const lc = (s: string | undefined | null): string => String(s ?? '').trim().toLowerCase();

/*
 * LIST PRICES. Source: Azure Retail Prices API (https://prices.azure.com/api/retail/prices),
 * armRegionName eq 'eastus', priceType 'Consumption', USD, read 2026-10-23. Per-hour / per-day
 * meter rates below; monthly = rate x 730 h (or x 730/24 days). They are LIST prices: they exclude
 * data processing / ingress / egress, reservations, EA discounts and taxes, so they are an
 * ESTIMATE and are labelled one. Commercial only: Azure Government and DoD list prices differ
 * and this table has no Gov column, so those clouds get `unknown` unless Cost Management answers.
 * A SKU that is not in a table gives `null` (cost unknown), never a guess.
 */
const FIREWALL_PER_HOUR: Record<string, number> = { basic: 0.395, standard: 1.25, premium: 1.75 };
// Bastion: Developer is free; Premium has no row in the table read above.
const BASTION_PER_HOUR: Record<string, number> = { developer: 0, basic: 0.19, standard: 0.29 };
const VPN_PER_HOUR: Record<string, number> = { basic: 0.036 };
const ER_GW_PER_HOUR: Record<string, number> = {
  standard: 0.19,
  highperformance: 0.49,
  ultraperformance: 1.87,
  ergw1az: 0.361,
  ergw2az: 0.632,
  ergw3az: 2.151,
};
const APIM_PER_UNIT_HOUR: Record<string, number> = {
  developer: 0.0658,
  basic: 0.2016,
  standard: 0.9407,
  premium: 3.829,
  basicv2: 0.20548,
  standardv2: 0.9589,
  premiumv2: 3.83562,
};
// Azure Cache for Redis: sku.name + family/capacity, per cache per hour.
const REDIS_PER_HOUR: Record<string, number> = {
  'basic-c0': 0.022,
  'basic-c1': 0.055,
  'standard-c0': 0.055,
  'standard-c1': 0.138,
  'premium-p1': 0.555,
};
const SEARCH_PER_UNIT_HOUR: Record<string, number> = {
  free: 0,
  basic: 0.101,
  standard: 0.336,
  standard2: 1.344,
  standard3: 2.688,
  storage_optimized_l1: 3.839,
  storage_optimized_l2: 7.677,
};
// Event Hubs: throughput-unit base rate only (ingress events are extra). Premium is priced per PU: not tabled.
const EVENTHUBS_PER_TU_HOUR: Record<string, number> = { basic: 0.015, standard: 0.03 };
const ACR_PER_DAY: Record<string, number> = { basic: 0.1666, standard: 0.6666, premium: 1.6666 };
// Front Door Standard/Premium: monthly BASE fee only (requests and egress are extra).
const FRONT_DOOR_BASE_MONTHLY: Record<string, number> = { standard_azurefrontdoor: 35, premium_azurefrontdoor: 330 };

const SPECS: readonly AlwaysOnSpec[] = [
  {
    type: 'microsoft.network/azurefirewalls',
    label: 'Azure Firewall',
    reason: () =>
      "Never paused: the console's outbound traffic routes through it, so a deallocated firewall would make a paused estate impossible to resume from Loom.",
    estimate: (r) => {
      const rate = FIREWALL_PER_HOUR[lc(r.fwTier || r.skuTier)];
      return rate === undefined ? null : hourly(rate, 1, `Azure Firewall ${r.fwTier || r.skuTier}, deployment charge only`);
    },
  },
  {
    type: 'microsoft.network/bastionhosts',
    label: 'Azure Bastion',
    reason: () => 'Azure has no stop verb for Bastion; the only way to stop the charge is to delete it, which Loom never does on its own.',
    estimate: (r) => {
      const rate = BASTION_PER_HOUR[lc(r.skuName)];
      return rate === undefined ? null : hourly(rate, 1, `Bastion ${r.skuName}, gateway charge only`);
    },
  },
  {
    type: 'microsoft.network/virtualnetworkgateways',
    label: 'Virtual network gateway',
    reason: (r) =>
      lc(r.gwType) === 'expressroute'
        ? 'Azure has no stop verb for an ExpressRoute gateway; only delete. Deleting it drops the on-premises circuit connection, so Loom never does.'
        : 'Azure has no stop verb for a VPN gateway; only delete. Deleting it drops every tunnel, so Loom never does.',
    estimate: (r) => {
      const isEr = lc(r.gwType) === 'expressroute';
      const rate = (isEr ? ER_GW_PER_HOUR : VPN_PER_HOUR)[lc(r.gwSku)];
      return rate === undefined ? null : hourly(rate, 1, `${isEr ? 'ExpressRoute' : 'VPN'} gateway ${r.gwSku}`);
    },
  },
  {
    type: 'microsoft.apimanagement/service',
    label: 'API Management',
    reason: () => 'Azure has no stop verb for API Management; an instance bills for its units until it is deleted.',
    estimate: (r) => {
      const rate = APIM_PER_UNIT_HOUR[lc(r.skuName)];
      const n = units(r.skuCapacity);
      return rate === undefined || n === null ? null : hourly(rate, n, `API Management ${r.skuName}`);
    },
  },
  {
    type: 'microsoft.cache/redis',
    label: 'Azure Cache for Redis',
    reason: () => 'Azure has no stop verb for Redis, and stopping would discard the cache contents; it bills while it exists.',
    estimate: (r) => {
      const rate = REDIS_PER_HOUR[`${lc(r.skuName)}-${lc(r.redisFamily)}${r.redisCapacity ?? ''}`];
      return rate === undefined ? null : hourly(rate, 1, `Redis ${r.skuName} ${String(r.redisFamily ?? '').toUpperCase()}${r.redisCapacity ?? ''}`);
    },
  },
  {
    type: 'microsoft.cache/redisenterprise',
    label: 'Azure Managed Redis',
    reason: () => 'Azure has no stop verb for Managed Redis, and stopping would discard the cache contents; it bills while it exists.',
    estimate: () => null,
  },
  {
    type: 'microsoft.search/searchservices',
    label: 'Azure AI Search',
    reason: () => 'Azure has no stop verb for AI Search; the service bills per search unit (replicas x partitions) while it exists.',
    estimate: (r) => {
      const rate = SEARCH_PER_UNIT_HOUR[lc(r.skuName)];
      const replicas = units(r.replicaCount);
      const partitions = units(r.partitionCount);
      if (rate === undefined || replicas === null || partitions === null) return null;
      return hourly(rate, replicas * partitions, `AI Search ${r.skuName}, ${replicas} replica(s) x ${partitions} partition(s)`);
    },
  },
  {
    type: 'microsoft.cognitiveservices/accounts',
    label: 'Azure OpenAI / AI Services',
    reason: () => 'Never paused: these accounts have no stop verb and bill by use, so there is no idle charge to save by stopping them.',
    estimate: () => null,
  },
  {
    type: 'microsoft.eventhub/namespaces',
    label: 'Event Hubs namespace',
    reason: () => 'Azure has no stop verb for an Event Hubs namespace; it bills for its throughput units while it exists.',
    estimate: (r) => {
      const rate = EVENTHUBS_PER_TU_HOUR[lc(r.skuName)];
      const n = units(r.skuCapacity);
      return rate === undefined || n === null ? null : hourly(rate, n, `Event Hubs ${r.skuName} throughput units, ingress not included`);
    },
  },
  {
    type: 'microsoft.purview/accounts',
    label: 'Microsoft Purview',
    reason: () => 'Azure has no stop verb for Purview; the account bills for its capacity units while it exists.',
    estimate: () => null,
  },
  {
    type: 'microsoft.cdn/profiles',
    label: 'Front Door',
    reason: () =>
      'Never paused: Front Door is the public path to the console, so pausing it would take the surface that resumes the estate offline.',
    estimate: (r) => {
      const base = FRONT_DOOR_BASE_MONTHLY[lc(r.skuName)];
      return base === undefined ? null : { monthly: base, basis: `Front Door ${r.skuName} base fee only, requests and egress not included` };
    },
  },
  {
    type: 'microsoft.network/frontdoors',
    label: 'Front Door (classic)',
    reason: () =>
      'Never paused: Front Door is the public path to the console, so pausing it would take the surface that resumes the estate offline.',
    estimate: () => null,
  },
  {
    type: 'microsoft.containerregistry/registries',
    label: 'Container Registry',
    reason: () => 'Azure has no stop verb for a registry, and paused apps need its images to resume; it bills per registry unit per day.',
    estimate: (r) => {
      const perDay = ACR_PER_DAY[lc(r.skuName)];
      return perDay === undefined
        ? null
        : { monthly: round2(perDay * DAYS_PER_MONTH), basis: `Container Registry ${r.skuName}, ${perDay} USD/day x ${round2(DAYS_PER_MONTH)} days; storage and build minutes not included` };
    },
  },
];

const SPEC_BY_TYPE = new Map(SPECS.map((s) => [s.type, s]));

/** Types this disclosure covers (exported for the tests and the docs). */
export const ALWAYS_ON_TYPES: readonly string[] = SPECS.map((s) => s.type);

/** Resource Graph query for this estate's always-on candidates. The tag compare is `==` (case-sensitive). */
export function buildAlwaysOnQuery(estateId: string): string {
  const types = ALWAYS_ON_TYPES.map((t) => `'${kqlEscapeSingle(t)}'`).join(', ');
  return [
    'resources',
    `| where type in~ (${types})`,
    `| where tostring(tags['${LOOM_ESTATE_TAG_KEY}']) == '${kqlEscapeSingle(estateId)}'`,
    '| project id, name, type, resourceGroup, subscriptionId, location, tags, kind,'
      + ' skuName=tostring(sku.name), skuTier=tostring(sku.tier), skuCapacity=toint(sku.capacity),'
      + ' fwTier=tostring(properties.sku.tier), gwType=tostring(properties.gatewayType), gwSku=tostring(properties.sku.name),'
      + ' redisFamily=tostring(properties.sku.family), redisCapacity=toint(properties.sku.capacity),'
      + ' replicaCount=toint(properties.replicaCount), partitionCount=toint(properties.partitionCount)',
    '| order by id asc',
  ].join('\n');
}

/** USD monthly list-price estimate for a row, or null. Commercial only (see the price-table comment). */
export function estimateMonthly(row: AlwaysOnArgRow): { monthly: number; basis: string } | null {
  const spec = SPEC_BY_TYPE.get(lc(row.type));
  return spec ? spec.estimate(row) : null;
}

const REGION_LABELS: Record<string, string> = { eastus: 'East US' };

function unknownCost(why: string): AlwaysOnCost {
  return { source: 'unknown', label: 'cost unknown', detail: why };
}

/**
 * PURE. Rows -> disclosure rows. Ownership is re-checked on every row (the tag must equal the
 * estate id exactly) so a query defect cannot widen the list. `actual` is the month-to-date spend by
 * lower-cased resource id when Cost Management answered; `cloud` gates the list-price estimates.
 */
export function classifyAlwaysOnRows(args: {
  rows: readonly AlwaysOnArgRow[];
  estateId: string;
  actual?: ReadonlyMap<string, { amount: number; currency?: string }>;
  /** Why actual cost is not available (shown on rows that fall back). */
  actualUnavailable?: string;
  cloud: string;
}): AlwaysOnRow[] {
  const out: AlwaysOnRow[] = [];
  const seen = new Set<string>();
  for (const row of args.rows) {
    const resourceId = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim();
    const type = lc(row.type);
    const spec = SPEC_BY_TYPE.get(type);
    if (!resourceId || !name || !spec) continue;
    const key = resourceId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = row.tags && typeof row.tags === 'object' ? row.tags : null;
    const estateTag = tags ? Object.entries(tags).find(([k]) => k.toLowerCase() === LOOM_ESTATE_TAG_KEY)?.[1] : undefined;
    if (estateTag !== args.estateId) continue;

    // Cognitive Services: only OpenAI / AIServices kinds are in scope (Speech, Vision, ... are not "AI Services" spend we disclose here).
    if (type === 'microsoft.cognitiveservices/accounts') {
      const kind = lc(row.kind);
      if (kind !== 'openai' && kind !== 'aiservices') continue;
    }

    const loc = row.location ? String(row.location) : undefined;
    let cost: AlwaysOnCost;
    const actual = args.actual?.get(key);
    if (actual) {
      cost = {
        source: 'actual-mtd',
        amount: round2(actual.amount),
        ...(actual.currency ? { currency: actual.currency } : {}),
        label: 'actual month-to-date (Cost Management)',
        detail: 'Month-to-date spend reported by Azure Cost Management for this resource id. Cost data can lag by a day or more.',
      };
    } else {
      const est = args.cloud === 'Commercial' ? estimateMonthly(row) : null;
      const why = args.actualUnavailable ? ` Actual cost was not available: ${args.actualUnavailable}` : ' Cost Management returned no spend row for this resource.';
      if (est) {
        const region = REGION_LABELS.eastus;
        const sameRegion = lc(loc) === 'eastus';
        cost = {
          source: 'estimate',
          amount: est.monthly,
          currency: 'USD',
          label: `estimate (list price, ${region})`,
          detail:
            `${est.basis}.${sameRegion ? '' : ` Priced at ${region}${loc ? `; this resource is in ${loc}` : ''}, so the real rate may differ.`}`
            + ' List price excludes discounts and usage-based charges; this is NOT actual spend.'
            + why,
        };
      } else if (args.cloud !== 'Commercial') {
        cost = unknownCost(`No list-price table exists for ${args.cloud}.${why}`);
      } else {
        cost = unknownCost(`This SKU is not in the list-price table (or the resource is usage-priced).${why}`);
      }
    }
    out.push({
      resourceId,
      name,
      resourceType: type,
      typeLabel: spec.label,
      resourceGroup: String(row.resourceGroup ?? ''),
      subscriptionId: String(row.subscriptionId ?? ''),
      ...(loc ? { location: loc } : {}),
      reason: spec.reason(row),
      cost,
    });
  }
  return out;
}

/** PURE. A Cost Management query response -> spend by lower-cased resource id. */
export function parseCostRows(resp: unknown): Map<string, { amount: number; currency?: string }> {
  const props = (resp as { properties?: { columns?: Array<{ name?: string }>; rows?: unknown[][] } } | null)?.properties;
  const cols = props?.columns ?? [];
  const idx = (n: string) => cols.findIndex((c) => String(c?.name ?? '').toLowerCase() === n.toLowerCase());
  const iCost = idx('Cost');
  const iId = idx('ResourceId');
  const iCur = idx('Currency');
  const out = new Map<string, { amount: number; currency?: string }>();
  if (iCost < 0 || iId < 0) return out;
  for (const r of props?.rows ?? []) {
    const id = String(r[iId] ?? '').trim().toLowerCase();
    const amount = Number(r[iCost]);
    if (!id || !Number.isFinite(amount)) continue;
    const prev = out.get(id);
    const currency = iCur >= 0 && r[iCur] ? String(r[iCur]) : prev?.currency;
    out.set(id, { amount: (prev?.amount ?? 0) + amount, ...(currency ? { currency } : {}) });
  }
  return out;
}

/** Runs ONE Cost Management query for a subscription. Throws on failure. */
export type CostRun = (subscriptionId: string, body: unknown) => Promise<unknown>;

async function defaultCostRun(subscriptionId: string, body: unknown): Promise<unknown> {
  const { runCostQuery } = await import('@/lib/azure/cost-client');
  return runCostQuery(subscriptionId, body);
}

const subOf = (resourceId: string): string => /^\/subscriptions\/([^/]+)/i.exec(resourceId)?.[1]?.toLowerCase() ?? '';

/** Month-to-date spend for exactly these resource ids. Never throws; a failure is returned as `error`. */
export async function fetchActualMtd(
  resourceIds: readonly string[],
  run: CostRun = defaultCostRun,
): Promise<{ actual: Map<string, { amount: number; currency?: string }>; error?: string }> {
  const bySub = new Map<string, string[]>();
  for (const id of resourceIds) {
    const s = subOf(id);
    if (!s) continue;
    bySub.set(s, [...(bySub.get(s) ?? []), id]);
  }
  const actual = new Map<string, { amount: number; currency?: string }>();
  const errors: string[] = [];
  for (const [sub, ids] of bySub) {
    for (let i = 0; i < ids.length; i += COST_ID_CHUNK) {
      const chunk = ids.slice(i, i + COST_ID_CHUNK);
      try {
        const resp = await run(sub, {
          type: 'ActualCost',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Dimension', name: 'ResourceId' }],
            filter: { dimensions: { name: 'ResourceId', operator: 'In', values: chunk } },
          },
        });
        for (const [k, v] of parseCostRows(resp)) actual.set(k, v);
      } catch (e) {
        errors.push(`${sub}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      }
    }
  }
  return { actual, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

export interface AlwaysOnResult {
  estateId: string;
  cloud: string;
  rows: AlwaysOnRow[];
  /** True when ANY part of the inventory could not be established. NEVER read as "nothing is always on". */
  incomplete: boolean;
  /** Starts "inventory incomplete:" when `incomplete`. */
  note?: string;
  /** Why actual cost could not be read (rows fall back to an estimate or "cost unknown"). */
  costNote?: string;
  /** Actual and estimated figures are NEVER added together. */
  totals: {
    actualMtd: { amount: number; currency?: string; rows: number };
    estimateMonthly: { amount: number; currency: 'USD'; rows: number };
    unknownRows: number;
  };
}

function totalsOf(rows: readonly AlwaysOnRow[]): AlwaysOnResult['totals'] {
  const actual = rows.filter((r) => r.cost.source === 'actual-mtd');
  const est = rows.filter((r) => r.cost.source === 'estimate');
  const currency = actual.find((r) => r.cost.currency)?.cost.currency;
  return {
    actualMtd: { amount: round2(actual.reduce((n, r) => n + (r.cost.amount ?? 0), 0)), ...(currency ? { currency } : {}), rows: actual.length },
    estimateMonthly: { amount: round2(est.reduce((n, r) => n + (r.cost.amount ?? 0), 0)), currency: 'USD', rows: est.length },
    unknownRows: rows.filter((r) => r.cost.source === 'unknown').length,
  };
}

async function defaultPost(body: unknown): Promise<{ data?: unknown; $skipToken?: string }> {
  const { armPost } = await import('@/lib/azure/arm-client');
  return armPost(RESOURCE_GRAPH_PATH, body);
}

/** Discover the always-on resources of `estateId`, with costs. Never throws. */
export async function discoverAlwaysOn(args: {
  estateId: string;
  cloud: string;
  env?: NodeJS.ProcessEnv;
  post?: ArgPost;
  costRun?: CostRun;
}): Promise<AlwaysOnResult> {
  const env = args.env ?? process.env;
  const post = args.post ?? defaultPost;
  const estateId = String(args.estateId ?? '').trim();
  const base = { estateId, cloud: args.cloud };
  if (!estateId || estateId === 'loom:unbound') {
    return {
      ...base,
      rows: [],
      incomplete: true,
      note: 'inventory incomplete: this console has no estate id (LOOM_ESTATE_ID, or LOOM_SUBSCRIPTION_ID with LOOM_ADMIN_RG), so resources cannot be matched to it by tag. This is not a statement that nothing is always on.',
      totals: totalsOf([]),
    };
  }

  let rows: AlwaysOnArgRow[];
  try {
    ({ rows } = (await queryAllPages(buildAlwaysOnQuery(estateId), post)) as { rows: AlwaysOnArgRow[]; pages: number });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const kind = classifyTagReadFailure(error);
    return {
      ...base,
      rows: [],
      incomplete: true,
      note:
        `inventory incomplete: the Azure Resource Graph query failed${kind === 'throttled' ? ' (throttled; retry)' : ''}, so the always-on resources are NOT listed. `
        + `This is not a statement that nothing is always on. Raw: ${error.slice(0, 300)}`,
      totals: totalsOf([]),
    };
  }

  let incomplete = false;
  let note: string | undefined;
  const expected = configuredSubscriptions(env);
  if (expected.length) {
    try {
      const probe = await queryAllPages(READABLE_SUBSCRIPTIONS_QUERY, post);
      const readable = new Set(probe.rows.map((r) => String(r.subscriptionId ?? '').toLowerCase()));
      const unreadable = expected.filter((s) => !readable.has(s));
      if (unreadable.length) {
        incomplete = true;
        note = `inventory incomplete: the console identity cannot read subscription(s) ${unreadable.join(', ')}, which this console is configured for, so always-on resources there are NOT listed.`;
      }
    } catch (e) {
      incomplete = true;
      note = `inventory incomplete: the check that every configured subscription is readable failed, so a subscription may be missing. Raw: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    }
  }

  // First pass without costs gives the ids to price; second pass attaches the figures.
  const provisional = classifyAlwaysOnRows({ rows, estateId, cloud: args.cloud });
  let costNote: string | undefined;
  let actual: Map<string, { amount: number; currency?: string }> | undefined;
  if (provisional.length) {
    const got = await fetchActualMtd(provisional.map((r) => r.resourceId), args.costRun);
    actual = got.actual;
    if (got.error) {
      costNote = `Actual cost could not be read for every subscription (${got.error}). Rows without an actual figure show a list-price estimate where one exists, labelled as an estimate, otherwise "cost unknown".`;
    }
  }
  const finalRows = classifyAlwaysOnRows({
    rows,
    estateId,
    cloud: args.cloud,
    ...(actual ? { actual } : {}),
    ...(costNote ? { actualUnavailable: costNote.slice(0, 200) } : {}),
  });
  return {
    ...base,
    rows: finalRows,
    incomplete,
    ...(note ? { note } : {}),
    ...(costNote ? { costNote } : {}),
    totals: totalsOf(finalRows),
  };
}
