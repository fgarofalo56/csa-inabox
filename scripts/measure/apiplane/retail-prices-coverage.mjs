#!/usr/bin/env node
/**
 * retail-prices-coverage.mjs - PRP loom-api-gateway-plane, work item W0-5.
 * A measurement, not product code.
 *
 *   node scripts/measure/apiplane/retail-prices-coverage.mjs [--json <file>] [--require-gov-coverage] [--services <a,b>] [--help]
 *
 * QUESTION
 *   Does the public Azure Retail Prices API carry price rows for the Azure OpenAI /
 *   Foundry model SKUs in the Azure Government regions, and which model families that
 *   Commercial carries have NO Government row? The plane's price-list design
 *   (ADR-006 / W4) needs to know whether Government prices can be seeded from this API
 *   or must come from somewhere else.
 *
 * GROUNDING (Microsoft Learn, retrieved 2026-10-29; the page says "Last updated on 2024-08-07")
 *   https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 *   - GET https://prices.azure.com/api/retail/prices, unauthenticated.
 *   - api-version=2023-01-01-preview returns the full meter set (primary and non-primary);
 *     the bare URL returns the same set. From that version on, filter values are CASE
 *     SENSITIVE, so this script pins the version and sends exact casing.
 *   - $filter fields: armRegionName, Location, meterId, meterName, productid, skuId,
 *     productName, skuName, serviceName, serviceId, serviceFamily, priceType, armSkuName.
 *     The page shows `eq`, `and` and contains(meterName, 'Spot') and nothing else. It
 *     documents NO `or`, `startswith` or `in`, so this script uses `eq` and `and` only.
 *   - Paging: at most 1,000 records per request; the body ends with "NextPageLink"; the
 *     page's own sample loops until that is null.
 *   - The page also says of armRegionName: "This version only supports prices on
 *     Commercial Cloud." That sentence is the claim under test here.
 *   - NOT grounded in Learn: the serviceName strings (the page's only example is
 *     'Virtual Machines'); they come from the PRP. The positive control below is what
 *     validates them: a wrong spelling returns 0 rows everywhere and exits 2.
 *
 * MEASURED 2026-10-29 (first live run of this script; a dated observation, not a promise)
 *   - serviceName 'Azure OpenAI' returned 0 rows, and so did its all-region census: that
 *     name has no price rows in the API at all, so the default pair below exits 2 (blind).
 *     The OpenAI rows are served under serviceName 'Foundry Models', whose productName
 *     values include 'Azure OpenAI', 'Azure OpenAI GPT5', 'Azure OpenAI Reasoning', ...
 *     Pass `--services "Foundry Models"` to measure the name that exists.
 *   - 'Foundry Models' had rows in usgovvirginia, usgovarizona and usgovtexas and under a
 *     region literally named "US Gov", so the Learn sentence above does not hold for these
 *     meters. A Government ROW is not proof that the model is deployable there.
 *   - Meter names are free text ("5.6 luna LongCo Cd Inp Std DZ 1M Tokens", "4.1 mini ft
 *     cd inp Dz Tokens", "Llama 3.3 70B Inp glbl Tokens"): the model name often lacks its
 *     vendor, which sits in productName. That is why a family is productName + model.
 *
 * DOCUMENTED CHOICES
 *   Services           : 'Azure OpenAI' and 'Foundry Models' (the PRP's pair); --services replaces it.
 *   Government regions : usgovvirginia, usgovarizona, usgovtexas, usgoviowa, usdodeast,
 *                        usdodcentral - ONE REGION PER REQUEST CHAIN, so a failure names
 *                        the region it belongs to.
 *   Commercial regions : eastus, eastus2, centralus, westus, westus3, swedencentral - a
 *                        fixed list of representative regions (five US, one EU), queried
 *                        the same way. These are the POSITIVE CONTROL: they use the
 *                        identical filter shape as the Government queries, only the
 *                        region literal differs. The Commercial SIDE of a family
 *                        comparison is these six plus the discovered Global/DataZone
 *                        names, not every Commercial region (the census lists ~45).
 *   Global / DataZone  : Learn does not say how the API names those meters, so they are
 *                        DISCOVERED, not guessed. One extra chain per service has no
 *                        region filter (a census of every region); any armRegionName
 *                        outside the queried twelve that matches /global|data[ _-]?zone/i
 *                        becomes a Commercial row, and any matching /^us[ _-]?(gov|dod)/i
 *                        becomes a Government row (a Government name the fixed list
 *                        missed must not turn into a false "absent").
 *   Cross-check        : the census also re-counts each queried region. A region whose
 *                        query and census disagree is FAILED (two reads of the same
 *                        rows must agree before either count is quoted).
 *   Rows               : every price row, all price types (Consumption, Reservation,
 *                        DevTestConsumption). "distinct meters" de-duplicates meterName.
 *   Product group      : the API's own productName. No heuristic: counts of distinct
 *                        meters per group, Commercial side vs Government side.
 *   Model family       : "<productName> :: <model>", see normaliseModelName. A HEURISTIC
 *                        over free text: the JSON carries the raw names, and a family
 *                        reported absent must be re-checked against them before it is
 *                        quoted anywhere. The same model spelt two ways is two families.
 *
 * FAILING CLOSED (the point of the item)
 *   A count that could not be established - network error, non-200, malformed JSON,
 *   paging that does not terminate, more than PAGE_CAP pages, a row that contradicts its
 *   own filter, a query/census disagreement - prints `FAILED (<reason>)`, is stored as
 *   null (never 0), and the process exits 2. A MEASURED zero (HTTP 200, no rows, no next
 *   page) prints `0 (measured)`. If no queried Commercial region returns a row for a
 *   service, that service is INSTRUMENT BLIND and the process exits 2: a Government zero
 *   means nothing next to a Commercial zero. No "absent in Government" claim is printed
 *   for a service that has any FAILED count.
 *
 * EXIT CODES
 *   0  measured, complete, positive control passed (and, with --require-gov-coverage, no gap)
 *   1  bad invocation
 *   2  a count could not be fetched or verified, or the instrument is blind, or --json
 *      could not be written
 *   3  --require-gov-coverage and a Commercial family has zero Government rows
 *
 * POLITENESS
 *   Strictly sequential; at least 200 ms between one response and the next request; at
 *   most 3 retries (1 s, 2 s, 4 s) on 429, 5xx or a network error; a User-Agent naming
 *   this script. Only counts, names and URLs are printed - never a response body.
 *
 * Tests: node --test scripts/measure/apiplane/__tests__/retail-prices-coverage.test.mjs
 */
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- constants
export const RETAIL_PRICES_URL = 'https://prices.azure.com/api/retail/prices';
const RETAIL_PRICES_HOST = 'prices.azure.com';
export const API_VERSION = '2023-01-01-preview';
export const SERVICES = Object.freeze(['Azure OpenAI', 'Foundry Models']);
export const GOVERNMENT_REGIONS = Object.freeze(['usgovvirginia', 'usgovarizona', 'usgovtexas', 'usgoviowa', 'usdodeast', 'usdodcentral']);
export const COMMERCIAL_REGIONS = Object.freeze(['eastus', 'eastus2', 'centralus', 'westus', 'westus3', 'swedencentral']);
export const PAGE_CAP = 200;
export const MIN_GAP_MS = 200;
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000]);
export const MAX_RETRIES = BACKOFF_MS.length;
const REQUEST_TIMEOUT_MS = 30_000;
export const USER_AGENT = 'csa-inabox-apiplane-retail-prices-coverage/1.0 (scripts/measure/apiplane/retail-prices-coverage.mjs; W0-5 measurement)';
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2, GOV_GAP: 3 });
const NO_PRODUCT = '(no productName)';
const UNNAMED_MODEL = '(unnamed model)';
const UNNAMED_METER = '(unnamed)';
const NO_REGION = '(none)';

