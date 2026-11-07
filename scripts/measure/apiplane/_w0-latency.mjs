/**
 * _w0-latency.mjs - family `latency` (PRP item W0-6).
 *
 * Question: how many seconds after a named value is written does the gateway
 * serve the new value? Measured at the gateway, with a scratch API whose policy
 * return-responds `{{w0-apiplane-latency}}`:
 *   1. write the named value (value A), create the scratch API + operation +
 *      policy, poll the gateway until it answers A;
 *   2. UPDATE the named value to B, poll until it answers B;
 *   3. delete the API, then the named value, and prove 404 on both.
 *
 * THE CONTROL IS A. If A is never seen the scratch API is broken (a policy that
 * does not substitute the named value, a route that 404s), and "B was not
 * observed" would be a lie about named values. So A not seen within the cap is
 * the instrument being INVALID (exit 2), B is not attempted, and nothing is
 * published as a latency.
 *
 * WHAT THE TWO NUMBERS MEAN. B is the clean one: the API and policy are already
 * live (A proved it), so B is pure named-value propagation. A is the control and
 * a rougher figure: its clock starts when the LAST of the writes needed for A to
 * be visible (the policy) completes, so it also contains the API's and the
 * policy's own propagation. Both are quoted, with what started each clock.
 *
 * NEVER PRINT A NUMBER THAT WAS NOT OBSERVED. A value never seen within the cap
 * (`--latency-poll-seconds`, default 900) is `measured: not observed within <N> s`
 * - the cap, not an elapsed time. Time comes from the injected clock; the poll
 * interval is 1 s; a poll never retries inside its own interval.
 *
 * DATA PLANE: the polls go through the gateway. If the gateway is unreachable
 * from this runner (the Gov gateway is VNet-internal and the Gov runner is
 * GitHub-hosted) the family is `not-measured:gateway-unreachable-from-runner`,
 * exit 0 - and creates nothing. The cleanup sweep still runs.
 *
 * GROUNDING (Learn, fetched 2026-10-29)
 *   `{{name}}` references the named value's DISPLAY name, and a named value cannot be
 *   deleted while a policy references it (so the API goes first):
 *     https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties
 *   return-response / set-status / set-header / set-body shapes:
 *     https://learn.microsoft.com/en-us/azure/api-management/return-response-policy
 *     https://learn.microsoft.com/en-us/azure/api-management/set-body-policy
 *   Named value PUT (displayName pattern ^[A-Za-z0-9-._]+$; PUT answers InProgress), operation PUT, API PUT:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/named-value/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api-operation/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/create-or-update
 */
import {
  deleteScratch, getApi, getNamedValue, measured, notMeasured, probeGateway, putApi, putApiPolicy,
  putNamedValue, putOperation, quote, reasonForFailure, sanitize, unknown, waitProvisioned, withScratch,
} from './_w0-core.mjs';

const F = 'latency';
const id = (s) => `${F}.${s}`;

export const CELL_IDS = Object.freeze(['valueA', 'valueB', 'delete.proof', 'cleanup'].map(id));

const NV_ID = 'w0-apiplane-latency';
const API_ID = 'w0-apiplane-lat-api';
const API_PATH = 'w0-apiplane-lat';
const OP_ID = 'w0-apiplane-lat-op';
const OP_URL = '/value';
const ROLE = 'API Management Service Contributor';
export const POLL_INTERVAL_MS = 1000;

/** SYNTHETIC (from the Learn return-response / set-body / named-value pages), not observed. */
export const LATENCY_POLICY = '<policies><inbound><base /><return-response><set-status code="200" reason="OK" />'
  + '<set-header name="Content-Type" exists-action="override"><value>text/plain</value></set-header>'
  + `<set-body>{{${NV_ID}}}</set-body></return-response></inbound>`
  + '<backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>';

const seconds = (ms) => Number((ms / 1000).toFixed(1));

/**
 * Poll the gateway until it answers `expected`. Time is read from the injected
 * clock only. Returns { observed, seconds?, obs }.
 */
