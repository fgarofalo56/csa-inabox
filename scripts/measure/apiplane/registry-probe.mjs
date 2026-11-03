#!/usr/bin/env node
/**
 * registry-probe.mjs - the measurement behind the W1 live receipts of the Loom API
 * Gateway Plane (PRPs/active/loom-api-gateway-plane/apigw-W01-gateway-registry-observe.md,
 * row W1-7: "inventory counts match `az`").
 *
 * WHAT IT COMPARES, AND WHAT EACH NUMBER COUNTS
 *   ARM   the number of entries returned by GET <gateway resource id>/apis
 *         (api-version 2024-06-01-preview, the version the console uses), followed
 *         through every nextLink. Counted with `az rest`, as the operator's identity.
 *   Loom  `inventory.apis` on the gateway record returned by
 *         GET <base-url>/api/admin/api-gateway/gateways - the count the last
 *         inventory sync stored.
 * They are the same quantity read two ways. A sync run BEFORE an API was added or
 * removed makes them differ legitimately: re-sync first, then probe.
 *
 *   node scripts/measure/apiplane/registry-probe.mjs \
 *        --resource-id /subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name> \
 *        --base-url https://<console-host> [--arm-endpoint https://management.usgovcloudapi.net]
 *
 * CREDENTIALS - environment and the az login only, never arguments, never printed:
 *   LOOM_SESSION_COOKIE   the value of the `loom_session` cookie for an admin session
 *                         (apiplane-admin or tenant admin). Mint it the way
 *                         scripts/csa-loom/e2e-receipt.mjs does, or copy it from a
 *                         signed-in browser. It is sent as a Cookie header and is never
 *                         written to stdout, stderr or any error message.
 *   (ARM)                 `az login` in the current environment. No token is read here.
 *
 * EXIT CODES
 *   0  counts equal, and every refusal rule below passed
 *   1  counts differ (the message names both numbers and what each counts)
 *   2  the instrument is invalid or the input is unusable: a query failed, a
 *      zero could not be proven real, the sync was never run, the list was partial
 *
 * RULES (measure.mjs): a failed command throws; a zero is refused unless a positive
 * control proves the query path works (here: the same service's /subscriptions list
 * is non-empty, because every APIM has its built-in all-access subscription); stderr
 * is never discarded; a count that could not be read is UNKNOWN, not 0.
 *
 * NOT RUN LIVE. Written for the W1-7 receipts; only its compare logic is unit-tested
 * (__tests__/registry-probe.test.mjs). Gov receipts must come from a GitHub Actions
 * run (cloud-parity.md), never from a workstation.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { az, MeasurementError } from '../measure.mjs';

export const APIM_API_VERSION = '2024-06-01-preview';

const ARM_HOSTS = new Set([
  'https://management.azure.com',
  'https://management.usgovcloudapi.net',
]);

const APIM_ID_RE =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_().-]{1,90}\/providers\/Microsoft\.ApiManagement\/service\/([A-Za-z][A-Za-z0-9-]{0,48})$/i;

/** Same derivation as lib/api-gateway/registry/gateway-service.ts gatewayId(). */
export function gatewayIdFor(resourceId) {
  return `gw-${createHash('sha256').update(resourceId.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Service name (the last segment) - the only part of the id this tool ever prints. */
export function serviceNameOf(resourceId) {
  const m = APIM_ID_RE.exec(resourceId);
  if (!m) {
    throw new MeasurementError(
      'resource-id must be an API Management service id: /subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name>',
      {},
    );
  }
  return m[1];
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new MeasurementError(`unexpected argument: ${a}`, {});
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined || val.startsWith('--')) throw new MeasurementError(`--${key} needs a value`, {});
    out[key] = val;
  }
  for (const k of ['resource-id', 'base-url']) {
    if (!out[k]) throw new MeasurementError(`--${k} is required`, {});
  }
  serviceNameOf(out['resource-id']);
  const base = new URL(out['base-url']);
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) {
    throw new MeasurementError('--base-url must be https (http is allowed only for localhost)', {});
  }
  const arm = (out['arm-endpoint'] ?? 'https://management.azure.com').replace(/\/+$/, '');
  if (!ARM_HOSTS.has(arm)) {
    throw new MeasurementError(`--arm-endpoint must be one of: ${[...ARM_HOSTS].join(', ')}`, {});
  }
  return { resourceId: out['resource-id'], baseUrl: base.origin, armEndpoint: arm };
}

/**
 * Pure comparison. `arm` and `loom` are { count, label }-free numbers; the context
 * carries what each counts so the message can say so. Returns { ok, message }.
 */
export function compareApiCounts({ arm, loom, gatewayName, gatewayId, lastSyncAt }) {
  for (const [k, v] of [['arm', arm], ['loom', loom]]) {
    if (!Number.isInteger(v) || v < 0) {
      throw new MeasurementError(`${k} count is ${String(v)}, not a non-negative integer: refusing to compare`, { k, v });
    }
  }
  const armWhat = `ARM lists ${arm} APIs (GET .../service/${gatewayName}/apis, api-version ${APIM_API_VERSION}, every page)`;
  const loomWhat = `Loom inventory.apis = ${loom} (gateway record ${gatewayId}, last sync ${lastSyncAt})`;
  if (arm === loom) return { ok: true, message: `MATCH: ${armWhat}; ${loomWhat}.` };
  return {
    ok: false,
    message:
      `MISMATCH: ${armWhat}, but ${loomWhat}. Difference ${Math.abs(arm - loom)}. ` +
      'If the gateway changed after that sync, re-sync and probe again; otherwise this is a sync defect.',
  };
}

/** One ARM list, every page. Throws if it cannot be read completely (never a partial count). */
export function armListCount(url, armEndpoint, runAz = az) {
  let next = url;
  let total = 0;
  for (let page = 0; page < 50 && next; page++) {
    if (!next.startsWith(`${armEndpoint}/`)) {
      throw new MeasurementError('ARM nextLink left the ARM host; not followed, so the count would be partial', { page });
    }
    const body = runAz(['rest', '--method', 'get', '--url', next]);
    if (!body || !Array.isArray(body.value)) {
      throw new MeasurementError(`ARM list page ${page + 1} had no "value" array: count is UNKNOWN, not 0`, { page });
    }
    total += body.value.length;
    next = body.nextLink || null;
  }
  if (next) throw new MeasurementError('ARM list exceeded 50 pages: count would be partial', {});
  return total;
}

/**
 * ARM API count with the zero rule (R5): a 0 is returned only when the same service's
 * /subscriptions list is non-empty, proving the query path and the identity work.
 */
export function armApiCount(resourceId, armEndpoint, runAz = az) {
  const base = `${armEndpoint}${resourceId}`;
  const apis = armListCount(`${base}/apis?api-version=${APIM_API_VERSION}`, armEndpoint, runAz);
  if (apis > 0) return apis;
  const control = armListCount(`${base}/subscriptions?api-version=${APIM_API_VERSION}`, armEndpoint, runAz);
  if (!(control > 0)) {
    throw new MeasurementError(
      'ARM reports 0 APIs and the positive control (the service built-in subscription list) is also empty: ' +
        'a zero here would be indistinguishable from a broken query. Refusing.',
      { apis, control },
    );
  }
  return 0;
}

/** Read the gateway record from Loom. The cookie is only ever placed in the request header. */
export async function loomGateway(baseUrl, resourceId, cookie, fetchImpl = fetch) {
  if (!cookie) throw new MeasurementError('LOOM_SESSION_COOKIE is not set (the loom_session cookie value of an admin session)', {});
  const res = await fetchImpl(`${baseUrl}/api/admin/api-gateway/gateways`, {
    headers: { cookie: `loom_session=${cookie}`, accept: 'application/json' },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    throw new MeasurementError(`Loom redirected (HTTP ${res.status}): the session cookie was not accepted (stale or wrong secret?)`, { status: res.status });
  }
  if (res.status !== 200) {
    throw new MeasurementError(`GET /api/admin/api-gateway/gateways answered HTTP ${res.status}: Loom inventory is UNKNOWN, not 0`, { status: res.status });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new MeasurementError('GET /api/admin/api-gateway/gateways did not return JSON', {});
  }
  const list = json?.data?.gateways;
  if (!Array.isArray(list)) throw new MeasurementError('response had no data.gateways array', {});
  const id = gatewayIdFor(resourceId);
  const gw = list.find((g) => g && g.id === id);
  if (!gw) {
    throw new MeasurementError(
      `gateway ${id} is not registered in Loom (${list.length} gateway(s) listed): register it before probing`,
      { id },
    );
  }
  const inv = gw.inventory;
  if (!inv || !inv.lastSyncAt) {
    throw new MeasurementError(`gateway ${id} has never synced: inventory.apis=0 there means "not synced", not "no APIs". Run Sync inventory first`, { id });
  }
  if (Array.isArray(inv.partialTypes) && inv.partialTypes.includes('api')) {
    throw new MeasurementError(`the last sync of ${id} read the API list partially (partialTypes includes "api"): its count is not a total, re-sync`, { id });
  }
  if (!Number.isInteger(inv.apis)) throw new MeasurementError('gateway record has no integer inventory.apis', { id });
  return { id, apis: inv.apis, lastSyncAt: inv.lastSyncAt };
}

export async function main(argv, env = process.env) {
  try {
    const a = parseArgs(argv);
    const name = serviceNameOf(a.resourceId);
    const arm = armApiCount(a.resourceId, a.armEndpoint);
    const gw = await loomGateway(a.baseUrl, a.resourceId, env.LOOM_SESSION_COOKIE);
    const r = compareApiCounts({ arm, loom: gw.apis, gatewayName: name, gatewayId: gw.id, lastSyncAt: gw.lastSyncAt });
    (r.ok ? console.log : console.error)(r.message);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error(`INSTRUMENT INVALID: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
