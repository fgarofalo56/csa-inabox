/**
 * Offline tests for retail-prices-coverage.mjs (PRP loom-api-gateway-plane, W0-5).
 *   node --test scripts/measure/apiplane/__tests__/retail-prices-coverage.test.mjs
 *
 * Nothing here touches the network or really sleeps: fetch, sleep and the clock are
 * injected. assertion-design.md: every test says, in its comment, which input breaks it
 * (BREAKS IF) and which mutant of the script it kills (KILLS). Every number asserted is a
 * LITERAL worked out by hand from the fixture next to it - never read back from the script,
 * so the script cannot agree with itself. The meter names in the normaliser test are real
 * ones copied from the 2026-10-29 live run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, queryUrl, normaliseModelName, familyOf, parseArgs } from '../retail-prices-coverage.mjs';

const SCRIPT = fileURLToPath(new URL('../retail-prices-coverage.mjs', import.meta.url));
const AO = 'Azure OpenAI';
const FM = 'Foundry Models';

// A test that forgets to inject fetch must not reach prices.azure.com.
globalThis.fetch = () => {
  throw new Error('offline suite: a test reached the real fetch');
};

// ------------------------------------------------------------------ fixtures
function row(service, region, meterName, extra = {}) {
  return {
    currencyCode: 'USD', serviceName: service, armRegionName: region, meterName, skuName: meterName,
    productName: service, type: 'Consumption', retailPrice: 0.001, ...extra,
  };
}
/** Rows of one productName in one region. */
const rp = (service, region, productName, meterNames) => meterNames.map((m) => row(service, region, m, { productName }));
const many = (service, region, n) => Array.from({ length: n }, (_, i) => row(service, region, `m${i + 1}`));

/*
 * The base world. Worked out by hand (family = "<productName> :: <model>"):
 *   Azure OpenAI  eastus        4 rows / 4 meters  Azure OpenAI :: gpt 4o (2 meters), Azure OpenAI :: gpt 4o mini,
 *                                                  Azure OpenAI Reasoning :: o1
 *                 eastus2       2 rows / 2 meters  Azure OpenAI :: gpt 4o, Azure OpenAI Embedding :: text embedding 3 large
 *                 usgovvirginia 2 rows / 2 meters  Azure OpenAI :: gpt 4o (2 meters)
 *                 DataZoneUS    2 rows / 2 meters  Azure OpenAI :: gpt 4o mini, Azure OpenAI :: gpt 4 1   (census only)
 *                 every other queried region: 0 rows
 *                 census: 4 region names, 10 rows, 9 distinct meters
 *   Foundry Models eastus       2 rows / 2 meters  Azure Mistral Models :: mistral large,
 *                                                  Azure Llama Models :: llama 3 3 70b instruct
 *                 usgovvirginia 1 row  / 1 meter   Azure Mistral Models :: mistral large
 *                 census: 2 region names, 3 rows
 * Product groups (distinct meters Commercial side / Government side):
 *   Azure OpenAI: 5 / 2, Azure OpenAI Embedding: 1 / 0, Azure OpenAI Reasoning: 1 / 0
 *   Azure Llama Models: 1 / 0, Azure Mistral Models: 1 / 1
 * The Commercial families absent in Government are
 *   Azure OpenAI : gpt 4 1, gpt 4o mini, Embedding :: text embedding 3 large, Reasoning :: o1  (4)
 *   Foundry Models: Azure Llama Models :: llama 3 3 70b instruct                               (1)
 */
function baseWorld() {
  return [
    ...rp(AO, 'eastus', 'Azure OpenAI', ['gpt-4o-0513-Inp-glbl', 'gpt-4o-0513-Outp-glbl', 'gpt-4o-mini-0718-Inp-regnl']),
    ...rp(AO, 'eastus', 'Azure OpenAI Reasoning', ['o1-1217-Inp-regnl']),
    ...rp(AO, 'eastus2', 'Azure OpenAI', ['gpt-4o-0513-Inp-glbl']),
    ...rp(AO, 'eastus2', 'Azure OpenAI Embedding', ['text-embedding-3-large-Tokens']),
    ...rp(AO, 'usgovvirginia', 'Azure OpenAI', ['gpt-4o-0513-Inp-regnl', 'gpt-4o-0513-Outp-regnl']),
    ...rp(AO, 'DataZoneUS', 'Azure OpenAI', ['gpt-4o-mini-0718-Inp-dz', 'gpt-4.1-2025-04-14-Input-Data Zone']),
    ...rp(FM, 'eastus', 'Azure Mistral Models', ['Mistral-Large-2411-Inp']),
    ...rp(FM, 'eastus', 'Azure Llama Models', ['Llama-3.3-70B-Instruct-Inp']),
    ...rp(FM, 'usgovvirginia', 'Azure Mistral Models', ['Mistral-Large-2411-Inp']),
  ];
}
const ABSENT_AO = [
  'Azure OpenAI :: gpt 4 1',
  'Azure OpenAI :: gpt 4o mini',
  'Azure OpenAI Embedding :: text embedding 3 large',
  'Azure OpenAI Reasoning :: o1',
];
const ABSENT_FM = ['Azure Llama Models :: llama 3 3 70b instruct'];

// --------------------------------------------------------------------- fakes
const respond = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });

function makeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

/**
 * A fake prices.azure.com. Serves `items` filtered by the parsed $filter, paged by $skip with
 * a NextPageLink in the real shape (":443" included). `intercept(ctx)` may take over a response:
 * return { throw }, { status, body } or { json }; ctx.chainCalls counts calls for that service+region.
 */
function makeApi(items, { pageSize = 1000, pageSizes, intercept, latencyMs = 0 } = {}) {
  const clock = makeClock();
  const calls = [];
  async function fetch(url, init) {
    const u = new URL(url);
    const filter = u.searchParams.get('$filter') ?? '';
    const service = /serviceName eq '([^']*)'/.exec(filter)?.[1];
    const region = /armRegionName eq '([^']*)'/.exec(filter)?.[1];
    const skip = Number(u.searchParams.get('$skip') ?? 0);
    const call = { url, at: clock.now(), service, region, skip, init, filter };
    calls.push(call);
    clock.advance(latencyMs);
    call.endAt = clock.now();
    const chainCalls = calls.filter((c) => c.service === service && c.region === region).length;
    const hijack = intercept?.({ ...call, chainCalls });
    if (hijack?.throw) throw hijack.throw;
    if (hijack) return respond(hijack.status ?? 200, hijack.body ?? JSON.stringify(hijack.json));
    if (u.hostname !== 'prices.azure.com' || service === undefined) return respond(404, '{}');
    const matching = items.filter((i) => i.serviceName === service && (region === undefined || i.armRegionName === region));
    let size = pageSize;
    const sizes = pageSizes?.(service, region);
    if (sizes) {
      const offsets = sizes.reduce((acc, s) => [...acc, acc[acc.length - 1] + s], [0]);
      const idx = offsets.indexOf(skip);
      if (idx < 0 || idx >= sizes.length) return respond(400, '{}');
      size = sizes[idx];
    }
    const next = skip + size < matching.length
      ? `${url.split('&$skip=')[0].replace('https://prices.azure.com/', 'https://prices.azure.com:443/')}&$skip=${skip + size}`
      : null;
    return respond(200, JSON.stringify({ BillingCurrency: 'USD', Items: matching.slice(skip, skip + size), NextPageLink: next }));
  }
  return { fetch, clock, calls };
}

async function run(api, argv = [], extra = {}) {
  const lines = [];
  const errs = [];
  const files = new Map();
  const result = await main(argv, {
    fetch: api.fetch,
    sleep: api.clock.sleep,
    now: api.clock.now,
    wallClock: () => new Date('2026-10-29T12:00:00Z'),
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    writeFile: (p, t) => files.set(p, t),
    ...extra,
  });
  return { ...result, lines, errs, files, text: lines.join('\n') };
}

/** The printed table row for (service, region), cells trimmed. */
function tableRow(lines, service, region) {
  const line = lines.find((l) => {
    const c = l.split(' | ');
    return c.length >= 6 && c[0].trim() === service && c[2].trim() === region;
  });
  assert.ok(line, `no table row for ${service} / ${region}`);
  const c = line.split(' | ').map((x) => x.trim());
  return { family: c[1], rows: c[3], meters: c[4], url: c.slice(5).join(' | ') };
}