const GLOBAL_LIKE = /global|data[\s_-]?zone/i;
const GOVERNMENT_LIKE = /^us[\s_-]?(?:gov|dod)/i;

/** Keep anything that came off the wire printable, short and single-line. */
function clip(value, max = 60) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// -------------------------------------------------------------------- query
function quoted(value, what) {
  if (typeof value !== 'string' || value === '' || /['"\\]/.test(value)) {
    throw new Error(`${what} must be a non-empty string without quotes or backslashes, got ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/** First-page URL of one request chain. region === null is the all-region census. */
export function queryUrl(service, region = null) {
  let filter = `serviceName eq ${quoted(service, 'service')}`;
  if (region !== null) filter += ` and armRegionName eq ${quoted(region, 'region')}`;
  return `${RETAIL_PRICES_URL}?api-version=${API_VERSION}&$filter=${encodeURIComponent(filter)}`;
}

// ------------------------------------------------------------ model families
/*
 * normaliseModelName: meter name -> model key. Steps, in order:
 *   1. lower-case; "data zone" -> datazone, "fine tuned" -> finetuned; "pay as you go" removed;
 *   2. ISO dates (2024-05-13, 20240513) removed;
 *   3. quantity-plus-unit phrases for the unit quantities 1, 10, 100, 1000 removed
 *      ("1M Tokens", "1 Hour", "100 Images"); a context window such as "32K" is NOT a
 *      unit quantity and survives;
 *   4. split on anything that is not [a-z0-9] (so "4.1" becomes "4 1");
 *   5. drop version-date tokens: MMDD (0513) and YYMM for 2023-2029 (2411);
 *   6. the model is the tokens BEFORE the first BILLING token (direction, cache, deployment
 *      type, tier, fine-tuning, hosting, unit): "5.6 luna LongCo Cd Inp Std DZ 1M Tokens"
 *      is "5 6 luna", "4.1 mini ft cd inp Dz Tokens" is "4 1 mini";
 *   7. if that prefix is empty (the name STARTS with a billing word), keep every token
 *      except the pure unit words.
 * "gpt-4o" and "gpt-4o-mini" stay distinct ("mini" survives), and so do "gpt-4" and "gpt-4.1".
 */
const UNIT_WORDS = new Set(['tokens', 'token', '1m', '1k', 'unit', 'units', 'pages', 'images', 'hour', 'hours', 'gb', 'megapixel']);
const BILLING = new Set([
  ...UNIT_WORDS,
  // direction, cache
  'inp', 'inpt', 'input', 'in', 'opt', 'outp', 'outpt', 'out', 'output', 'cd', 'cchd', 'cached', 'cache', 'wr', 'prompt', 'completion',
  // deployment type, region scope
  'dz', 'dzone', 'dzn', 'datazone', 'gl', 'glbl', 'global', 'regnl', 'rgnl', 'regional',
  // tier, context band, pricing class
  'longco', 'shortco', 'loco', 'shco', 'std', 'standard', 'flex', 'batch', 'pp',
  // fine-tuning, hosting
  'ft', 'sft', 'rft', 'finetuned', 'hosting', 'hstng', 'training', 'trng', 'deployment',
]);
const ISO_DATE = /\b20\d{2}[-_.]?\d{2}[-_.]?\d{2}\b/g;
const UNIT_PHRASE = /\b(?:1|10|100|1000)\s*[km]?\s*(?:tokens?|hours?|hrs?|images?|minutes?|characters?|units?)\b/g;
const MMDD = /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
const YYMM = /^2[3-9](?:0[1-9]|1[0-2])$/;

export function normaliseModelName(raw) {
  if (typeof raw !== 'string') return '';
  const tokens = raw
    .toLowerCase()
    .replace(/data[\s_-]?zone/g, ' datazone ')
    .replace(/fine[\s_-]?tuned/g, ' finetuned ')
    .replace(/pay[\s_-]?as[\s_-]?you[\s_-]?go/g, ' ')
    .replace(ISO_DATE, ' ')
    .replace(UNIT_PHRASE, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '' && !MMDD.test(t) && !YYMM.test(t));
  const cut = tokens.findIndex((t) => BILLING.has(t));
  const prefix = cut === -1 ? tokens : tokens.slice(0, cut);
  if (prefix.length > 0) return prefix.join(' ');
  return tokens.filter((t) => !UNIT_WORDS.has(t)).join(' ');
}

/** Family of one price row: its productName plus the model in its meterName (else skuName). */
export function familyOf(item) {
  const product = typeof item.productName === 'string' && item.productName !== '' ? item.productName : NO_PRODUCT;
  const model = normaliseModelName(item.meterName) || normaliseModelName(item.skuName) || UNNAMED_MODEL;
  return `${product} :: ${model}`;
}

// ------------------------------------------------------------- http client
/** A request chain that could not be completed. The message IS the printed reason: short, never a body. */
export class QueryFailed extends Error {}

function describeNetworkError(e) {
  const code = e?.cause?.code ?? e?.code ?? e?.name ?? 'error';
  return String(code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'error';
}

/**
 * Sequential client: one request at a time, MIN_GAP_MS between a response and the
 * next request, bounded retries. Throws QueryFailed; never returns a partial result.
 */
export function createClient({ fetch: fetchFn, sleep, now }) {
  let lastEnd = null;
  let requests = 0;

  async function attemptOnce(url) {
    if (lastEnd !== null) {
      const wait = MIN_GAP_MS - (now() - lastEnd);
      if (wait > 0) await sleep(wait);
    }
    requests += 1;
    try {
      const res = await fetchFn(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { network: describeNetworkError(e) };
    } finally {
      lastEnd = now();
    }
  }

  async function getJson(url) {
    for (let retry = 0; ; retry += 1) {
      const r = await attemptOnce(url);
      const transient = r.network !== undefined || r.status === 429 || r.status >= 500;
      if (transient && retry < MAX_RETRIES) {
        await sleep(BACKOFF_MS[retry]);
        continue;
      }
      const what = r.network !== undefined ? `network error (${r.network})` : `HTTP ${r.status}`;
      if (transient) throw new QueryFailed(`${what} after ${MAX_RETRIES} retries`);
      if (r.status !== 200) throw new QueryFailed(what);
      try {
        return JSON.parse(r.text);
      } catch {
        throw new QueryFailed('malformed JSON');
      }
    }
  }

  return { getJson, get requests() { return requests; } };
}

/** A NextPageLink is followed only if it stays on https://prices.azure.com. */
function assertRetailUrl(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    throw new QueryFailed('NextPageLink is not a URL');
  }
  if (u.protocol !== 'https:' || u.hostname !== RETAIL_PRICES_HOST || u.port !== '' || u.username !== '' || u.password !== '') {
    throw new QueryFailed(`NextPageLink points outside https://${RETAIL_PRICES_HOST}`);
  }
}

/**
 * Follow NextPageLink until it is absent, handing every row to onItem. Page PAGE_CAP + 1
 * is never requested: a chain that still has a next link after PAGE_CAP pages FAILS,
 * it is never returned truncated.
 */
export async function fetchAllPages(client, firstUrl, onItem) {
  const seen = new Set();
  let url = firstUrl;
  for (let page = 1; ; page += 1) {
    if (page > PAGE_CAP) throw new QueryFailed(`paging did not terminate within ${PAGE_CAP} pages`);
    seen.add(url);
    const body = await client.getJson(url);
    if (body === null || typeof body !== 'object' || !Array.isArray(body.Items)) {
      throw new QueryFailed('malformed response (no Items array)');
    }
    for (const item of body.Items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new QueryFailed('malformed response (an Items entry is not an object)');
      }
      onItem(item);
    }
    const next = body.NextPageLink;
    if (next === null || next === undefined || next === '') return page;
    if (typeof next !== 'string') throw new QueryFailed('malformed response (NextPageLink is not a string)');
    assertRetailUrl(next);
    if (seen.has(next)) throw new QueryFailed('NextPageLink repeated (paging loop)');
    url = next;
  }
}

// -------------------------------------------------------------- measurement
function newStat() {
  return { rows: 0, meters: new Set(), detail: new Map(), types: new Map() };
}

function addItem(stat, item) {
  stat.rows += 1;
  const meterName = typeof item.meterName === 'string' && item.meterName !== '' ? item.meterName : null;
  const skuName = typeof item.skuName === 'string' ? item.skuName : null;
  const productName = typeof item.productName === 'string' && item.productName !== '' ? item.productName : null;
  stat.meters.add(meterName ?? UNNAMED_METER);
  stat.detail.set(`${meterName}\u0001${skuName}\u0001${productName}`, { meterName, skuName, productName });
  const type = typeof item.type === 'string' ? item.type : '(none)';
  stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
}

/** One request chain. Resolves to { url, regions: Map<armRegionName, stat> } or { url, failed: reason }. */
async function runChain(client, service, region) {
  const url = queryUrl(service, region);
  const regions = new Map();
  try {
    await fetchAllPages(client, url, (item) => {
      if (item.serviceName !== service) {
        throw new QueryFailed(`a response row has serviceName '${clip(item.serviceName)}', expected '${service}'`);
      }
      const name = typeof item.armRegionName === 'string' ? item.armRegionName : NO_REGION;
      if (region !== null && name !== region) {
        throw new QueryFailed(`a response row has armRegionName '${clip(name)}', expected '${region}'`);
      }
      let stat = regions.get(name);
      if (!stat) {
        stat = newStat();
        regions.set(name, stat);
      }
      addItem(stat, item);
    });
  } catch (e) {
    if (e instanceof QueryFailed) return { url, failed: e.message };
    throw e;
  }
  return { url, regions };
}

const byText = (get) => (a, b) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0);

