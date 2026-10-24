/**
 * #5099 phase C - the "always on, not pausable" inventory. Network edges (Resource
 * Graph `post`, Cost Management `costRun`) are injected; the query builder, the
 * classifier, the price table and the incomplete-vs-empty logic are the REAL code.
 * Every `it` names the input that breaks it (assertion-design.md).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ALWAYS_ON_TYPES,
  buildAlwaysOnQuery,
  classifyAlwaysOnRows,
  discoverAlwaysOn,
  estimateMonthly,
  fetchActualMtd,
  parseCostRows,
  type AlwaysOnArgRow,
} from '../estate-always-on';

const ESTATE = 'loom:e1';
const SUB = '11111111-1111-1111-1111-111111111111';
const mine = { 'loom-estate-id': ESTATE };
const id = (provider: string, name: string) => `/subscriptions/${SUB}/resourceGroups/rg/providers/${provider}/${name}`;
const row = (type: string, provider: string, name: string, extra: Partial<AlwaysOnArgRow> = {}): AlwaysOnArgRow => ({
  id: id(provider, name), name, type, resourceGroup: 'rg', subscriptionId: SUB, location: 'eastus', tags: mine, ...extra,
});
const FW = (extra: Partial<AlwaysOnArgRow> = {}) => row('microsoft.network/azurefirewalls', 'Microsoft.Network/azureFirewalls', 'fw-hub', { fwTier: 'Standard', ...extra });

describe('buildAlwaysOnQuery', () => {
  // Breaks if: a type named in the brief is dropped from the query, or the tag compare is not on THIS estate id.
  it('names every required type and filters on the exact estate-id tag', () => {
    const q = buildAlwaysOnQuery(ESTATE);
    for (const t of [
      'microsoft.network/azurefirewalls', 'microsoft.network/bastionhosts', 'microsoft.network/virtualnetworkgateways',
      'microsoft.apimanagement/service', 'microsoft.cache/redis', 'microsoft.cache/redisenterprise', 'microsoft.search/searchservices',
      'microsoft.cognitiveservices/accounts', 'microsoft.eventhub/namespaces', 'microsoft.purview/accounts', 'microsoft.cdn/profiles',
      'microsoft.containerregistry/registries',
    ]) expect(q, t).toContain(`'${t}'`);
    expect(q).toContain(`tostring(tags['loom-estate-id']) == '${ESTATE}'`);
    expect(ALWAYS_ON_TYPES.length).toBe(13);
  });
  // Breaks if: the estate id is interpolated unescaped (a quote in it would break out of the KQL string).
  it("escapes a quote in the estate id", () => {
    expect(buildAlwaysOnQuery("loom:o'x")).not.toContain("== 'loom:o'x'");
  });
});

describe('classifyAlwaysOnRows: ownership, reasons, cost provenance', () => {
  // Breaks if: ownership is not re-checked per row (a row of another estate would be listed as ours).
  it('a row whose estate tag is a DIFFERENT estate is dropped; the matching one is kept', () => {
    const rows = classifyAlwaysOnRows({
      rows: [FW(), FW({ id: id('Microsoft.Network/azureFirewalls', 'fw-other'), name: 'fw-other', tags: { 'loom-estate-id': 'loom:other' } })],
      estateId: ESTATE, cloud: 'Commercial',
    });
    expect(rows.map((r) => r.name)).toEqual(['fw-hub']);
  });

  // Breaks if: the Firewall reason loses the operator-decided wording (never paused because the console egresses through it).
  it('Azure Firewall: never-paused reason names the console egress; there is no pause verb in the row', () => {
    const [r] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'Commercial' });
    expect(r.reason).toContain("console's outbound traffic routes through it");
    expect(r.reason).toContain('impossible to resume from Loom');
  });

  // Breaks if: Bastion / VPN are described as pausable or the "only delete" fact is lost.
  it('Bastion and VPN gateway: "no stop verb; only delete"', () => {
    const bastion = row('microsoft.network/bastionhosts', 'Microsoft.Network/bastionHosts', 'bas', { skuName: 'Standard' });
    const vpn = row('microsoft.network/virtualnetworkgateways', 'Microsoft.Network/virtualNetworkGateways', 'vpn', { gwType: 'Vpn', gwSku: 'VpnGw1' });
    const er = row('microsoft.network/virtualnetworkgateways', 'Microsoft.Network/virtualNetworkGateways', 'er', { gwType: 'ExpressRoute', gwSku: 'Standard' });
    const out = classifyAlwaysOnRows({ rows: [bastion, vpn, er], estateId: ESTATE, cloud: 'Commercial' });
    expect(out.find((r) => r.name === 'bas')?.reason).toContain('no stop verb');
    expect(out.find((r) => r.name === 'vpn')?.reason).toContain('VPN gateway');
    expect(out.find((r) => r.name === 'er')?.reason).toContain('ExpressRoute gateway'); // distinguishes the gateway kinds
    expect(out.find((r) => r.name === 'vpn')?.reason).not.toContain('ExpressRoute');
  });

  // Breaks if: a Speech/Vision Cognitive Services account is listed as "Azure OpenAI / AI Services".
  it('Cognitive Services: only kind OpenAI / AIServices is listed', () => {
    const mk = (name: string, kind: string) => row('microsoft.cognitiveservices/accounts', 'Microsoft.CognitiveServices/accounts', name, { kind });
    const out = classifyAlwaysOnRows({ rows: [mk('aoai', 'OpenAI'), mk('ais', 'AIServices'), mk('speech', 'SpeechServices')], estateId: ESTATE, cloud: 'Commercial' });
    expect(out.map((r) => r.name)).toEqual(['aoai', 'ais']);
  });

  // THE R7 CASE. Breaks if: an estimate is labelled/shaped as an actual, or an actual is labelled an estimate.
  it('actual-mtd beats the estimate and is labelled actual; with no actual the SAME row is an estimate, labelled estimate', () => {
    const actual = new Map([[FW().id!.toLowerCase(), { amount: 123.456, currency: 'USD' }]]);
    const [withActual] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'Commercial', actual });
    expect(withActual.cost).toMatchObject({ source: 'actual-mtd', amount: 123.46, currency: 'USD' });
    expect(withActual.cost.label).toContain('actual month-to-date');
    expect(withActual.cost.label).not.toContain('estimate');

    const [est] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'Commercial' });
    expect(est.cost.source).toBe('estimate');
    expect(est.cost.amount).toBe(912.5); // 1.25 USD/h x 730 h
    expect(est.cost.label).toBe('estimate (list price, East US)');
    expect(est.cost.detail).toContain('NOT actual spend');
    expect(est.cost.label).not.toContain('actual');
  });

  // Breaks if: a resource outside East US is priced as if the rate were known for its region.
  it('a resource in another region says it was priced at East US and may differ', () => {
    const [r] = classifyAlwaysOnRows({ rows: [FW({ location: 'westeurope' })], estateId: ESTATE, cloud: 'Commercial' });
    expect(r.cost.detail).toContain('Priced at East US; this resource is in westeurope');
  });

  // Breaks if: Gov shows a Commercial list price (Gov prices differ and no Gov table exists).
  it('GCC-High: no estimate (cost unknown) without an actual; WITH an actual it is shown as actual', () => {
    const [none] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'GCC-High' });
    expect(none.cost.source).toBe('unknown');
    expect(none.cost.amount).toBeUndefined();
    expect(none.cost.detail).toContain('GCC-High');
    const [act] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'GCC-High', actual: new Map([[FW().id!.toLowerCase(), { amount: 10 }]]) });
    expect(act.cost.source).toBe('actual-mtd');
  });

  // Breaks if: a SKU absent from the table is given a made-up number.
  it('an unlisted SKU or a usage-priced type is "cost unknown" with no amount', () => {
    const odd = FW({ fwTier: 'Platinum' });
    const aoai = row('microsoft.cognitiveservices/accounts', 'Microsoft.CognitiveServices/accounts', 'aoai', { kind: 'OpenAI' });
    const out = classifyAlwaysOnRows({ rows: [odd, aoai], estateId: ESTATE, cloud: 'Commercial' });
    for (const r of out) {
      expect(r.cost.source, r.name).toBe('unknown');
      expect(r.cost.amount, r.name).toBeUndefined();
    }
  });

  // Breaks if: a failed actual-cost read is hidden, so the estimate looks like the normal case.
  it('when actual cost was unavailable, the row says why', () => {
    const [r] = classifyAlwaysOnRows({ rows: [FW()], estateId: ESTATE, cloud: 'Commercial', actualUnavailable: 'AuthorizationFailed-cm' });
    expect(r.cost.detail).toContain('AuthorizationFailed-cm');
    expect(r.cost.source).toBe('estimate');
  });
});

describe('estimateMonthly (list-price table, East US, 730 h / 30.42 d)', () => {
  const m = (r: AlwaysOnArgRow) => estimateMonthly(r)?.monthly;
  // Breaks if: a rate or a unit multiplier in the table changes. Each expected value is rate x units x 730 computed by hand.
  it('hand-computed monthly figures', () => {
    expect(m(FW({ fwTier: 'Premium' }))).toBe(1277.5); // 1.75 x 730
    expect(m(row('microsoft.network/bastionhosts', 'p', 'b', { skuName: 'Basic' }))).toBe(138.7); // 0.19 x 730
    expect(m(row('microsoft.apimanagement/service', 'p', 'a', { skuName: 'Premium', skuCapacity: 2 }))).toBe(5590.34); // 3.829 x 2 x 730
    expect(m(row('microsoft.search/searchservices', 'p', 's', { skuName: 'standard', replicaCount: 3, partitionCount: 2 }))).toBe(1471.68); // 0.336 x 6 x 730
    expect(m(row('microsoft.eventhub/namespaces', 'p', 'e', { skuName: 'Standard', skuCapacity: 4 }))).toBe(87.6); // 0.03 x 4 x 730
    expect(m(row('microsoft.cdn/profiles', 'p', 'f', { skuName: 'Premium_AzureFrontDoor' }))).toBe(330);
    expect(m(row('microsoft.containerregistry/registries', 'p', 'r', { skuName: 'Premium' }))).toBe(50.69); // 1.6666 x 730/24
    expect(m(row('microsoft.cache/redis', 'p', 'c', { skuName: 'Standard', redisFamily: 'C', redisCapacity: 1 }))).toBe(100.74); // 0.138 x 730
  });
  // Breaks if: a missing unit count is defaulted to 1 (an APIM with unknown capacity would be priced as one unit).
  it('missing capacity/replicas gives null, not a default of 1', () => {
    expect(m(row('microsoft.apimanagement/service', 'p', 'a', { skuName: 'Premium', skuCapacity: null }))).toBeUndefined();
    expect(m(row('microsoft.search/searchservices', 'p', 's', { skuName: 'standard', replicaCount: 1, partitionCount: null }))).toBeUndefined();
  });
});

describe('parseCostRows / fetchActualMtd', () => {
  const resp = (rows: unknown[][]) => ({ properties: { columns: [{ name: 'Cost' }, { name: 'ResourceId' }, { name: 'Currency' }], rows } });
  // Breaks if: ids are not lower-cased (Cost Management lower-cases them, ARG does not) or duplicate rows are not summed.
  it('keys by lower-cased id and sums duplicate rows', () => {
    const got = parseCostRows(resp([[10, '/Subscriptions/S/Fw', 'USD'], [2.5, '/subscriptions/s/fw', 'USD']]));
    expect(got.get('/subscriptions/s/fw')).toEqual({ amount: 12.5, currency: 'USD' });
  });
  // Breaks if: a response without the expected columns is read as "zero cost".
  it('a response without Cost/ResourceId columns yields no rows (not zeros)', () => {
    expect(parseCostRows({ properties: { columns: [{ name: 'Foo' }], rows: [[1]] } }).size).toBe(0);
    expect(parseCostRows(null).size).toBe(0);
  });
  // Breaks if: one failing subscription voids the others, or its failure is swallowed.
  it('queries per subscription, keeps the good one, and reports the failing one', async () => {
    const s1 = '/subscriptions/aaa/resourceGroups/r/providers/p/x';
    const s2 = '/subscriptions/bbb/resourceGroups/r/providers/p/y';
    const run = vi.fn(async (sub: string) => {
      if (sub === 'bbb') throw new Error('Cost query failed (403): no Cost Management Reader');
      return resp([[5, s1, 'USD']]);
    });
    const out = await fetchActualMtd([s1, s2], run);
    expect(run).toHaveBeenCalledTimes(2);
    expect([...out.actual.keys()]).toEqual([s1.toLowerCase()]); // keyed lower-cased
    expect(out.error).toContain('bbb');
    expect(out.error).toContain('403');
    const body = run.mock.calls[0][1] as any;
    expect(body.timeframe).toBe('MonthToDate');
    expect(body.dataset.filter.dimensions.values).toEqual([s1]); // only the listed ids are priced
  });
});

describe('discoverAlwaysOn: incomplete is never empty', () => {
  const okPage = (rows: unknown[]) => async () => ({ data: rows });
  // Breaks if: a failed Resource Graph query is returned as {rows:[], incomplete:false}.
  it('Resource Graph failure -> incomplete:true with the raw reason, no rows', async () => {
    const post = vi.fn(async () => { throw new Error('ARM POST failed 403: AuthorizationFailed-rg'); });
    const out = await discoverAlwaysOn({ estateId: ESTATE, cloud: 'Commercial', post, env: {} as NodeJS.ProcessEnv });
    expect(out.incomplete).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.note).toMatch(/^inventory incomplete:/);
    expect(out.note).toContain('AuthorizationFailed-rg');
    expect(out.note).toContain('not a statement that nothing is always on');
  });

  // Breaks if: an unbound console (no estate id) reports a complete, empty inventory.
  it('no estate id -> incomplete:true (and Resource Graph is not even called)', async () => {
    const post = vi.fn();
    const out = await discoverAlwaysOn({ estateId: 'loom:unbound', cloud: 'Commercial', post, env: {} as NodeJS.ProcessEnv });
    expect(out.incomplete).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  // Breaks if: a subscription the identity cannot read (looks identical to empty) is not flagged.
  it('a configured subscription the identity cannot read -> incomplete:true, rows still shown', async () => {
    const post = vi.fn(async (body: any) =>
      String(body.query).startsWith('resourcecontainers') ? { data: [{ subscriptionId: 'other-sub' }] } : { data: [FW()] });
    const out = await discoverAlwaysOn({
      estateId: ESTATE, cloud: 'Commercial', post, env: { LOOM_SUBSCRIPTION_ID: SUB } as unknown as NodeJS.ProcessEnv,
      costRun: async () => ({ properties: { columns: [], rows: [] } }),
    });
    expect(out.incomplete).toBe(true);
    expect(out.note).toContain(SUB);
    expect(out.rows.map((r) => r.name)).toEqual(['fw-hub']); // positive: what WAS found is still listed
  });

  // Breaks if: a complete result is wrongly marked incomplete, or the estimate/actual totals are mixed.
  it('complete: rows, estimate vs actual totals kept SEPARATE, costNote set when Cost Management failed', async () => {
    const bas = row('microsoft.network/bastionhosts', 'Microsoft.Network/bastionHosts', 'bas', { skuName: 'Standard' });
    const post = vi.fn(async () => ({ data: [FW(), bas] }));
    const out = await discoverAlwaysOn({
      estateId: ESTATE, cloud: 'Commercial', post, env: {} as NodeJS.ProcessEnv,
      costRun: async () => ({ properties: { columns: [{ name: 'Cost' }, { name: 'ResourceId' }, { name: 'Currency' }], rows: [[50, FW().id, 'USD']] } }),
    });
    expect(out.incomplete).toBe(false);
    expect(out.totals.actualMtd).toEqual({ amount: 50, currency: 'USD', rows: 1 });
    expect(out.totals.estimateMonthly).toEqual({ amount: 211.7, currency: 'USD', rows: 1 }); // bastion 0.29 x 730; NOT + 50
    expect(out.costNote).toBeUndefined();

    const failed = await discoverAlwaysOn({
      estateId: ESTATE, cloud: 'Commercial', post, env: {} as NodeJS.ProcessEnv,
      costRun: async () => { throw new Error('Cost query failed (429)'); },
    });
    expect(failed.costNote).toContain('429');
    expect(failed.rows.every((r) => r.cost.source !== 'actual-mtd')).toBe(true);
    expect(failed.rows.find((r) => r.name === 'fw-hub')?.cost.source).toBe('estimate'); // labelled estimate, not silently actual
  });

  // Breaks if: a complete + zero-row answer is not distinguishable (the UI needs incomplete:false to say "nothing").
  it('complete and empty -> incomplete:false, zero rows, zero totals', async () => {
    const out = await discoverAlwaysOn({ estateId: ESTATE, cloud: 'Commercial', post: okPage([]), env: {} as NodeJS.ProcessEnv });
    expect(out.incomplete).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.totals.unknownRows).toBe(0);
  });
});