/** The "ABSENT in Government" header line and the family lines under it. */
function absentList(lines, service) {
  const start = lines.indexOf(`== ${service} ==`);
  assert.ok(start >= 0, `no section for ${service}`);
  const header = lines.findIndex((l, i) => i > start && l.startsWith('  ABSENT in Government'));
  assert.ok(header > start, `no ABSENT line for ${service}`);
  const items = [];
  for (let i = header + 1; i < lines.length && lines[i].startsWith('    - '); i += 1) items.push(lines[i].slice(6));
  return { header: lines[header], items };
}

/** The product-group lines of a service section, leading spaces removed. */
function productGroups(lines, service) {
  const start = lines.indexOf(`== ${service} ==`);
  assert.ok(start >= 0, `no section for ${service}`);
  const header = lines.findIndex((l, i) => i > start && l.startsWith('  product groups'));
  assert.ok(header > start, `no product-group header for ${service}`);
  const items = [];
  for (let i = header + 1; i < lines.length && lines[i].startsWith('    ') && !lines[i].startsWith('    - '); i += 1) items.push(lines[i].trim());
  return items;
}

const failedBy = (lines, prefix) => lines.filter((l) => l.startsWith('RESULT: FAILED') && l.includes(prefix));

// --------------------------------------------------------------------- tests
test('a network failure for ONE Government region is FAILED, never 0, and the run exits 2', async () => {
  // BREAKS IF: runChain's catch records an empty result for the failed chain (that row would read
  // "0 (measured)", the JSON would hold 0, and the run would exit 0).
  // KILLS: a mutant whose catch returns an empty region map; a mutant that stores rows: 0 for a failed row.
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const api = makeApi(baseWorld(), { intercept: (c) => (c.region === 'usgovtexas' ? { throw: boom } : undefined) });
  const r = await run(api, ['--json', 'out.json']);
  assert.equal(r.exitCode, 2);
  for (const service of [AO, FM]) {
    const t = tableRow(r.lines, service, 'usgovtexas');
    assert.equal(t.rows, 'FAILED (network error (ECONNRESET) after 3 retries)');
    assert.equal(t.meters, 'FAILED');
  }
  // positive pair: the neighbouring Government region of the same service is still a real count
  assert.equal(tableRow(r.lines, AO, 'usgovvirginia').rows, '2');
  // no absence claim is made from a partial read
  assert.match(absentList(r.lines, AO).header, /NOT COMPUTED/);
  assert.deepEqual(absentList(r.lines, AO).items, []);
  assert.equal(failedBy(r.lines, 'Azure OpenAI: 1 count(s) could not be fetched or verified').length, 1);
  // the JSON stores null for the failed count, a real number for its neighbour
  const json = JSON.parse(r.files.get('out.json'));
  const failed = json.rows.find((x) => x.service === AO && x.region === 'usgovtexas');
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.rows, null);
  assert.equal(failed.distinctMeters, null);
  assert.equal(failed.families, null);
  assert.equal(json.rows.find((x) => x.service === AO && x.region === 'usgovvirginia').rows, 2);
  assert.equal(json.exitCode, 2);
});

test('HTTP 200 with no rows is a MEASURED zero: "0 (measured)", exit 0, read next to its positive control', async () => {
  // BREAKS IF: an empty Items list is treated as a failure (exit 2), or is printed as a bare 0 or
  // without "(measured)", or if a second request per chain is made (26 is 13 chains x 2 services).
  // KILLS: empty page == malformed; the "0 (measured)" label dropped; every page fetched twice.
  const api = makeApi(baseWorld());
  const r = await run(api);
  assert.equal(r.exitCode, 0);
  const t = tableRow(r.lines, AO, 'usgovtexas');
  assert.equal(t.rows, '0 (measured)');
  assert.equal(t.meters, '0 (measured)');
  assert.equal(t.family, 'Government');
  // the zero is read next to a Commercial query of the same shape that DID return rows
  assert.equal(tableRow(r.lines, AO, 'eastus').rows, '4');
  assert.equal(tableRow(r.lines, AO, 'eastus').family, 'Commercial');
  assert.equal(tableRow(r.lines, AO, '(all regions) [census]').family, 'Census (all regions)');
  assert.ok(r.lines.includes('  positive control: eastus returned 4 rows (a Commercial per-region query, the same filter shape as the Government ones)'));
  assert.ok(r.lines.includes('requests sent: 26 (sequential, >= 200 ms apart)'));
  assert.ok(r.lines.includes('RESULT: OK (exit 0)'));
});

test('paging follows NextPageLink over 3 pages: 9 rows and 7 distinct meters, not page 1, the last page or the page count', async () => {
  // Fixture: Azure OpenAI eastus has 9 rows over pages of 4 / 3 / 2 with meters
  //   page 1 alpha beta gamma delta | page 2 gamma epsilon zeta | page 3 eta alpha  => 9 rows, 7 distinct.
  // BREAKS IF: the chain stops after page 1 (4), counts the last page (2), counts pages (3), or adds up
  // per-page distinct counts (4 + 3 + 2 = 9 distinct instead of 7).
  // KILLS: a mutant that ignores NextPageLink; one that keeps only the last page.
  const world = [
    ...rows9(),
    ...rp(FM, 'eastus', 'Azure Mistral Models', ['Mistral-Large-2411-Inp']),
  ];
  function rows9() {
    return ['alpha', 'beta', 'gamma', 'delta', 'gamma', 'epsilon', 'zeta', 'eta', 'alpha'].map((m) => row(AO, 'eastus', m));
  }
  const api = makeApi(world, { pageSizes: (s, region) => (s === AO && region === 'eastus' ? [4, 3, 2] : undefined) });
  const r = await run(api);
  assert.equal(r.exitCode, 0);
  const t = tableRow(r.lines, AO, 'eastus');
  assert.equal(t.rows, '9');
  assert.equal(t.meters, '7');
  // singular wording: Foundry Models eastus has exactly one row in this fixture
  assert.ok(r.lines.includes('  positive control: eastus returned 1 row (a Commercial per-region query, the same filter shape as the Government ones)'));
  const chain = api.calls.filter((c) => c.service === AO && c.region === 'eastus');
  assert.deepEqual(chain.map((c) => c.skip), [0, 4, 7], 'the three pages were fetched through the NextPageLink the server returned');
  // every chain pages, the census included: 10 rows at 3 per page is 4 requests, and the cross-check still agrees
  const small = makeApi(baseWorld(), { pageSize: 3 });
  const s = await run(small);
  assert.equal(s.exitCode, 0);
  assert.equal(tableRow(s.lines, AO, '(all regions) [census]').rows, '10');
  assert.equal(small.calls.filter((c) => c.service === AO && c.region === undefined).length, 4);
  assert.equal(tableRow(s.lines, AO, 'eastus').rows, '4');
});

test('a service with no Commercial row is INSTRUMENT BLIND: exit 2 and no absence claim, though every query answered 200', async () => {
  // Fixture: Foundry Models has a Government row but ZERO rows in all six Commercial regions (a mis-spelt
  // serviceName looks like this, except that its census is empty too). BREAKS IF: the control is dropped - a
  // Government set next to an all-zero Commercial set would then be published as a result.
  // KILLS: a mutant that always passes the control.
  const world = [...baseWorld().filter((i) => i.serviceName === AO), ...rp(FM, 'usgovvirginia', 'Azure Mistral Models', ['Mistral-Large-2411-Inp'])];
  const r = await run(makeApi(world));
  assert.equal(r.exitCode, 2);
  assert.ok(r.lines.includes('RESULT: FAILED - Foundry Models: INSTRUMENT BLIND - all 6 Commercial region queries returned 0 rows and the all-region census returned 1 row for it, so the serviceName exists and the queried Commercial region names are the suspect; a Government zero would be indistinguishable from a wrong filter (Learn: filter values are case sensitive) (exit 2)'));
  assert.ok(r.lines.includes('  positive control: NOT ESTABLISHED'));
  assert.ok(r.lines.includes('  census: 1 armRegionName value, 1 row; Global/DataZone-style: none; Government-style outside the queried 6: none'));
  assert.match(absentList(r.lines, FM).header, /NOT COMPUTED/);
  // positive pair: the other service's control passed and its absence list is still computed
  assert.deepEqual(absentList(r.lines, AO).items, ABSENT_AO);
});

