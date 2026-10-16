#!/usr/bin/env node
/**
 * governance-purview-dataplane.mjs - W0 live measurement (read-only Data Map).
 *
 *   node scripts/measure/governance-purview-dataplane.mjs \
 *     --account NAME [--tenant TENANT_ID] [--boundary Commercial|GCC-High] [--base URL] [--out file.json]
 *
 * Only HTTP GET is ever issued. It answers four questions without writing
 * anything:
 *   1. which token audience (of a per-boundary candidate list) yields a token
 *      AND an authorised answer from the account (PRP risk R4);
 *   2. which collections, registered data sources and scans exist;
 *   3. the last scan runs (status, start/end, discovered/classified counts);
 *   4. whether the answer is trustworthy: a list that was not read is BLOCKED
 *      with its HTTP status or transport error, never an empty array.
 *
 * Tokens are held in memory only and never printed (scrub() runs over all output).
 */
import { writeFileSync } from 'node:fs';
import { run } from './measure.mjs';
import { blocked, measured, scrub, STATE } from './governance-lib.mjs';

/** Candidate token audiences per boundary. The code uses only the first. */
export const AUDIENCES = {
  Commercial: ['https://purview.azure.net'],
  'GCC-High': ['https://purview.azure.net', 'https://purview.azure.us', 'https://purview.azure.com'],
};
/** Hosts per boundary (purview-endpoints.ts: purviewDataPlaneSuffix). */
export function conventionBase(account, boundary) {
  return `https://${account}.${boundary === 'GCC-High' ? 'purview.azure.us' : 'purview.azure.com'}`;
}
export const SCAN_API = '2022-07-01-preview';
export const SCAN_API_LEARN = '2023-09-01';
export const ACCOUNT_API = '2019-11-01-preview';

/** Classify an HTTP status into who must act. 2xx is not classified. */
export function whoForStatus(status) {
  if (status === 401) return 'operator: token rejected (wrong audience or tenant); re-run from an identity in the Purview tenant';
  if (status === 403) return 'Purview collection admin: grant this identity Data Reader on the root collection';
  if (status === 404) return 'operator: path or account host not found (check endpoint)';
  if (status === 429 || status >= 500) return 'retry later; Purview throttled or unavailable';
  return 'operator: unexpected status';
}

/** One GET. Returns {ok, status, json} or throws nothing: transport errors become status null. */
export async function getJson(url, token, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, status: null, error: scrub(`${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`) };
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body kept as a head below */ }
  return { ok: res.ok, status: res.status, json, head: res.ok ? undefined : scrub(text).slice(0, 300) };
}

/** Read one list endpoint into a datum: MEASURED with the array, or BLOCKED with the status. */
export async function readList(datum, url, token, fetchFn = fetch) {
  const r = await getJson(url, token, fetchFn);
  if (!r.ok) return blocked(datum, { status: r.status, reason: r.error ?? `HTTP ${r.status}: ${r.head ?? ''}`, who: r.status ? whoForStatus(r.status) : 'operator: Purview host unreachable from this runner (private endpoint only?)' });
  if (!Array.isArray(r.json?.value)) return blocked(datum, { status: r.status, reason: 'HTTP 2xx but body has no value[] array: not a list response', who: 'operator: investigate endpoint' });
  return measured(datum, r.json.value);
}

export function getToken(audience, tenant) {
  const args = ['account', 'get-access-token', '--resource', audience, '--query', 'accessToken', '-o', 'tsv'];
  if (tenant) args.push('--tenant', tenant);
  try {
    const out = run('az', args, { timeoutMs: 60000 });
    const t = out.stdout.trim();
    if (!t) return { error: 'az returned an empty token' };
    return { token: t };
  } catch (e) {
    return { error: scrub(e.message).slice(0, 400) };
  }
}