function measuredRow(base, stat) {
  const meters = [...stat.detail.values()].sort(byText((m) => `${m.meterName}|${m.skuName}|${m.productName}`));
  return {
    ...base,
    status: 'MEASURED',
    rows: stat.rows,
    distinctMeters: stat.meters.size,
    families: [...new Set(meters.map(familyOf))].sort(),
    typeCounts: Object.fromEntries([...stat.types].sort(byText(([k]) => k))),
    meters,
  };
}

function failedRow(base, reason, extra = {}) {
  return { ...base, status: 'FAILED', rows: null, distinctMeters: null, families: null, reason, ...extra };
}

/** Compare each queried region with the census's count of the same region. */
function crossChecked(row, censusRegions) {
  if (row.status !== 'MEASURED') return row;
  const c = censusRegions.get(row.region);
  const censusRows = c ? c.rows : 0;
  const censusMeters = c ? c.meters.size : 0;
  if (censusRows === row.rows && censusMeters === row.distinctMeters) return row;
  return failedRow(
    { service: row.service, regionFamily: row.regionFamily, region: row.region, source: row.source, url: row.url },
    `cross-check: the region query counted ${row.rows} rows / ${row.distinctMeters} meters, the all-region census ${censusRows} / ${censusMeters}`,
    { crossCheck: { queryRows: row.rows, queryMeters: row.distinctMeters, censusRows, censusMeters } },
  );
}