test('a serviceName with no rows anywhere (census empty too) is BLIND and says so, pointing at --services', async () => {
  // This is what the live run measured for "Azure OpenAI" on 2026-10-29. BREAKS IF: the message cannot tell
  // "the name does not exist" (census 0) from "the name exists but the six regions are wrong" (census > 0).
  // KILLS: a mutant that always prints the census > 0 wording; one that drops the hint.
  const world = baseWorld().filter((i) => i.serviceName === FM);
  const r = await run(makeApi(world));
  assert.equal(r.exitCode, 2);
  assert.ok(r.lines.includes('RESULT: FAILED - Azure OpenAI: INSTRUMENT BLIND - all 6 Commercial region queries returned 0 rows and the all-region census returned 0 rows too, so this serviceName has no price rows in any region (use --services to measure the names that do); a Government zero would be indistinguishable from a wrong filter (Learn: filter values are case sensitive) (exit 2)'));
  assert.equal(tableRow(r.lines, AO, '(all regions) [census]').rows, '0');
  // positive pair: the service that exists was measured in full
  assert.deepEqual(absentList(r.lines, FM).items, ABSENT_FM);
});

test('Commercial queries that FAILED are "control not established", not "blind"', async () => {
  // BREAKS IF: blind is decided without checking that every Commercial query answered - a failed read
  // would then be reported as "the filter is wrong".
  // KILLS: a mutant that drops the every(MEASURED) condition from `blind`.
  const commercial = new Set(['eastus', 'eastus2', 'centralus', 'westus', 'westus3', 'swedencentral']);
  const api = makeApi(baseWorld(), { intercept: (c) => (c.service === FM && commercial.has(c.region) ? { status: 503, body: '' } : undefined) });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, FM, 'eastus').rows, 'FAILED (HTTP 503 after 3 retries)');
  assert.equal(failedBy(r.lines, 'Foundry Models: positive control not established').length, 1);
  assert.equal(failedBy(r.lines, 'INSTRUMENT BLIND').length, 0, 'a failed read must not be called a blind filter');
});

test('a NextPageLink that never ends FAILS at exactly 200 pages; 200 pages that do end are a real count', async () => {
  // Fixture A: every page of Azure OpenAI / usgovtexas has one row and a fresh NextPageLink; the fake
  // itself ends the chain after 1000 requests so a mutant WITHOUT the cap terminates instead of hanging.
  // BREAKS IF: the cap is missing, or off by one (201 requests), or the truncated count is returned.
  // Fixture B: exactly 200 one-row pages, the last without a link, must succeed with 200 rows.
  // KILLS: `page > PAGE_CAP + 1`; `page >= PAGE_CAP`; no cap at all.
  const endless = (c) => {
    if (!(c.service === AO && c.region === 'usgovtexas')) return undefined;
    if (c.chainCalls > 1000) return { json: { Items: [], NextPageLink: null } };
    const next = `https://prices.azure.com:443/api/retail/prices?api-version=2023-01-01-preview&$filter=${encodeURIComponent("serviceName eq 'Azure OpenAI' and armRegionName eq 'usgovtexas'")}&$skip=${c.chainCalls * 1000}`;
    return { json: { Items: [row(AO, 'usgovtexas', `endless-${c.chainCalls}`)], NextPageLink: next } };
  };
  const api = makeApi(baseWorld(), { intercept: endless });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, 'FAILED (paging did not terminate within 200 pages)');
  assert.equal(api.calls.filter((c) => c.service === AO && c.region === 'usgovtexas').length, 200, 'page 201 is never requested');
  assert.equal(tableRow(r.lines, AO, 'usgovvirginia').rows, '2', 'the other chains are unaffected');

  const world = [...baseWorld(), ...many(AO, 'usgovtexas', 200)];
  const exact = makeApi(world, { pageSizes: (s, region) => (s === AO && region === 'usgovtexas' ? Array(200).fill(1) : undefined) });
  const ok = await run(exact);
  assert.equal(ok.exitCode, 0);
  assert.equal(tableRow(ok.lines, AO, 'usgovtexas').rows, '200');
  assert.equal(exact.calls.filter((c) => c.service === AO && c.region === 'usgovtexas').length, 200);
});

test('a NextPageLink that points back at a page already read FAILS as a loop after one request', async () => {
  // BREAKS IF: the repeat check is missing - the chain would burn all 200 pages and report the cap instead.
  // KILLS: a mutant with the `seen` check disabled (the reason would read "did not terminate").
  const first = queryUrl(AO, 'usgovtexas');
  const api = makeApi(baseWorld(), {
    intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { json: { Items: [row(AO, 'usgovtexas', 'loop')], NextPageLink: first } } : undefined),
  });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, 'FAILED (NextPageLink repeated (paging loop))');
  assert.equal(api.calls.filter((c) => c.service === AO && c.region === 'usgovtexas').length, 1);
});

test('--require-gov-coverage exits 3 when a Commercial family has zero Government rows, and only then', async () => {
  // BREAKS IF: the gate never fires (first assertion), always fires (third), or fires without the flag (second).
  // KILLS: gate skipped; gate ignoring the flag; GOV_GAP mapped to 0.
  const gap = await run(makeApi(baseWorld()), ['--require-gov-coverage']);
  assert.equal(gap.exitCode, 3);
  assert.deepEqual(absentList(gap.lines, AO).items, ABSENT_AO);
  assert.equal(absentList(gap.lines, AO).header, '  ABSENT in Government (4):');
  assert.deepEqual(absentList(gap.lines, FM).items, ABSENT_FM);
  assert.equal(failedBy(gap.lines, '').length, 0);
  assert.ok(gap.lines.includes('RESULT: COVERAGE_GAP - --require-gov-coverage: 5 model families present in Commercial have zero Government rows (Azure OpenAI: 4, Foundry Models: 1) (exit 3)'));

  // the same data without the flag is a successful measurement that still lists the absent families
  const noFlag = await run(makeApi(baseWorld()));
  assert.equal(noFlag.exitCode, 0);
  assert.deepEqual(absentList(noFlag.lines, AO).items, ABSENT_AO);

  // Government carries every Commercial family: exit 0 even with the flag
  const covered = [
    ...baseWorld(),
    ...rp(AO, 'usgovarizona', 'Azure OpenAI', ['gpt-4o-mini-0718-Inp-regnl', 'gpt-4.1-2025-04-14-Input-regnl']),
    ...rp(AO, 'usgovarizona', 'Azure OpenAI Reasoning', ['o1-1217-Inp-regnl']),
    ...rp(AO, 'usgovarizona', 'Azure OpenAI Embedding', ['text-embedding-3-large-Tokens']),
    ...rp(FM, 'usgovarizona', 'Azure Llama Models', ['Llama-3.3-70B-Instruct-Inp']),
  ];
  const ok = await run(makeApi(covered), ['--require-gov-coverage']);
  assert.equal(ok.exitCode, 0);
  assert.equal(absentList(ok.lines, AO).header, '  ABSENT in Government (0): none');
  assert.deepEqual(absentList(ok.lines, AO).items, []);

  // exactly one family short: singular wording ("1 model family ... has"), only the service that has the gap is named
  const oneShort = covered.filter((i) => !(i.serviceName === FM && i.armRegionName === 'usgovarizona'));
  const one = await run(makeApi(oneShort), ['--require-gov-coverage']);
  assert.equal(one.exitCode, 3);
  assert.ok(one.lines.includes('RESULT: COVERAGE_GAP - --require-gov-coverage: 1 model family present in Commercial has zero Government rows (Foundry Models: 1) (exit 3)'));
  assert.deepEqual(absentList(one.lines, FM).items, ABSENT_FM);
  assert.deepEqual(absentList(one.lines, AO).items, []);
});

test('a FAILED count outranks the coverage gate: exit 2, not 3', async () => {
  // BREAKS IF: the gate is evaluated before failures - a run with a count that could not be fetched
  // would then claim a coverage verdict from partial data.
  // KILLS: a mutant that swaps the order of the two checks in evaluate().
  const api = makeApi(baseWorld(), { intercept: (c) => (c.region === 'usgovtexas' ? { status: 404, body: '{}' } : undefined) });
  const r = await run(api, ['--require-gov-coverage']);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, 'FAILED (HTTP 404)');
  assert.equal(r.lines.filter((l) => l.startsWith('RESULT: COVERAGE_GAP')).length, 0);
});