export async function pollForValue(ctx, url, expected, startedAt, capMs) {
  const obs = { polls: 0, matched: 0, otherBodies: 0, notOk: 0, statuses: {}, sampleOtherBody: null };
  for (;;) {
    const r = await ctx.client.request({ service: 'gateway', url, timeoutMs: 10000, log: false, retry: false });
    obs.polls += 1;
    const key = String(r.status ?? `network:${r.networkErrorClass}`);
    obs.statuses[key] = (obs.statuses[key] ?? 0) + 1;
    if (r.status === 200 && String(r.text).trim() === expected) {
      obs.matched += 1;
      return { observed: true, seconds: seconds(ctx.clock.now() - startedAt), obs };
    }
    if (r.status === 200) {
      obs.otherBodies += 1;
      if (obs.sampleOtherBody === null) obs.sampleOtherBody = sanitize(String(r.text).trim(), 80);
    } else {
      obs.notOk += 1;
    }
    if (ctx.clock.now() - startedAt >= capMs) return { observed: false, obs };
    await ctx.sleep(POLL_INTERVAL_MS);
  }
}

/** HTTP statuses a poll actually saw (never a made-up one); undefined when it only saw network failures. */
function statusesSeen(obs) {
  const seen = Object.keys(obs.statuses).filter((k) => /^\d+$/.test(k)).map(Number).sort((x, y) => x - y);
  return seen.length ? seen : undefined;
}

/** A management-plane write that could not be made blocks the family: required, never silent. */
function blocked(cellId, res, note) {
  return unknown(cellId, reasonForFailure(res, { role: ROLE, scope: 'apim' }) ?? 'tooling-error', { evidence: { note, ...quote(res) } });
}

/**
 * @param {object} ctx
 * @param {{cells:Array, controls:Array}} acc
 */