/** What the census says about a service whose Commercial queries all came back empty. */
function blindHint(census) {
  if (census.status !== 'MEASURED') return 'the all-region census FAILED, so nothing else is known about this serviceName';
  if (census.totalRows === 0) {
    return 'the all-region census returned 0 rows too, so this serviceName has no price rows in any region (use --services to measure the names that do)';
  }
  return `the all-region census returned ${plural(census.totalRows, 'row')} for it, so the serviceName exists and the queried Commercial region names are the suspect`;
}

function summariseService(service, rows, census) {
  const mine = rows.filter((r) => r.service === service);
  const failedCount = mine.filter((r) => r.status === 'FAILED').length + (census.status === 'FAILED' ? 1 : 0);
  const commercialQueried = mine.filter((r) => r.regionFamily === 'commercial' && r.source === 'query');
  const controlRow = commercialQueried.find((r) => r.status === 'MEASURED' && r.rows > 0);
  const control = controlRow ? { passed: true, region: controlRow.region, rows: controlRow.rows } : { passed: false, region: null, rows: null };
  // Blind: every Commercial query answered (none FAILED) and none returned a row.
  const blind = !control.passed && commercialQueried.every((r) => r.status === 'MEASURED');
  const out = { service, control, blind, blindHint: blind ? blindHint(census) : null, failedCount, complete: failedCount === 0 && control.passed };
  if (!out.complete) {
    return { ...out, productGroups: null, commercialFamilies: null, governmentFamilies: null, absentInGovernment: null, familyCoverage: null };
  }
  const families = new Map();
  const groups = new Map();
  for (const r of mine) {
    const side = r.regionFamily === 'government' ? 'government' : 'commercial';
    const seenInRow = new Set();
    for (const m of r.meters) {
      const family = familyOf(m);
      const productName = m.productName ?? NO_PRODUCT;
      const meterName = m.meterName ?? UNNAMED_METER;
      let f = families.get(family);
      if (!f) {
        f = { family, productName, commercialRegions: [], governmentRegions: [], commercial: new Set(), government: new Set() };
        families.set(family, f);
      }
      f[side].add(meterName);
      if (!seenInRow.has(family)) {
        f[`${side}Regions`].push(r.region);
        seenInRow.add(family);
      }
      let g = groups.get(productName);
      if (!g) {
        g = { productName, commercial: new Set(), government: new Set() };
        groups.set(productName, g);
      }
      g[side].add(meterName);
    }
  }
  const familyCoverage = [...families.values()].sort(byText((f) => f.family)).map((f) => ({
    family: f.family,
    productName: f.productName,
    commercialRegions: f.commercialRegions,
    governmentRegions: f.governmentRegions,
    commercialMeters: f.commercial.size,
    governmentMeters: f.government.size,
  }));
  const productGroups = [...groups.values()].sort(byText((g) => g.productName)).map((g) => ({
    productName: g.productName,
    commercialMeters: g.commercial.size,
    governmentMeters: g.government.size,
  }));
  const commercialFamilies = familyCoverage.filter((f) => f.commercialRegions.length > 0).map((f) => f.family);
  const governmentFamilies = familyCoverage.filter((f) => f.governmentRegions.length > 0).map((f) => f.family);
  const absentInGovernment = familyCoverage.filter((f) => f.commercialRegions.length > 0 && f.governmentRegions.length === 0).map((f) => f.family);
  return { ...out, productGroups, commercialFamilies, governmentFamilies, absentInGovernment, familyCoverage };
}