test('retry: HTTP 500 then 200 succeeds after one 1000 ms backoff; 429 gives up after exactly 3 retries (1s, 2s, 4s)', async () => {
  // BREAKS IF: 5xx is not retried (a transient 500 becomes a FAILED row), the bound is off by one
  // (5 attempts and an undefined backoff), or 429 is not treated as transient.
  // KILLS: `status > 500`; `retry <= MAX_RETRIES`; a mutant without the 429 arm.
  const once = makeApi(baseWorld(), { intercept: (c) => (c.service === AO && c.region === 'usgovvirginia' && c.chainCalls === 1 ? { status: 500, body: 'oops' } : undefined) });
  const a = await run(once);
  assert.equal(a.exitCode, 0);
  assert.equal(tableRow(a.lines, AO, 'usgovvirginia').rows, '2');
  assert.equal(once.calls.filter((c) => c.service === AO && c.region === 'usgovvirginia').length, 2);
  assert.deepEqual(once.clock.sleeps.filter((ms) => ms >= 1000), [1000]);

  const throttled = makeApi(baseWorld(), { intercept: (c) => (c.service === FM && c.region === 'usgoviowa' ? { status: 429, body: '' } : undefined) });
  const b = await run(throttled);
  assert.equal(b.exitCode, 2);
  assert.equal(tableRow(b.lines, FM, 'usgoviowa').rows, 'FAILED (HTTP 429 after 3 retries)');
  assert.equal(throttled.calls.filter((c) => c.service === FM && c.region === 'usgoviowa').length, 4, '1 attempt + 3 retries');
  assert.deepEqual(throttled.clock.sleeps.filter((ms) => ms >= 1000), [1000, 2000, 4000]);
});

test('a 404 is not retried: one request, FAILED (HTTP 404), no backoff', async () => {
  // BREAKS IF: any non-200 is retried (4 requests and 7 s of backoff for an answer that cannot change).
  // KILLS: a mutant with `transient = status !== 200`; `status >= 400`.
  const api = makeApi(baseWorld(), { intercept: (c) => (c.service === AO && c.region === 'usgovarizona' ? { status: 404, body: '{}' } : undefined) });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, AO, 'usgovarizona').rows, 'FAILED (HTTP 404)');
  assert.equal(api.calls.filter((c) => c.service === AO && c.region === 'usgovarizona').length, 1);
  assert.deepEqual(api.clock.sleeps.filter((ms) => ms >= 1000), []);
});

test('requests are sequential and start at least 200 ms after the previous response ended', async () => {
  // Fixture: every response takes 50 ms on the injected clock. BREAKS IF: the gap is removed, shortened to
  // 199, or measured from the START of the previous request (the end-to-start gap would be 150).
  // KILLS: MIN_GAP_MS = 0 / 199; a mutant that stamps lastEnd before the fetch.
  const api = makeApi(baseWorld(), { latencyMs: 50 });
  await run(api);
  assert.equal(api.calls.length, 26);
  const gaps = api.calls.slice(1).map((c, i) => c.at - api.calls[i].endAt);
  assert.ok(gaps.every((g) => g >= 200), `smallest end-to-start gap was ${Math.min(...gaps)} ms`);
  assert.ok(api.clock.sleeps.includes(200), 'the 200 ms wait was actually slept on the injected clock');
});

test('every request names the script in its User-Agent and sends only eq/and filters in the documented shape', async () => {
  // BREAKS IF: the User-Agent header is dropped, or a filter uses `or`, `in`, `startswith` or a field other
  // than serviceName / armRegionName (Learn documents eq, and and contains(meterName) only).
  // KILLS: a mutant without the header; a mutant that rewrites the region predicate.
  const api = makeApi(baseWorld());
  await run(api);
  const shape = /^serviceName eq '[^']+'( and armRegionName eq '[^']+')?$/;
  assert.ok(api.calls.length > 0);
  for (const c of api.calls) {
    assert.match(c.filter, shape);
    assert.match(c.init.headers['user-agent'], /retail-prices-coverage/);
    assert.equal(c.init.headers.accept, 'application/json');
    assert.ok(c.init.signal instanceof AbortSignal, 'every request carries a timeout signal, so a hung connection cannot stall the run');
  }
});

test('the table prints the exact URL each chain requested, and that URL went on the wire', async () => {
  // BREAKS IF: the printed URL is rebuilt differently from the requested one (decoded, another version, another
  // field). The expected strings are typed here from the Learn grammar, not produced by queryUrl().
  const api = makeApi(baseWorld());
  const r = await run(api);
  const gov = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Azure%20OpenAI'%20and%20armRegionName%20eq%20'usgovvirginia'";
  const census = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20'Foundry%20Models'";
  assert.equal(tableRow(r.lines, AO, 'usgovvirginia').url, gov);
  assert.equal(tableRow(r.lines, FM, '(all regions) [census]').url, census);
  assert.ok(api.calls.some((c) => c.url === gov));
  assert.ok(api.calls.some((c) => c.url === census));
  assert.equal(queryUrl(FM), census);
  assert.throws(() => queryUrl("Azure OpenAI' or 'x"), /without quotes/);
  assert.throws(() => queryUrl(AO, "usgov'x"), /without quotes/);
  assert.throws(() => queryUrl('a"b'), /without quotes/);
  assert.throws(() => queryUrl(AO, 'us\\gov'), /without quotes/);
  assert.throws(() => queryUrl(''), /non-empty/);
  assert.throws(() => queryUrl(42), /non-empty/);
});

test('a malformed 200 FAILS with a fixed reason and the body is never echoed', async () => {
  // BREAKS IF: a non-JSON body, a missing/odd Items, a non-object row or a non-string NextPageLink is read
  // as an empty or partial list, or if the reason carries bytes of the body (only counts, names, URLs print).
  // KILLS: a mutant that appends the body to the reason; one that treats a missing Items as [].
  const cases = [
    ['not JSON', '<html>BODY-MARKER-1</html>', 'malformed JSON'],
    ['JSON null', 'null', 'malformed response (no Items array)'],
    ['JSON array', '[]', 'malformed response (no Items array)'],
    ['no Items', JSON.stringify({ NextPageLink: null, extra: 'BODY-MARKER-2' }), 'malformed response (no Items array)'],
    ['Items not an array', JSON.stringify({ Items: { a: 1 } }), 'malformed response (no Items array)'],
    ['row not an object', JSON.stringify({ Items: [5] }), 'malformed response (an Items entry is not an object)'],
    ['NextPageLink a number', JSON.stringify({ Items: [], NextPageLink: 7 }), 'malformed response (NextPageLink is not a string)'],
  ];
  for (const [name, body, reason] of cases) {
    const api = makeApi(baseWorld(), { intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { status: 200, body } : undefined) });
    const r = await run(api);
    assert.equal(r.exitCode, 2, name);
    assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, `FAILED (${reason})`, name);
    assert.ok(!r.text.includes('BODY-MARKER'), `${name}: the body leaked into the output`);
  }
});

test('a NextPageLink is followed only on https://prices.azure.com; anything else FAILS and is never requested', async () => {
  // BREAKS IF: the host check is missing or loose (substring / suffix match), the scheme, port or userinfo
  // is not checked. Each link below would otherwise be fetched.
  // KILLS: removing any one of the five conditions; includes() / endsWith() for the host.
  const bad = [
    'https://evil.example/api/retail/prices?$skip=1000',
    'http://prices.azure.com/api/retail/prices?$skip=1000',
    'https://prices.azure.com.evil.example/api/retail/prices?$skip=1000',
    'https://evilprices.azure.com/api/retail/prices?$skip=1000',
    'https://prices.azure.com:8443/api/retail/prices?$skip=1000',
    'https://evil.example@prices.azure.com/api/retail/prices?$skip=1000',
  ];
  for (const link of bad) {
    const api = makeApi(baseWorld(), {
      intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { json: { Items: [row(AO, 'usgovtexas', 'x')], NextPageLink: link } } : undefined),
    });
    const r = await run(api);
    assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, 'FAILED (NextPageLink points outside https://prices.azure.com)', link);
    assert.ok(!api.calls.some((c) => c.url === link), `${link} was requested`);
  }
  const api = makeApi(baseWorld(), {
    intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { json: { Items: [], NextPageLink: 'not a url' } } : undefined),
  });
  const r = await run(api);
  assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, 'FAILED (NextPageLink is not a URL)');
});

