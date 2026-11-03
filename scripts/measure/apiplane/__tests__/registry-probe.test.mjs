/**
 * Offline tests for scripts/measure/apiplane/registry-probe.mjs.
 *
 *   node --test "scripts/measure/apiplane/**\/*.test.mjs"
 *
 * assertion-design.md: each test says the input that breaks it ("BREAKS IF").
 * Nothing here touches az, ARM or a console: ARM is a scripted double, Loom is a
 * fetch double. What this proves is the COMPARE and REFUSE logic only; the live
 * path (real az rest, real console) has not been run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  APIM_API_VERSION, armApiCount, armListCount, compareApiCounts, gatewayIdFor, loomGateway, parseArgs, serviceNameOf,
} from '../registry-probe.mjs';

const RID = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-x/providers/Microsoft.ApiManagement/service/apim-x';
const ARM = 'https://management.azure.com';
const CTX = { gatewayName: 'apim-x', gatewayId: 'gw-91e496b0137c6ed5', lastSyncAt: '2026-10-30T12:00:00.000Z' };

test('MISMATCH by exactly one fails and the message carries BOTH numbers and what each counts', () => {
  // BREAKS IF: compare uses <= / a tolerance (7 vs 6 would pass), or the message drops either number.
  const r = compareApiCounts({ arm: 7, loom: 6, ...CTX });
  assert.equal(r.ok, false);
  assert.match(r.message, /ARM lists 7 APIs/);
  assert.match(r.message, /Loom inventory\.apis = 6/);
  assert.match(r.message, /Difference 1\./);
  assert.match(r.message, /api-version 2024-06-01-preview/);
});

test('the swap direction (loom higher by one) also fails, naming 6 and 7 on the right sides', () => {
  // BREAKS IF: the message labels are swapped, or only arm > loom is detected.
  const r = compareApiCounts({ arm: 6, loom: 7, ...CTX });
  assert.equal(r.ok, false);
  assert.match(r.message, /ARM lists 6 APIs/);
  assert.match(r.message, /Loom inventory\.apis = 7/);
});

test('EQUAL counts pass (positive pair of the mismatch case)', () => {
  // BREAKS IF: the comparison is inverted or always fails.
  const r = compareApiCounts({ arm: 7, loom: 7, ...CTX });
  assert.equal(r.ok, true);
  assert.match(r.message, /^MATCH: ARM lists 7 APIs.*Loom inventory\.apis = 7/);
});

test('a non-integer or UNKNOWN count is refused, never compared as 0', () => {
  // BREAKS IF: undefined/NaN/null coerces to 0 and "matches" a real 0.
  for (const bad of [undefined, null, NaN, -1, 1.5, '7']) {
    assert.throws(() => compareApiCounts({ arm: bad, loom: 0, ...CTX }), /refusing to compare/);
    assert.throws(() => compareApiCounts({ arm: 0, loom: bad, ...CTX }), /refusing to compare/);
  }
});

// ---- ARM side -------------------------------------------------------------

/** Scripted az: map url-substring -> pages. Throws on an unscripted url (a failed command throws). */
function scriptedAz(script) {
  const calls = [];
  const fn = (args) => {
    const url = args[args.indexOf('--url') + 1];
    calls.push(url);
    for (const [needle, pages] of Object.entries(script)) {
      if (url.includes(needle)) return pages.shift();
    }
    throw new Error(`unscripted url ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('ARM count follows nextLink to the end (3 + 2 = 5), not just page one', () => {
  // BREAKS IF: paging stops after the first page (would report 3).
  const runAz = scriptedAz({
    // page 2's url also contains '/apis?', so its (more specific) needle must come first
    'skiptoken': [{ value: [4, 5] }],
    '/apis?': [{ value: [1, 2, 3], nextLink: `${ARM}${RID}/apis?api-version=${APIM_API_VERSION}&$skiptoken=x` }],
  });
  assert.equal(armApiCount(RID, ARM, runAz), 5);
  assert.equal(runAz.calls.length, 2);
});

test('an ARM zero is REFUSED when the positive control is also empty', () => {
  // BREAKS IF: a 0 is reported without proving the query path works.
  const runAz = scriptedAz({ '/apis?': [{ value: [] }], '/subscriptions?': [{ value: [] }] });
  assert.throws(() => armApiCount(RID, ARM, runAz), /positive control .* empty/);
});

test('an ARM zero is accepted when the service subscription list proves the path (control > 0)', () => {
  // BREAKS IF: a genuine empty gateway can never be probed (control wrongly required on non-zero too).
  const runAz = scriptedAz({ '/apis?': [{ value: [] }], '/subscriptions?': [{ value: [{ n: 'master' }] }] });
  assert.equal(armApiCount(RID, ARM, runAz), 0);
});

test('a non-zero ARM count does not spend the control call', () => {
  const runAz = scriptedAz({ '/apis?': [{ value: [1] }] });
  assert.equal(armApiCount(RID, ARM, runAz), 1);
  assert.equal(runAz.calls.length, 1);
});

test('a page with no value array is UNKNOWN (throws), not zero', () => {
  // BREAKS IF: a missing value defaults to [] and yields 0.
  const runAz = scriptedAz({ '/apis?': [{ error: 'x' }] });
  assert.throws(() => armApiCount(RID, ARM, runAz), /UNKNOWN, not 0/);
});

test('a nextLink pointing off the ARM host is not followed', () => {
  // BREAKS IF: the probe follows an arbitrary URL while holding the operator's az identity.
  const runAz = scriptedAz({ '/apis?': [{ value: [1], nextLink: 'https://evil.example/apis' }] });
  assert.throws(() => armListCount(`${ARM}${RID}/apis?api-version=${APIM_API_VERSION}`, ARM, runAz), /left the ARM host/);
});

// ---- Loom side ------------------------------------------------------------

const SECRET = 'COOKIE-VALUE-SHOULD-NEVER-APPEAR';
function fetchDouble(status, body) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    return { status, json: async () => body };
  };
  fn.seen = seen;
  return fn;
}
const gw = (over = {}) => ({
  id: gatewayIdFor(RID),
  inventory: { apis: 4, lastSyncAt: CTX.lastSyncAt, partialTypes: [], ...over },
});

test('gatewayIdFor matches a literal computed outside this repo, and lowercases the id', () => {
  // BREAKS IF: the hash input, case folding or 16-char slice differs from gateway-service.ts.
  assert.equal(gatewayIdFor(RID), 'gw-91e496b0137c6ed5');
  assert.equal(gatewayIdFor(RID.toUpperCase()), 'gw-91e496b0137c6ed5');
  // Lift the derivation out of the product source so a drift there fails here.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '../../../../apps/fiab-console/lib/api-gateway/registry/gateway-service.ts'), 'utf8');
  assert.match(src, /`gw-\$\{createHash\('sha256'\)\.update\(resourceId\.toLowerCase\(\)\)\.digest\('hex'\)\.slice\(0, 16\)\}`/);
});

test('reads inventory.apis for the matching gateway and sends the cookie only as a header', async () => {
  const f = fetchDouble(200, { ok: true, data: { gateways: [{ id: 'gw-other', inventory: {} }, gw()] } });
  const r = await loomGateway('https://c.example', RID, SECRET, f);
  assert.equal(r.apis, 4);
  assert.equal(f.seen[0].init.headers.cookie, `loom_session=${SECRET}`);
  assert.equal(f.seen[0].url.includes(SECRET), false);
});

test('errors never contain the cookie value', async () => {
  // BREAKS IF: an error path interpolates the header/cookie into its message.
  for (const [status, body] of [[401, {}], [200, { data: { gateways: [] } }], [302, {}], [200, { data: { gateways: [gw({ lastSyncAt: undefined })] } }]]) {
    await assert.rejects(
      () => loomGateway('https://c.example', RID, SECRET, fetchDouble(status, body)),
      (e) => { assert.equal(String(e.message).includes(SECRET), false); return true; },
    );
  }
});

test('never-synced and partial-api records are refused, not read as 0 or as a total', async () => {
  // BREAKS IF: dashes (never synced) are read as zero APIs, or a partial list is compared as a total.
  await assert.rejects(() => loomGateway('https://c.example', RID, SECRET, fetchDouble(200, { data: { gateways: [gw({ lastSyncAt: undefined, apis: 0 })] } })), /never synced/);
  await assert.rejects(() => loomGateway('https://c.example', RID, SECRET, fetchDouble(200, { data: { gateways: [gw({ partialTypes: ['api'] })] } })), /partially/);
});

test('unregistered gateway and missing cookie are refused', async () => {
  await assert.rejects(() => loomGateway('https://c.example', RID, SECRET, fetchDouble(200, { data: { gateways: [] } })), /not registered/);
  await assert.rejects(() => loomGateway('https://c.example', RID, '', fetchDouble(200, {})), /LOOM_SESSION_COOKIE is not set/);
});

// ---- arguments ------------------------------------------------------------

test('parseArgs requires https (localhost excepted), a known ARM host and an APIM service id', () => {
  assert.equal(parseArgs(['--resource-id', RID, '--base-url', 'https://c.example/x']).baseUrl, 'https://c.example');
  assert.throws(() => parseArgs(['--resource-id', RID, '--base-url', 'http://c.example']), /https/);
  assert.doesNotThrow(() => parseArgs(['--resource-id', RID, '--base-url', 'http://localhost:3000']));
  assert.throws(() => parseArgs(['--resource-id', RID, '--base-url', 'https://c.example', '--arm-endpoint', 'https://evil.example']), /arm-endpoint/);
  assert.throws(() => parseArgs(['--resource-id', `${RID}/apis/x`, '--base-url', 'https://c.example']), /API Management service id/);
  assert.throws(() => parseArgs(['--base-url', 'https://c.example']), /--resource-id is required/);
  assert.equal(serviceNameOf(RID), 'apim-x');
});