/** Run every chain for every service. Never throws for a failed COUNT; those become FAILED rows. */
export async function measure({ fetch: fetchFn, sleep, now, services: serviceNames = SERVICES }) {
  const client = createClient({ fetch: fetchFn, sleep, now });
  const rows = [];
  const censuses = [];
  const services = [];
  for (const service of serviceNames) {
    const queried = [];
    for (const [regionFamily, list] of [['government', GOVERNMENT_REGIONS], ['commercial', COMMERCIAL_REGIONS]]) {
      for (const region of list) {
        const base = { service, regionFamily, region, source: 'query' };
        const res = await runChain(client, service, region);
        queried.push(res.failed !== undefined
          ? failedRow({ ...base, url: res.url }, res.failed)
          : measuredRow({ ...base, url: res.url }, res.regions.get(region) ?? newStat()));
      }
    }

    const res = await runChain(client, service, null);
    const queriedNames = new Set(queried.map((r) => r.region));
    const census = { service, url: res.url, regions: [] };
    let checked = queried;
    const discovered = [];
    if (res.failed !== undefined) {
      census.status = 'FAILED';
      census.reason = res.failed;
      census.totalRows = null;
      census.distinctMeters = null;
    } else {
      census.status = 'MEASURED';
      checked = queried.map((r) => crossChecked(r, res.regions));
      const all = new Set();
      census.totalRows = 0;
      for (const [name, stat] of [...res.regions].sort(byText(([k]) => k))) {
        census.totalRows += stat.rows;
        for (const m of stat.meters) all.add(m);
        const family = queriedNames.has(name) ? null : GOVERNMENT_LIKE.test(name) ? 'government' : GLOBAL_LIKE.test(name) ? 'commercial-global' : null;
        census.regions.push({ name, rows: stat.rows, distinctMeters: stat.meters.size, regionFamily: family });
        if (family !== null) discovered.push(measuredRow({ service, regionFamily: family, region: name, source: 'census', url: res.url }, stat));
      }
      census.distinctMeters = all.size;
    }
    censuses.push(census);

    const pick = (family, source) => (r) => r.regionFamily === family && r.source === source;
    const serviceRows = [
      ...checked.filter(pick('government', 'query')),
      ...discovered.filter(pick('government', 'census')),
      ...checked.filter(pick('commercial', 'query')),
      ...discovered.filter(pick('commercial-global', 'census')),
    ];
    rows.push(...serviceRows);
    services.push(summariseService(service, serviceRows, census));
  }
  return { serviceNames: [...serviceNames], rows, censuses, services, requests: client.requests };
}