test('a response row that contradicts its own filter FAILS the chain', async () => {
  // Fixture: the Azure OpenAI / usgovtexas query answers 200 with a row for eastus (what an ignored or
  // mis-parsed $filter looks like), and the census answers with a row of another service.
  // BREAKS IF: the rows are counted for the region that was asked about.
  // KILLS: removing the armRegionName check; removing the serviceName check.
  const otherRegion = makeApi(baseWorld(), {
    intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { json: { Items: [row(AO, 'eastus', 'gpt-4o-0513-Inp-glbl')], NextPageLink: null } } : undefined),
  });
  const a = await run(otherRegion);
  assert.equal(tableRow(a.lines, AO, 'usgovtexas').rows, "FAILED (a response row has armRegionName 'eastus', expected 'usgovtexas')");
  assert.equal(a.exitCode, 2);

  const otherService = makeApi(baseWorld(), {
    intercept: (c) => (c.service === FM && c.region === undefined ? { json: { Items: [row('Virtual Machines', 'eastus', 'D2s')], NextPageLink: null } } : undefined),
  });
  const b = await run(otherService);
  assert.equal(tableRow(b.lines, FM, '(all regions) [census]').rows, "FAILED (a response row has serviceName 'Virtual Machines', expected 'Foundry Models')");
  assert.equal(b.exitCode, 2);
});

test('Global/DataZone meters are DISCOVERED from the census and count on the Commercial side', async () => {
  // Fixture: DataZoneUS exists only in the census (it is not one of the twelve queried regions) and carries the
  // family "gpt 4 1" that no other region has. BREAKS IF: discovered regions are ignored - the row would be
  // missing and "gpt 4 1" would not be in the absent list.
  // KILLS: a mutant that never classifies a census name as commercial-global.
  const r = await run(makeApi(baseWorld()));
  const t = tableRow(r.lines, AO, 'DataZoneUS [census]');
  assert.equal(t.family, 'Commercial (Global/DataZone)');
  assert.equal(t.rows, '2');
  assert.equal(t.meters, '2');
  assert.ok(absentList(r.lines, AO).items.includes('Azure OpenAI :: gpt 4 1'));
  assert.ok(r.lines.includes('  census: 4 armRegionName values, 10 rows; Global/DataZone-style: DataZoneUS (2); Government-style outside the queried 6: none'));
  assert.ok(r.lines.includes('  census: 2 armRegionName values, 3 rows; Global/DataZone-style: none; Government-style outside the queried 6: none'));

  // The other spellings: "Global" (the name the live API really serves) and "Data Zone EU" (with a space).
  // BREAKS IF: the pattern lacks `global`, or lacks the optional separator in data[ _-]?zone.
  // KILLS: /data[\s_-]?zone/ without `global`; /global|datazone/ without the separator class.
  const world = [
    ...baseWorld().filter((i) => i.serviceName === FM),
    ...rp(FM, 'Global', 'Azure OpenAI', ['Az-Babbage-002 Tokens']),
    ...rp(FM, 'Data Zone EU', 'Azure OpenAI', ['Az-Davinci-002 Tokens']),
  ];
  const g = await run(makeApi(world), ['--services', FM]);
  assert.equal(g.exitCode, 0);
  assert.equal(tableRow(g.lines, FM, 'Global [census]').family, 'Commercial (Global/DataZone)');
  assert.equal(tableRow(g.lines, FM, 'Global [census]').rows, '1');
  assert.equal(tableRow(g.lines, FM, 'Data Zone EU [census]').family, 'Commercial (Global/DataZone)');
  assert.deepEqual(absentList(g.lines, FM).items, [...ABSENT_FM, 'Azure OpenAI :: az babbage 002', 'Azure OpenAI :: az davinci 002']);
  assert.ok(g.lines.includes('  census: 4 armRegionName values, 5 rows; Global/DataZone-style: Data Zone EU (1), Global (1); Government-style outside the queried 6: none'));
});

test('Government-style regions the fixed list missed ("usgovwyoming", "US Gov") count as Government, so their families are not called absent', async () => {
  // Fixture: "usgovwyoming" carries Azure OpenAI Reasoning :: o1 and "US Gov" (a name the live API really serves, with
  // a space) carries Azure OpenAI :: gpt 4o mini; both would otherwise be absent.
  // BREAKS IF: census-only Government names are ignored, or the classifier misses the spaced "US Gov" - a false "absent".
  // KILLS: a mutant that never classifies a census name as government; one that drops the [\s_-]? from the pattern.
  const world = [
    ...baseWorld(),
    ...rp(AO, 'usgovwyoming', 'Azure OpenAI Reasoning', ['o1-1217-Inp-regnl']),
    ...rp(AO, 'US Gov', 'Azure OpenAI', ['gpt-4o-mini-0718-Inp-regnl']),
  ];
  const r = await run(makeApi(world));
  assert.equal(r.exitCode, 0);
  assert.equal(tableRow(r.lines, AO, 'usgovwyoming [census]').family, 'Government');
  assert.equal(tableRow(r.lines, AO, 'usgovwyoming [census]').rows, '1');
  assert.equal(tableRow(r.lines, AO, 'US Gov [census]').family, 'Government');
  assert.equal(tableRow(r.lines, AO, 'US Gov [census]').rows, '1');
  assert.deepEqual(absentList(r.lines, AO).items, ['Azure OpenAI :: gpt 4 1', 'Azure OpenAI Embedding :: text embedding 3 large']);
  assert.ok(r.lines.includes('  census: 6 armRegionName values, 12 rows; Global/DataZone-style: DataZoneUS (2); Government-style outside the queried 6: US Gov (1), usgovwyoming (1)'));
});

test('a census that cannot be read FAILS the run and blocks the absence list; the per-region counts stay', async () => {
  // BREAKS IF: a failed census is treated as "no extra regions" - Global/DataZone meters would silently be
  // missing from the Commercial side and the run would exit 0.
  // KILLS: a mutant that stops counting the census toward failedCount.
  const api = makeApi(baseWorld(), { intercept: (c) => (c.service === AO && c.region === undefined ? { status: 500, body: '' } : undefined) });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.equal(tableRow(r.lines, AO, '(all regions) [census]').rows, 'FAILED (HTTP 500 after 3 retries)');
  assert.match(absentList(r.lines, AO).header, /NOT COMPUTED/);
  assert.equal(tableRow(r.lines, AO, 'usgovvirginia').rows, '2');
  assert.equal(failedBy(r.lines, 'Azure OpenAI: 1 count(s) could not be fetched or verified').length, 1);
  assert.deepEqual(absentList(r.lines, FM).items, ABSENT_FM, 'the other service is unaffected');
});

test('a region query that disagrees with the census FAILS: a zero the census contradicts, and a short count', async () => {
  // Fixture A: the Azure OpenAI / usgovtexas query says "no rows" while the census holds 1 row for usgovtexas.
  // Fixture B: the eastus query returns 3 of the 4 rows the census counts.
  // BREAKS IF: the two reads are not compared - A would print "0 (measured)" for a region that has a row.
  // KILLS: a mutant that removes the cross-check.
  const world = [...baseWorld(), ...rp(AO, 'usgovtexas', 'Azure OpenAI', ['gpt-4o-0513-Inp-regnl'])];
  const a = await run(makeApi(world, {
    intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { json: { Items: [], NextPageLink: null } } : undefined),
  }));
  assert.equal(a.exitCode, 2);
  assert.equal(tableRow(a.lines, AO, 'usgovtexas').rows, 'FAILED (cross-check: the region query counted 0 rows / 0 meters, the all-region census 1 / 1)');
  assert.match(absentList(a.lines, AO).header, /NOT COMPUTED/);

  const b = await run(makeApi(baseWorld(), {
    intercept: (c) => (c.service === AO && c.region === 'eastus'
      ? { json: { Items: baseWorld().filter((i) => i.serviceName === AO && i.armRegionName === 'eastus').slice(0, 3), NextPageLink: null } }
      : undefined),
  }));
  assert.equal(b.exitCode, 2);
  assert.equal(tableRow(b.lines, AO, 'eastus').rows, 'FAILED (cross-check: the region query counted 3 rows / 3 meters, the all-region census 4 / 4)');

  // Fixture C: the row count agrees (4 = 4) but the query saw one meter twice: 4 rows / 3 distinct meters vs the census 4 / 4.
  // BREAKS IF: only the row count is compared. KILLS: a mutant that drops the distinct-meter comparison.
  const eastus = baseWorld().filter((i) => i.serviceName === AO && i.armRegionName === 'eastus');
  const c = await run(makeApi(baseWorld(), {
    intercept: (x) => (x.service === AO && x.region === 'eastus' ? { json: { Items: [...eastus.slice(0, 3), eastus[0]], NextPageLink: null } } : undefined),
  }));
  assert.equal(c.exitCode, 2);
  assert.equal(tableRow(c.lines, AO, 'eastus').rows, 'FAILED (cross-check: the region query counted 4 rows / 3 meters, the all-region census 4 / 4)');
});