/** Summarise a run record to the fields W4 will read back (Learn 2023-09-01 ScanResultWithIngestion). */
export function summariseRun(r) {
  const a = r?.discoveryExecutionDetails?.statistics?.assets ?? {};
  return {
    id: r?.id, status: r?.status, runType: r?.runType, scanLevelType: r?.scanLevelType,
    startTime: r?.startTime, endTime: r?.endTime,
    durationSeconds: r?.startTime && r?.endTime ? Math.round((Date.parse(r.endTime) - Date.parse(r.startTime)) / 1000) : null,
    discovered: a.discovered ?? null, classified: a.classified ?? null, failed: a.failed ?? null,
  };
}

export async function measureDataPlane({ account, tenant, boundary = 'Commercial', base, fetchFn = fetch, tokenFn = getToken }) {
  const root = (base || conventionBase(account, boundary)).replace(/\/+$/, '');
  const audiences = AUDIENCES[boundary];
  if (!audiences) throw new Error(`unknown boundary ${boundary}`);
  const out = { base: root, boundary, audienceProbe: [], state: STATE.BLOCKED };
  let working = null;
  for (const aud of audiences) {
    const t = tokenFn(aud, tenant);
    if (t.error) { out.audienceProbe.push(blocked(`token for audience ${aud}`, { reason: t.error, who: 'operator: identity cannot mint a token for this audience/tenant' })); continue; }
    const probe = await getJson(`${root}/scan/datasources?api-version=${SCAN_API}`, t.token, fetchFn);
    out.audienceProbe.push({ audience: aud, tokenMinted: true, httpStatus: probe.status, ok: probe.ok, note: probe.ok ? undefined : (probe.error ?? probe.head) });
    if (probe.ok && !working) working = { aud, token: t.token };
  }
  if (!working) {
    out.reason = 'no candidate audience produced an authorised 2xx from the scan plane; no data-plane datum was read';
    out.who = 'operator or Gov Actions run with an identity holding Data Reader on the Purview root collection';
    return out;
  }
  out.workingAudience = working.aud;
  const tok = working.token;
  out.collections = await readList('collections', `${root}/collections?api-version=${ACCOUNT_API}`, tok, fetchFn);
  out.dataSources = await readList('data sources', `${root}/scan/datasources?api-version=${SCAN_API}`, tok, fetchFn);
  out.scans = [];
  out.runs = [];
  if (out.dataSources.state === STATE.MEASURED) {
    for (const ds of out.dataSources.value) {
      const sc = await readList(`scans of ${ds.name}`, `${root}/scan/datasources/${encodeURIComponent(ds.name)}/scans?api-version=${SCAN_API}`, tok, fetchFn);
      out.scans.push({ source: ds.name, kind: ds.kind, resourceId: ds.properties?.resourceId, collection: ds.properties?.collection?.referenceName, scans: sc });
      if (sc.state !== STATE.MEASURED) continue;
      for (const s of sc.value) {
        const rr = await readList(`runs of ${ds.name}/${s.name}`, `${root}/scan/datasources/${encodeURIComponent(ds.name)}/scans/${encodeURIComponent(s.name)}/runs?api-version=${SCAN_API}`, tok, fetchFn);
        out.runs.push({ source: ds.name, scan: s.name, runs: rr.state === STATE.MEASURED ? measured(`runs of ${ds.name}/${s.name}`, rr.value.slice(0, 5).map(summariseRun), { totalRuns: rr.value.length }) : rr });
      }
    }
  }
  out.state = STATE.MEASURED;
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

if (process.argv[1]?.endsWith('governance-purview-dataplane.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.account) { console.error('--account is required'); process.exit(64); }
  const res = await measureDataPlane({ account: o.account, tenant: o.tenant, boundary: o.boundary || 'Commercial', base: o.base });
  const text = scrub(JSON.stringify(res, null, 2));
  if (o.out) writeFileSync(o.out, text); else console.log(text);
  if (res.state !== STATE.MEASURED) process.exit(2);
}