/** Exit code and the reasons behind it. */
export function evaluate(report, { requireGovCoverage = false } = {}) {
  const problems = [];
  for (const s of report.services) {
    if (s.failedCount > 0) problems.push(`${s.service}: ${s.failedCount} count(s) could not be fetched or verified (see FAILED above)`);
    if (s.blind) {
      problems.push(`${s.service}: INSTRUMENT BLIND - all ${COMMERCIAL_REGIONS.length} Commercial region queries returned 0 rows and ${s.blindHint}; a Government zero would be indistinguishable from a wrong filter (Learn: filter values are case sensitive)`);
    } else if (!s.control.passed) {
      problems.push(`${s.service}: positive control not established (no Commercial region query returned a row)`);
    }
  }
  if (problems.length > 0) return { exitCode: EXIT.FAILED, verdict: 'FAILED', problems };
  const gaps = report.services.filter((s) => s.absentInGovernment.length > 0);
  if (requireGovCoverage && gaps.length > 0) {
    const n = gaps.reduce((sum, s) => sum + s.absentInGovernment.length, 0);
    return {
      exitCode: EXIT.GOV_GAP,
      verdict: 'COVERAGE_GAP',
      problems: [`--require-gov-coverage: ${n} model famil${n === 1 ? 'y' : 'ies'} present in Commercial ha${n === 1 ? 's' : 've'} zero Government rows (${gaps.map((s) => `${s.service}: ${s.absentInGovernment.length}`).join(', ')})`],
    };
  }
  return { exitCode: EXIT.OK, verdict: 'OK', problems: [] };
}