test('a family is productName + model: the same bare model under another vendor does not cover it', async () => {
  // Fixture: Commercial has Azure Grok Models :: 4 3 ("4.3 Inp Glbl Tokens"); Government has the SAME meter name
  // under Azure Kimi. BREAKS IF: the family drops productName - "4 3" would then look covered in Government.
  // KILLS: a mutant whose familyOf returns the model alone.
  const world = [
    ...rp(FM, 'eastus', 'Azure Grok Models', ['4.3 Inp Glbl Tokens']),
    ...rp(FM, 'usgovvirginia', 'Azure Kimi', ['4.3 Inp Glbl Tokens']),
  ];
  const r = await run(makeApi(world), ['--services', FM]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(absentList(r.lines, FM).items, ['Azure Grok Models :: 4 3']);
  assert.deepEqual(productGroups(r.lines, FM), ['Azure Grok Models: 1 / 0', 'Azure Kimi: 0 / 1']);
});

test('product groups: distinct meters per productName, Commercial side vs Government side, no heuristic', async () => {
  // Fixture: the base world. Azure OpenAI has 5 distinct Commercial meters and 2 Government ones; Embedding and
  // Reasoning exist only in Commercial. BREAKS IF: the sides are swapped, a meter shared by two regions is counted
  // twice (eastus and eastus2 both carry gpt-4o-0513-Inp-glbl: 6 instead of 5), or a group is dropped.
  // KILLS: a mutant that adds meters per row instead of per distinct name; one that swaps the sides.
  const r = await run(makeApi(baseWorld()), ['--json', 'out.json']);
  assert.deepEqual(productGroups(r.lines, AO), ['Azure OpenAI: 5 / 2', 'Azure OpenAI Embedding: 1 / 0', 'Azure OpenAI Reasoning: 1 / 0']);
  assert.deepEqual(productGroups(r.lines, FM), ['Azure Llama Models: 1 / 0', 'Azure Mistral Models: 1 / 1']);
  const json = JSON.parse(r.files.get('out.json'));
  assert.deepEqual(json.summary.find((s) => s.service === AO).productGroups[0], { productName: 'Azure OpenAI', commercialMeters: 5, governmentMeters: 2 });
});

test('--services replaces the service list: only those names are queried and reported', async () => {
  // BREAKS IF: the flag is parsed but ignored (both services queried), applied to the report but not the queries,
  // or a duplicate / padded name is queried twice.
  // KILLS: a mutant that always passes SERVICES to measure(); one that skips the dedupe.
  const only = makeApi(baseWorld());
  const r = await run(only, ['--services', FM]);
  assert.equal(r.exitCode, 0);
  assert.equal(only.calls.length, 13, 'one service = 12 region chains + 1 census');
  assert.ok(only.calls.every((c) => c.service === FM));
  assert.equal(r.lines[0], 'Azure Retail Prices coverage - Foundry Models (api-version 2023-01-01-preview, one request chain per region, page cap 200)');
  assert.ok(!r.text.includes('== Azure OpenAI =='));
  assert.deepEqual(absentList(r.lines, FM).items, ABSENT_FM);

  const padded = makeApi(baseWorld());
  const p = await run(padded, ['--services', ' Azure OpenAI , Foundry Models,Azure OpenAI ']);
  assert.equal(p.exitCode, 0);
  assert.equal(padded.calls.length, 26, 'the duplicate name is not queried twice');
  assert.equal(p.lines[0], 'Azure Retail Prices coverage - Azure OpenAI / Foundry Models (api-version 2023-01-01-preview, one request chain per region, page cap 200)');
});

test('a row without a meterName is counted, not dropped, and its family falls back to the skuName', async () => {
  // Fixture: Azure OpenAI / usgovtexas has 3 rows: two with no meterName (null and "") and one named => 3 rows,
  // 2 distinct meters ("(unnamed)" counted once, and the named one). BREAKS IF: nameless rows are skipped (1 row),
  // each is counted as its own meter, or the placeholder replaces the missing name BEFORE the family is derived
  // (the family would read "unnamed" instead of "o1" from the skuName).
  // KILLS: a mutant that drops nameless rows; one that stores the placeholder in the detail.
  const world = [
    ...baseWorld(),
    row(AO, 'usgovtexas', null, { skuName: 'o1-1217-Inp-regnl' }),
    row(AO, 'usgovtexas', '', { skuName: 'o1-1217-Inp-regnl' }),
    row(AO, 'usgovtexas', 'gpt-4o-0513-Inp-regnl'),
  ];
  const r = await run(makeApi(world), ['--json', 'out.json']);
  assert.equal(r.exitCode, 0);
  const t = tableRow(r.lines, AO, 'usgovtexas');
  assert.equal(t.rows, '3');
  assert.equal(t.meters, '2');
  const json = JSON.parse(r.files.get('out.json'));
  const texas = json.rows.find((x) => x.service === AO && x.region === 'usgovtexas');
  assert.deepEqual(texas.meters.map((m) => m.meterName), ['gpt-4o-0513-Inp-regnl', null]);
  assert.deepEqual(texas.families, ['Azure OpenAI :: gpt 4o', 'Azure OpenAI :: o1']);
});

test('--json writes the full result: raw meter names, type counts, per-family coverage, null for failures', async () => {
  // BREAKS IF: the JSON loses the raw names the family heuristic must be re-checked against, the price-type
  // histogram, or the per-family region lists and meter counts (a family may be in one Government region of six).
  // KILLS: a mutant that drops the types tally; one that drops familyCoverage.
  const r = await run(makeApi(baseWorld()), ['--json', 'out.json', '--require-gov-coverage']);
  assert.equal(r.exitCode, 3);
  const json = JSON.parse(r.files.get('out.json'));
  assert.equal(json.generatedAt, '2026-10-29T12:00:00.000Z');
  assert.equal(json.apiVersion, '2023-01-01-preview');
  assert.equal(json.pageCap, 200);
  assert.equal(json.minRequestGapMs, 200);
  assert.deepEqual(json.serviceNames, [AO, FM]);
  assert.equal(json.requireGovCoverage, true);
  assert.equal(json.verdict, 'COVERAGE_GAP');
  assert.equal(json.exitCode, 3);
  assert.equal(json.requests, 26);
  assert.equal(json.tool, 'scripts/measure/apiplane/retail-prices-coverage.mjs');
  assert.equal(json.apiBase, 'https://prices.azure.com/api/retail/prices');
  assert.equal(json.maxRetries, 3);
  assert.deepEqual(json.problems, ['--require-gov-coverage: 5 model families present in Commercial have zero Government rows (Azure OpenAI: 4, Foundry Models: 1)']);
  // the region sets are the brief's, typed out: a typo in either list would silently measure a region that does not exist
  assert.deepEqual(json.governmentRegions, ['usgovvirginia', 'usgovarizona', 'usgovtexas', 'usgoviowa', 'usdodeast', 'usdodcentral']);
  assert.deepEqual(json.commercialRegions, ['eastus', 'eastus2', 'centralus', 'westus', 'westus3', 'swedencentral']);
  const eastus = json.rows.find((x) => x.service === AO && x.region === 'eastus');
  assert.equal(eastus.rows, 4);
  assert.deepEqual(eastus.typeCounts, { Consumption: 4 });
  assert.deepEqual(eastus.meters.map((m) => m.meterName), ['gpt-4o-0513-Inp-glbl', 'gpt-4o-0513-Outp-glbl', 'gpt-4o-mini-0718-Inp-regnl', 'o1-1217-Inp-regnl']);
  assert.deepEqual(eastus.families, ['Azure OpenAI :: gpt 4o', 'Azure OpenAI :: gpt 4o mini', 'Azure OpenAI Reasoning :: o1']);
  const summary = json.summary.find((s) => s.service === AO);
  assert.deepEqual(summary.absentInGovernment, ABSENT_AO);
  assert.deepEqual(summary.familyCoverage.find((f) => f.family === 'Azure OpenAI :: gpt 4o'), {
    family: 'Azure OpenAI :: gpt 4o',
    productName: 'Azure OpenAI',
    commercialRegions: ['eastus', 'eastus2'],
    governmentRegions: ['usgovvirginia'],
    commercialMeters: 2,
    governmentMeters: 2,
  });
  assert.deepEqual(summary.familyCoverage.find((f) => f.family === 'Azure OpenAI :: gpt 4o mini'), {
    family: 'Azure OpenAI :: gpt 4o mini',
    productName: 'Azure OpenAI',
    commercialRegions: ['eastus', 'DataZoneUS'],
    governmentRegions: [],
    commercialMeters: 2,
    governmentMeters: 0,
  });
  assert.deepEqual(summary.control, { passed: true, region: 'eastus', rows: 4 });
  const census = json.census.find((c) => c.service === AO);
  assert.equal(census.totalRows, 10);
  assert.equal(census.distinctMeters, 9);
  assert.deepEqual(census.regions.map((x) => [x.name, x.rows]), [['DataZoneUS', 2], ['eastus', 4], ['eastus2', 2], ['usgovvirginia', 2]]);
});

test('a --json file that cannot be written fails the run: the table says exit 2, not OK', async () => {
  // BREAKS IF: a write failure is swallowed (exit 0 with no artifact) or printed after an "OK (exit 0)" line.
  // KILLS: a mutant that ignores the writeFile error; one that renders the verdict before the write.
  const r = await run(makeApi(baseWorld()), ['--json', 'nowhere/out.json'], {
    writeFile: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }); },
  });
  assert.equal(r.exitCode, 2);
  assert.ok(r.lines.includes('RESULT: FAILED - could not write the --json file (ENOENT); the artifact does not exist (exit 2)'));
  assert.ok(!r.lines.includes('RESULT: OK (exit 0)'));
  assert.equal(tableRow(r.lines, AO, 'eastus').rows, '4', 'the measurement itself is still printed');
});