export async function run(ctx, acc) {
  const { cells, controls } = acc;
  const capSeconds = ctx.options.latencyPollSeconds;
  const capMs = capSeconds * 1000;
  const gw = await probeGateway(ctx);

  await withScratch(ctx, F, acc, async () => {
    if (!gw.reachable) {
      for (const n of ['valueA', 'valueB', 'delete.proof']) {
        cells.push(notMeasured(id(n), 'gateway-unreachable-from-runner', {
          required: false, dataPlane: true, evidence: { errorClass: gw.errorClass, runner: ctx.runner },
        }));
      }
      return;
    }

    const A = `A-${ctx.idGen()}`;
    const B = `B-${ctx.idGen()}`;
    const pollUrl = `${ctx.apim.gatewayUrl.replace(/\/+$/, '')}/${API_PATH}${OP_URL}`;
    const stopWith = (res, note) => {
      for (const n of ['valueA', 'valueB']) cells.push(blocked(id(n), res, note));
    };

    // ---- 1. named value A, then the scratch API that returns it ----
    const nv = await putNamedValue(ctx, NV_ID, A);
    if (!nv.ok) { stopWith(nv, 'the scratch named value PUT failed'); return; }
    const nvReady = await waitProvisioned(ctx, () => getNamedValue(ctx, NV_ID));
    if (nvReady.state !== 'Succeeded') { stopWith(nvReady.last, `the named value never reached Succeeded (${nvReady.state})`); return; }

    const api = await putApi(ctx, API_ID, { displayName: API_ID, path: API_PATH, protocols: ['https'], subscriptionRequired: false });
    if (!api.ok) { stopWith(api, 'the scratch API PUT failed'); return; }
    const op = await putOperation(ctx, API_ID, OP_ID, { displayName: 'w0-apiplane value', method: 'GET', urlTemplate: OP_URL });
    if (!op.ok) { stopWith(op, 'the scratch operation PUT failed'); return; }
    const pol = await putApiPolicy(ctx, API_ID, LATENCY_POLICY);
    if (!pol.ok) { stopWith(pol, 'the scratch API policy PUT failed (the policy is part of the instrument)'); return; }
    await waitProvisioned(ctx, () => getApi(ctx, API_ID));

    // ---- 2. CONTROL + value A ----
    const startA = ctx.clock.now();
    const a = await pollForValue(ctx, pollUrl, A, startA, capMs);
    controls.push({
      id: 'value-A-observed-at-the-gateway',
      status: a.observed ? 'passed' : 'failed',
      detail: a.observed
        ? 'the gateway answered the first value, so the scratch API works'
        : `the gateway never answered the first value within ${capSeconds} s: the scratch API is broken, so a B measurement would mean nothing`,
    });
    if (!a.observed) {
      cells.push(measured(id('valueA'), `not observed within ${capSeconds} s`, {
        http: statusesSeen(a.obs), source: 'gateway-poll',
        dataPlane: true, required: false,
        evidence: { polls: a.obs, clockStartedAt: 'the API policy PUT was accepted', publishable: false },
      }));
      cells.push(unknown(id('valueB'), 'tooling-error', { required: false, dataPlane: true, evidence: { note: 'not attempted: the control (value A) failed' } }));
      return;
    }
    cells.push(measured(id('valueA'), `${a.seconds} s`, {
      http: 200, dataPlane: true, required: false,
      evidence: { polls: a.obs, clockStartedAt: 'the API policy PUT was accepted (so this also includes the API and policy propagation)', observedValue: 'A' },
    }));

    // ---- 3. value B: pure named-value propagation ----
    const upd = await putNamedValue(ctx, NV_ID, B, { update: true });
    const putReturnedAt = ctx.clock.now();
    if (!upd.ok) { cells.push(blocked(id('valueB'), upd, 'the named value UPDATE failed')); return; }
    const updReady = await waitProvisioned(ctx, () => getNamedValue(ctx, NV_ID));
    if (updReady.state !== 'Succeeded') { cells.push(blocked(id('valueB'), updReady.last, `the updated named value never reached Succeeded (${updReady.state})`)); return; }
    const startB = ctx.clock.now();
    const b = await pollForValue(ctx, pollUrl, B, startB, capMs);
    if (b.observed) {
      cells.push(measured(id('valueB'), `${b.seconds} s`, {
        http: 200, dataPlane: true, required: false,
        evidence: {
          polls: b.obs,
          clockStartedAt: 'the named value update reached provisioningState Succeeded',
          secondsFromPutReturned: seconds(startB - putReturnedAt + b.seconds * 1000),
          observedValue: 'B',
        },
      }));
    } else {
      cells.push(measured(id('valueB'), `not observed within ${capSeconds} s`, {
        http: statusesSeen(b.obs), source: 'gateway-poll', dataPlane: true, required: false,
        evidence: { polls: b.obs, clockStartedAt: 'the named value update reached provisioningState Succeeded', note: 'the cap, not an elapsed time: no latency is quoted' },
      }));
    }

    // ---- 4. delete (API first: a referenced named value cannot be deleted) and prove 404 ----
    const delApi = await deleteScratch(ctx, 'api', API_ID);
    const delNv = await deleteScratch(ctx, 'namedValue', NV_ID);
    const goneApi = await getApi(ctx, API_ID);
    const goneNv = await getNamedValue(ctx, NV_ID);
    if (goneApi.status === 404 && goneNv.status === 404) {
      cells.push(measured(id('delete.proof'), 'both scratch objects deleted (GET: 404 / 404)', { http: [goneApi.status, goneNv.status] }));
    } else if (goneApi.status === 200 || goneNv.status === 200) {
      cells.push(measured(id('delete.proof'), 'NOT deleted: a GET after DELETE still answers 200', {
        http: [goneApi.status, goneNv.status].filter(Number.isInteger),
        evidence: { deleteApi: quote(delApi), deleteNamedValue: quote(delNv) },
      }));
    } else {
      cells.push(unknown(id('delete.proof'), reasonForFailure(goneApi, { role: ROLE, scope: 'apim' }) ?? reasonForFailure(goneNv, { role: ROLE, scope: 'apim' }) ?? 'tooling-error', {
        evidence: { getApi: quote(goneApi), getNamedValue: quote(goneNv) },
      }));
    }
  });
}