// ---------------------------------------------------------------- rendering
const FAMILY_LABEL = {
  government: 'Government',
  commercial: 'Commercial',
  'commercial-global': 'Commercial (Global/DataZone)',
  census: 'Census (all regions)',
};

function rowsCell(row) {
  if (row.status === 'FAILED') return `FAILED (${row.reason})`;
  return row.rows === 0 ? '0 (measured)' : String(row.rows);
}

function metersCell(row) {
  if (row.status === 'FAILED') return 'FAILED';
  return row.distinctMeters === 0 ? '0 (measured)' : String(row.distinctMeters);
}

export function renderReport(report, verdict) {
  const table = [['service', 'region family', 'region', 'rows', 'distinct meters', 'query URL']];
  for (const service of report.serviceNames) {
    for (const r of report.rows.filter((x) => x.service === service)) {
      const region = clip(r.region) + (r.source === 'census' ? ' [census]' : '');
      table.push([service, FAMILY_LABEL[r.regionFamily], region, rowsCell(r), metersCell(r), r.url]);
    }
    const c = report.censuses.find((x) => x.service === service);
    const cenCells = c.status === 'FAILED'
      ? [`FAILED (${c.reason})`, 'FAILED']
      : [String(c.totalRows), String(c.distinctMeters)];
    table.push([service, FAMILY_LABEL.census, '(all regions) [census]', ...cenCells, c.url]);
  }
  const widths = table[0].slice(0, 5).map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const lines = table.map((r) => [...r.slice(0, 5).map((cell, i) => cell.padEnd(widths[i])), r[5]].join(' | '));
  lines.splice(1, 0, `${widths.map((w) => '-'.repeat(w)).join('-+-')}-+-${'-'.repeat(9)}`);

  const head = [
    `Azure Retail Prices coverage - ${report.serviceNames.join(' / ')} (api-version ${API_VERSION}, one request chain per region, page cap ${PAGE_CAP})`,
    '',
  ];
  const body = [];
  for (const s of report.services) {
    const c = report.censuses.find((x) => x.service === s.service);
    body.push('', `== ${s.service} ==`);
    if (s.control.passed) {
      body.push(`  positive control: ${s.control.region} returned ${plural(s.control.rows, 'row')} (a Commercial per-region query, the same filter shape as the Government ones)`);
    } else {
      body.push('  positive control: NOT ESTABLISHED');
    }
    if (c.status === 'MEASURED') {
      const named = (family) => {
        const names = c.regions.filter((x) => x.regionFamily === family).map((x) => `${clip(x.name)} (${x.rows})`);
        return names.length > 0 ? names.join(', ') : 'none';
      };
      body.push(`  census: ${plural(c.regions.length, 'armRegionName value')}, ${plural(c.totalRows, 'row')}; Global/DataZone-style: ${named('commercial-global')}; Government-style outside the queried ${GOVERNMENT_REGIONS.length}: ${named('government')}`);
    } else {
      body.push(`  census: FAILED (${c.reason})`);
    }
    if (s.absentInGovernment === null) {
      body.push(`  ABSENT in Government: NOT COMPUTED (${s.failedCount} count(s) FAILED or the positive control failed; a family is never called absent from a partial read)`);
      continue;
    }
    body.push('  product groups (the API productName; distinct meters, Commercial side / Government side):');
    for (const g of s.productGroups) body.push(`    ${clip(g.productName, 80)}: ${g.commercialMeters} / ${g.governmentMeters}`);
    body.push(`  model families (heuristic: productName :: model from meterName; raw names in the JSON): Commercial ${s.commercialFamilies.length}, Government ${s.governmentFamilies.length}`);
    body.push(`  ABSENT in Government (${s.absentInGovernment.length}):${s.absentInGovernment.length === 0 ? ' none' : ''}`);
    for (const f of s.absentInGovernment) body.push(`    - ${clip(f, 160)}`);
  }
  const foot = ['', `requests sent: ${report.requests} (sequential, >= ${MIN_GAP_MS} ms apart)`];
  if (verdict.verdict === 'OK') foot.push(`RESULT: OK (exit ${verdict.exitCode})`);
  else for (const p of verdict.problems) foot.push(`RESULT: ${verdict.verdict} - ${p} (exit ${verdict.exitCode})`);
  return [...head, ...lines, ...body, ...foot];
}