test('names that came off the wire are printable and bounded: a control character becomes "?", a long name is cut', async () => {
  // Fixture: a census-only region "usgov<ESC>[31m" + 100 x's (an ANSI escape from a hostile or broken response), a
  // 200-character productName, and so a 200+ character family.
  // BREAKS IF: clip() lets the escape through (a terminal could be driven by the response) or stops cutting
  // (region 60, product group 80, family 160 characters).
  // KILLS: a mutant whose clip() returns the string unchanged; one that drops the slice.
  const region = `usgov\u001b[31m${'x'.repeat(100)}`;
  const product = `P${'q'.repeat(199)}`;
  const world = [
    ...baseWorld().filter((i) => i.serviceName === FM),
    ...rp(FM, region, 'Azure Kimi', ['K2 Thinking Inp DZ Tokens']),
    ...rp(FM, 'eastus', product, ['Foo-Inp']),
  ];
  const r = await run(makeApi(world), ['--services', FM]);
  assert.equal(r.exitCode, 0);
  const t = tableRow(r.lines, FM, `usgov?[31m${'x'.repeat(50)} [census]`);
  assert.equal(t.family, 'Government');
  assert.ok(r.lines.includes(`  census: 3 armRegionName values, 5 rows; Global/DataZone-style: none; Government-style outside the queried 6: usgov?[31m${'x'.repeat(50)} (1)`));
  assert.ok(productGroups(r.lines, FM).includes(`P${'q'.repeat(79)}: 1 / 0`));
  assert.ok(absentList(r.lines, FM).items.includes(`P${'q'.repeat(159)}`));
  assert.ok(!r.text.includes('\u001b'), 'no escape character reaches the output');
});

test('a fetch that throws is reported by an identifier-only code: cause.code, else code, else name; junk stripped, 40 characters at most', async () => {
  // BREAKS IF: the reason echoes the error text or a code with markup, prefers e.name over the codes, or is unbounded.
  // KILLS: a mutant without the character filter; one that reverses the ?? chain; one without the length cut.
  const cases = [
    [Object.assign(new Error('boom <b>ERRTEXT-MARKER</b>'), { cause: { code: 'E<script>!!' } }), 'Escript'],
    [Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    [Object.assign(new Error('boom'), { code: 'ECODE', cause: { code: 'ECAUSE' } }), 'ECAUSE'],
    [new TypeError('fetch failed'), 'TypeError'],
    [Object.assign(new Error('boom'), { cause: { code: `E${'X'.repeat(100)}` } }), `E${'X'.repeat(39)}`],
    [Object.assign(new Error('boom'), { cause: { code: '!!!' }, name: 'TimeoutError' }), 'error'],
  ];
  for (const [thrown, shown] of cases) {
    const api = makeApi(baseWorld(), { intercept: (c) => (c.service === AO && c.region === 'usgovtexas' ? { throw: thrown } : undefined) });
    const r = await run(api);
    assert.equal(tableRow(r.lines, AO, 'usgovtexas').rows, `FAILED (network error (${shown}) after 3 retries)`);
    assert.ok(!r.text.includes('ERRTEXT-MARKER'), 'the error message text never reaches the output');
  }
});

test('a missing or empty productName is grouped as "(no productName)", and so is its family', async () => {
  // Fixture: two Foundry Models eastus rows, one with productName "" and one with no productName field at all.
  // BREAKS IF: an empty productName is kept as its own group named "" (a blank line in the table) while the family
  // says "(no productName)".
  // KILLS: a mutant that accepts "" as a productName.
  const world = [
    ...baseWorld().filter((i) => i.serviceName === FM),
    row(FM, 'eastus', 'Foo-Inp', { productName: '' }),
    row(FM, 'eastus', 'Bar-Inp', { productName: undefined }),
  ];
  const r = await run(makeApi(world), ['--services', FM]);
  assert.equal(r.exitCode, 0);
  assert.ok(productGroups(r.lines, FM).includes('(no productName): 2 / 0'));
  assert.deepEqual(absentList(r.lines, FM).items, ['(no productName) :: bar', '(no productName) :: foo', ...ABSENT_FM]);
});

test('a blind service whose census also FAILED says so, and is counted as a failure too', async () => {
  // Fixture: Foundry Models has no rows (blind) and its all-region census answers 500.
  // BREAKS IF: the hint claims the census was empty when it was never read.
  // KILLS: a mutant whose blindHint ignores the census status.
  const world = baseWorld().filter((i) => i.serviceName === AO);
  const api = makeApi(world, { intercept: (c) => (c.service === FM && c.region === undefined ? { status: 500, body: '' } : undefined) });
  const r = await run(api);
  assert.equal(r.exitCode, 2);
  assert.ok(r.lines.includes('RESULT: FAILED - Foundry Models: 1 count(s) could not be fetched or verified (see FAILED above) (exit 2)'));
  assert.ok(r.lines.includes('RESULT: FAILED - Foundry Models: INSTRUMENT BLIND - all 6 Commercial region queries returned 0 rows and the all-region census FAILED, so nothing else is known about this serviceName; a Government zero would be indistinguishable from a wrong filter (Learn: filter values are case sensitive) (exit 2)'));
});

test('the billing vocabulary is pinned word by word: each cuts the model, each unit word is dropped in the fallback, identity words never cut', () => {
  // The word lists are typed out here on purpose: they ARE the specification of what a billing word is. BREAKS IF a word is
  // removed from the script's vocabulary (the model keeps it), or an identity word ("mini", "pro", "luna" ...) is added to it
  // (the model loses it). KILLS: a mutant that deletes one entry from BILLING / UNIT_WORDS or adds an identity word.
  const cutWords = [
    'inp', 'inpt', 'input', 'in', 'opt', 'outp', 'outpt', 'out', 'output', 'cd', 'cchd', 'cached', 'cache', 'wr', 'prompt', 'completion',
    'dz', 'dzone', 'dzn', 'datazone', 'gl', 'glbl', 'global', 'regnl', 'rgnl', 'regional',
    'longco', 'shortco', 'loco', 'shco', 'std', 'standard', 'flex', 'batch', 'pp',
    'ft', 'sft', 'rft', 'finetuned', 'hosting', 'hstng', 'training', 'trng', 'deployment',
  ];
  const unitWords = ['tokens', 'token', '1m', '1k', 'unit', 'units', 'pages', 'images', 'hour', 'hours', 'gb', 'megapixel'];
  for (const w of [...cutWords, ...unitWords]) assert.equal(normaliseModelName(`zeta ${w} tail`), 'zeta', `"${w}" must end the model name`);
  for (const w of unitWords) assert.equal(normaliseModelName(`${w} zeta`), 'zeta', `"${w}" must be dropped when the name starts with it`);
  assert.equal(normaliseModelName('inp zeta'), 'inp zeta', 'a non-unit billing word at the start is kept by the fallback');
  const identityWords = [
    'mini', 'nano', 'turbo', 'pro', 'flash', 'instruct', 'chat', 'codex', 'realtime', 'audio', 'transcribe', 'thinking',
    'large', 'small', 'medium', 'vision', 'preview', 'embed', 'text', 'image', 'luna', 'sol', 'terra',
  ];
  for (const w of identityWords) assert.equal(normaliseModelName(`zeta ${w} tail`), `zeta ${w} tail`, `"${w}" is part of a model name`);
});

test('normaliseModelName: real meter names from the live API, billing words stripped and model identity kept', () => {
  // Literal pairs; the first group are real names read from prices.azure.com on 2026-10-29. BREAKS IF: any rule is
  // dropped (the key keeps a billing word or a date) or over-reaches (the key loses a model word: "mini", the "1"
  // of 4.1, the 32k window, the "luna").
  const cases = [
    ['5.6 luna LongCo Cd Inp Std DZ 1M Tokens', '5 6 luna'],
    ['4.1 mini ft cd inp Dz Tokens', '4 1 mini'],
    ['4.3 Cached Inp DZ L Tokens', '4 3'],
    ['Llama 3.3 70B Inp glbl Tokens', 'llama 3 3 70b'],
    ['Phi-3-Medium-128K-Instruct-Input-Finetuned Tokens', 'phi 3 medium 128k instruct'],
    ['Az-Babbage-002-Fine Tuned-Input Tokens', 'az babbage 002'],
    ['FW DS V4.1 Flash Cd Inp - US DZ 1M Tokens', 'fw ds v4 1 flash'],
    ['Doc AI 2512 Dzone Pages', 'doc ai'],
    ['GPT-OSS-20b-IN-FT Tokens', 'gpt oss 20b'],
    ['Provisioned Managed Data Zone Unit', 'provisioned managed'],
    ['Mngd A100_80GB Gl', 'mngd a100 80gb'],
    ['Assistants-File Search-regnl GB', 'assistants file search'],
    // the name starts with a billing word: keep every token that is not a pure unit word
    ['Flex DZone Megapixel', 'flex dzone'],
    ['Standard Input Tokens', 'standard input'],
    // dates, units, context windows
    ['gpt-4o-mini-0718-Outp-regnl', 'gpt 4o mini'],
    ['gpt-4.1-2025-04-14-Input-Data Zone', 'gpt 4 1'],
    ['gpt-35-turbo-16k-0613-Inp', 'gpt 35 turbo 16k'],
    ['gpt-4-32K Tokens', 'gpt 4 32k'],
    ['DALL-E 3 100 Images', 'dall e 3'],
    ['Whisper 1 Hour', 'whisper'],
    ['Mistral-Large-2411 Input', 'mistral large'],
    ['o3-mini-2025-01-31 Output', 'o3 mini'],
    ['gpt-4o Pay-as-you-go Batch', 'gpt 4o'],
    ['', ''],
    [null, ''],
    [42, ''],
  ];
  for (const [input, expected] of cases) assert.equal(normaliseModelName(input), expected, `normaliseModelName(${JSON.stringify(input)})`);
  // the same model spelt two ways in the catalog merges where the spelling agrees ...
  assert.equal(normaliseModelName('Az-Babbage-002 Tokens'), normaliseModelName('Az-Babbage-002-Fine Tuned-Output Tokens'));
  assert.equal(normaliseModelName('FW DS V4.1 Flash Cd Inp - US DZ 1M Tokens'), normaliseModelName('FW DS-V4.1-Flash Gl Cd Inp Tokens'));
  assert.equal(normaliseModelName('Doc AI 2512 Dzone Pages'), normaliseModelName('Doc AI glbl 2505 Pages'));
  // ... and is two families where it does not (documented limit of a heuristic over free text)
  assert.notEqual(normaliseModelName('Llama 3.3 70B Inp glbl Tokens'), normaliseModelName('Llama3.3 70b-IN-FT Tokens'));
  // four different models stay four different keys
  assert.deepEqual(
    ['gpt-4o-0513-Inp', 'gpt-4o-mini-0718-Inp', 'gpt-4-0613-Inp', 'gpt-4.1-2025-04-14-Inp'].map(normaliseModelName),
    ['gpt 4o', 'gpt 4o mini', 'gpt 4', 'gpt 4 1'],
  );
});

test('familyOf is "<productName> :: <model>" and falls back meterName -> skuName -> (unnamed model)', () => {
  // BREAKS IF: the productName is left out, a missing productName is not named, or an unusable meterName does not
  // fall through to the skuName.
  assert.equal(familyOf({ productName: 'Azure OpenAI GPT5', meterName: '5.6 luna LongCo Inp Std DZ 1M Tokens', skuName: 'x' }), 'Azure OpenAI GPT5 :: 5 6 luna');
  assert.equal(familyOf({ productName: 'Foundry Models', meterName: '', skuName: 'Mistral-Large-2411 Inp' }), 'Foundry Models :: mistral large');
  assert.equal(familyOf({ productName: 'Foundry Models', meterName: null, skuName: null }), 'Foundry Models :: (unnamed model)');
  assert.equal(familyOf({ meterName: 'gpt-4o-0513-Inp-glbl' }), '(no productName) :: gpt 4o');
  assert.equal(familyOf({ productName: '', meterName: 'gpt-4o-0513-Inp-glbl' }), '(no productName) :: gpt 4o');
});

test('parseArgs and main: bad flags exit 1 before any request is made', async () => {
  // BREAKS IF: arguments are validated after the measurement (a minute of requests for a typo), or accepted.
  assert.deepEqual(parseArgs(['--json', 'x.json', '--require-gov-coverage']).opts, { json: 'x.json', requireGovCoverage: true, services: null, help: false });
  assert.deepEqual(parseArgs([]).opts, { json: null, requireGovCoverage: false, services: null, help: false });
  assert.deepEqual(parseArgs(['--services', 'a b,c']).opts.services, ['a b', 'c']);
  assert.equal(parseArgs(['--json']).error, '--json needs a file path');
  assert.equal(parseArgs(['--json', '--require-gov-coverage']).error, '--json needs a file path');
  assert.equal(parseArgs(['--services']).error, '--services needs a comma-separated list of serviceName values');
  assert.equal(parseArgs(['--services', ' , ']).error, '--services needs a comma-separated list of serviceName values');
  assert.equal(parseArgs(['--services', "a'b"]).error, "--services: a serviceName must be printable ASCII without quotes or backslashes: a'b");
  assert.match(parseArgs(['--services', 'café']).error, /printable ASCII/);
  assert.equal(parseArgs(['--nope']).error, 'unknown argument: --nope');
  assert.equal(parseArgs(['-h']).opts.help, true);
  assert.equal(parseArgs(['--help']).opts.help, true);
  const api = makeApi(baseWorld());
  const r = await run(api, ['--nope']);
  assert.equal(r.exitCode, 1);
  assert.equal(api.calls.length, 0);
  assert.equal(r.errs[0], 'retail-prices-coverage: unknown argument: --nope');
  assert.match(r.errs[1], /^Usage: node scripts\/measure\/apiplane\/retail-prices-coverage\.mjs/, 'a usage error prints the usage');
  const help = await run(api, ['--help']);
  assert.equal(help.exitCode, 0);
  assert.equal(api.calls.length, 0);
  assert.match(help.lines[0], /^Usage: node scripts\/measure\/apiplane\/retail-prices-coverage\.mjs/);
});

test('the real CLI exits with the code main() returns (spawned; network-free arguments only)', () => {
  // BREAKS IF: the entry guard never matches (the script silently does nothing, exit 0) or process.exitCode is
  // not set from main()'s result. Only --bogus and --help are spawned: neither makes a request.
  // KILLS: a mutant that drops `process.exitCode = exitCode`; one that breaks the entry-point regex.
  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /retail-prices-coverage: unknown argument: --bogus/);
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node scripts\/measure\/apiplane\/retail-prices-coverage\.mjs/);
});