export function toJson(report, verdict, { generatedAt, requireGovCoverage }) {
  return {
    tool: 'scripts/measure/apiplane/retail-prices-coverage.mjs',
    generatedAt,
    apiBase: RETAIL_PRICES_URL,
    apiVersion: API_VERSION,
    pageCap: PAGE_CAP,
    minRequestGapMs: MIN_GAP_MS,
    maxRetries: MAX_RETRIES,
    serviceNames: report.serviceNames,
    governmentRegions: GOVERNMENT_REGIONS,
    commercialRegions: COMMERCIAL_REGIONS,
    requireGovCoverage,
    verdict: verdict.verdict,
    exitCode: verdict.exitCode,
    problems: verdict.problems,
    requests: report.requests,
    summary: report.services,
    census: report.censuses,
    rows: report.rows,
  };
}

// ---------------------------------------------------------------------- CLI
const USAGE = [
  'Usage: node scripts/measure/apiplane/retail-prices-coverage.mjs [--json <file>] [--require-gov-coverage] [--services <a,b>] [--help]',
  '  --json <file>           also write every row, the raw meter names and the census as JSON',
  '  --require-gov-coverage  exit 3 when a model family present in Commercial has zero Government rows',
  `  --services <a,b>        comma-separated serviceName values to measure (default: ${SERVICES.join(',')})`,
  'Exit: 0 complete | 1 bad invocation | 2 a count could not be fetched or verified, or the instrument is blind | 3 coverage gate failed',
].join('\n');

export function parseArgs(argv) {
  const opts = { json: null, requireGovCoverage: false, services: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--services') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: a === '--json' ? '--json needs a file path' : '--services needs a comma-separated list of serviceName values' };
      i += 1;
      if (a === '--json') {
        opts.json = value;
      } else {
        const names = [...new Set(value.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
        if (names.length === 0) return { error: '--services needs a comma-separated list of serviceName values' };
        const bad = names.find((n) => /['"\\]/.test(n) || /[^\x20-\x7e]/.test(n));
        if (bad !== undefined) return { error: `--services: a serviceName must be printable ASCII without quotes or backslashes: ${clip(bad)}` };
        opts.services = names;
      }
    } else if (a === '--require-gov-coverage') {
      opts.requireGovCoverage = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      return { error: `unknown argument: ${clip(a)}` };
    }
  }
  return { opts };
}

/**
 * Entry point with every side effect injectable. Returns { exitCode }; the CLI
 * wrapper below is the only place that touches process.exitCode.
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    err(`retail-prices-coverage: ${parsed.error}`);
    err(USAGE);
    return { exitCode: EXIT.USAGE };
  }
  if (parsed.opts.help) {
    out(USAGE);
    return { exitCode: EXIT.OK };
  }
  const report = await measure({
    fetch: deps.fetch ?? globalThis.fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => performance.now()),
    services: parsed.opts.services ?? SERVICES,
  });
  let verdict = evaluate(report, parsed.opts);
  if (parsed.opts.json !== null) {
    const generatedAt = (deps.wallClock ?? (() => new Date()))().toISOString();
    const text = `${JSON.stringify(toJson(report, verdict, { generatedAt, requireGovCoverage: parsed.opts.requireGovCoverage }), null, 2)}\n`;
    try {
      (deps.writeFile ?? writeFileSync)(parsed.opts.json, text);
    } catch (e) {
      // The artifact the caller asked for does not exist, so the run cannot report success.
      const problem = `could not write the --json file (${describeNetworkError(e)}); the artifact does not exist`;
      verdict = { exitCode: EXIT.FAILED, verdict: 'FAILED', problems: [problem, ...verdict.problems] };
    }
  }
  for (const line of renderReport(report, verdict)) out(line);
  return { exitCode: verdict.exitCode, report, verdict };
}

if (/[\\/]retail-prices-coverage\.mjs$/.test(process.argv[1] ?? '')) {
  const { exitCode } = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
