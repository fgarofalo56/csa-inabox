/**
 * LHDS W1b-3a admin + discovery contract probe (#5454), `mode=admin-contract` of
 * .github/workflows/lhds-edge-probe.yml. Called IN PROCESS by lhds-edge-probe-run.mjs --phase probe,
 * against the two synthetic tenants the create phase made. Three groups of checks:
 *
 *   1. fhirUser mapping (#5462): PUT/GET/list on tenant A for a per-run SYNTHETIC GUID oid (never a
 *      real user), the same oid read on tenant B must be 404 (paired with the A read), refused shapes
 *      (non-GUID oid, a dot-segment id, a resource type SMART does not allow), DELETE, read-after-delete.
 *   2. launchUri (#5462): an `app` client and a `backend` client created HERE on tenant A (ids `ep-...`,
 *      recorded in the owned-file before the POST, disabled in a finally and again by the cleanup sweep).
 *   3. Discovery (#5461) through the PUBLIC issuer, discovered from the control plane, never typed in:
 *      per-tenant openid-configuration, smart-configuration, and an unknown-tenant control that must be
 *      400 invalid_request (so a 200 for tenant A is not a catch-all). No bearer goes to the public host.
 *
 * One line per check: `PASS|FAIL|UNMEASURED <name> <observed>`. UNMEASURED means the outcome was not
 * established (no response, 401/403 for the caller, or the paired positive control did not pass): it is
 * NOT a claim the contract is broken (deploy-integrity R7). Exit: 0 all PASS, 1 any FAIL, 2 otherwise.
 * Nothing printed is a token: admin and discovery responses carry none, and every value goes through redact().
 */
import { appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { discoverIssuer, newKeyMaterial, redact, MintError } from './mint-tenant-token.mjs';

/** The seven fields OpenID Connect Discovery 1.0 section 3 marks REQUIRED. */
export const OIDC_REQUIRED = Object.freeze([
  'issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri',
  'response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported',
]);
export const LAUNCH_URI_OK = 'https://launch.example/launch';
export const LAUNCH_URI_BAD = 'http://evil.example/x';

/** One HTTP call; never throws. Returns the status, parsed JSON and the CORS origin header. */
export async function call(deps, method, url, { body, bearer } = {}) {
  const f = deps.fetchImpl ?? globalThis.fetch;
  const headers = { accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await f(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, acao: res.headers.get('access-control-allow-origin') };
  } catch (e) {
    const cc = e?.cause?.code;
    return { status: 'network-error', json: null, acao: null, code: typeof cc === 'string' && /^[A-Z0-9_]{1,40}$/.test(cc) ? cc : 'unknown' };
  }
}

const errOf = (r) => {
  const e = r.json?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return code ? ` ${redact(code, 60)}` : '';
};

/**
 * The check-evaluation helper. `want` is the expected status; `pred(r)` (optional) returns '' when the
 * body is right or a short reason when it is not. A transport error or a 401/403 (the caller was refused,
 * so the route's own answer was never seen) is UNMEASURED, never PASS and never FAIL.
 */
export function evaluate(name, r, want, pred) {
  if (r.status === 'network-error') return { name, verdict: 'UNMEASURED', observed: `no response (network-error ${r.code}): not established` };
  const obs = `HTTP ${r.status}${errOf(r)}`;
  if ((r.status === 401 || r.status === 403) && want !== r.status) {
    return { name, verdict: 'UNMEASURED', observed: `${obs}: the caller was refused, so the route's answer was not observed` };
  }
  if (r.status !== want) return { name, verdict: 'FAIL', observed: `${obs}, expected ${want}` };
  const why = pred ? pred(r) : '';
  return why ? { name, verdict: 'FAIL', observed: `${obs} but ${redact(why, 200)}` } : { name, verdict: 'PASS', observed: obs };
}

/** A check whose meaning depends on a paired positive control: if the control did not PASS, this is UNMEASURED. */
export function paired(res, control) {
  if (control?.verdict === 'PASS' || res.verdict === 'UNMEASURED') return res;
  return { ...res, verdict: 'UNMEASURED', observed: `${res.observed}; its positive control ${control?.name ?? '(not run)'} did not pass, so this answer proves nothing` };
}

export const exitOf = (results) => (results.some((r) => r.verdict === 'FAIL') ? 1 : results.some((r) => r.verdict !== 'PASS') ? 2 : 0);

/** Run every check; returns { exit, results }. `c`: cpUrl, cpToken, a, b, issuerPath, ownedFile. */
export async function runAdminContract(c, deps = {}) {
  const results = [];
  const print = deps.print ?? ((s) => console.log(s));
  const rec = (x) => { results.push(x); print(`${x.verdict} ${x.name} ${x.observed}`); return x; };
  const own = (line) => { if (c.ownedFile) appendFileSync(c.ownedFile, `${line}\n`); };
  const origin = new URL(c.cpUrl).origin;
  const admin = (method, path, body) => call(deps, method, `${origin}${path}`, { body, bearer: c.cpToken });
  const hex = () => randomBytes(4).toString('hex');

  // ---- 1. fhirUser mapping ----
  const oid = (deps.newOid ?? randomUUID)().toLowerCase(); // synthetic, per run; never a real user
  const resource = `Practitioner/ep-${hex()}`;
  const fu = (t, o) => `/api/health/auth/tenants/${encodeURIComponent(t)}/fhir-users/${encodeURIComponent(o)}`;
  own(`fhiruser:${c.a}:${oid}`); // recorded BEFORE the PUT, so a crash after it still leaves a cleanup record
  let deleted = false;
  try {
    rec(evaluate('fhir-user-put', await admin('PUT', fu(c.a, oid), { resource }), 200,
      (r) => (r.json?.data?.resource === resource && r.json?.data?.oid === oid ? '' : `data.resource=${JSON.stringify(r.json?.data?.resource)} oid_matches=${r.json?.data?.oid === oid}`)));
    const readA = rec(evaluate('fhir-user-get', await admin('GET', fu(c.a, oid)), 200,
      (r) => (r.json?.data?.resource === resource ? '' : `data.resource=${JSON.stringify(r.json?.data?.resource)}, expected ${resource}`)));
    rec(evaluate('fhir-user-list', await admin('GET', `/api/health/auth/tenants/${encodeURIComponent(c.a)}/fhir-users`), 200,
      (r) => (Array.isArray(r.json?.data?.fhirUsers) && r.json.data.fhirUsers.some((x) => x.oid === oid && x.resource === resource) ? '' : 'the list does not contain the mapping just written')));
    rec(paired(evaluate('fhir-user-cross-tenant-404', await admin('GET', fu(c.b, oid)), 404), readA));
    rec(evaluate('fhir-user-put-non-guid-400', await admin('PUT', fu(c.a, 'not-a-guid'), { resource }), 400));
    rec(evaluate('fhir-user-put-bad-type-400', await admin('PUT', fu(c.a, oid), { resource: `Organization/ep-${hex()}` }), 400));
    rec(evaluate('fhir-user-put-dot-segment-400', await admin('PUT', fu(c.a, oid), { resource: 'Patient/..' }), 400));
    const del = rec(evaluate('fhir-user-delete-204', await admin('DELETE', fu(c.a, oid)), 204));
    deleted = del.verdict === 'PASS';
    rec(paired(evaluate('fhir-user-get-after-delete-404', await admin('GET', fu(c.a, oid)), 404), readA));
  } finally {
    if (!deleted) {
      const r = await admin('DELETE', fu(c.a, oid));
      print(`cleanup fhir-user mapping on ${c.a}: HTTP ${r.status}${r.status === 204 ? '' : ' (not confirmed; the cleanup phase retries it from the owned-file)'}`);
    }
  }

  // ---- 2. launchUri ----
  const appId = `ep-app-${c.a}-${hex()}`.slice(0, 64);
  const beId = `ep-be-${c.a}-${hex()}`.slice(0, 64);
  const made = [];
  const patch = (id, body) => admin('PATCH', `/api/health/auth/clients/${encodeURIComponent(id)}`, body);
  const listed = async (id) => {
    const r = await admin('GET', '/api/health/auth/clients');
    return { r, cl: Array.isArray(r.json?.data?.clients) ? r.json.data.clients.find((x) => x.clientId === id) : undefined };
  };
  try {
    own(`client:${appId}`);
    const app = rec(evaluate('app-client-create', await admin('POST', '/api/health/auth/clients', {
      clientId: appId, tenant: c.a, clientType: 'app', displayName: `admin contract ${c.a}`,
      allowedScopes: ['user/*.rs'], redirectUris: ['https://launch.example/callback'],
    }), 201));
    if (app.verdict === 'PASS') made.push(appId);
    own(`client:${beId}`);
    const be = rec(evaluate('backend-client-create', await admin('POST', '/api/health/auth/clients', {
      clientId: beId, tenant: c.a, clientType: 'backend', displayName: `admin contract ${c.a}`,
      jwks: { keys: [newKeyMaterial().publicJwk] }, allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-reader'],
    }), 201));
    if (be.verdict === 'PASS') made.push(beId);

    const set = rec(paired(evaluate('launch-uri-set', await patch(appId, { launchUri: LAUNCH_URI_OK }), 200,
      (r) => (r.json?.data?.launchUri === LAUNCH_URI_OK ? '' : `data.launchUri=${JSON.stringify(r.json?.data?.launchUri)}`)), app));
    const l1 = await listed(appId);
    rec(paired(evaluate('launch-uri-listed', l1.r, 200,
      () => (l1.cl?.launchUri === LAUNCH_URI_OK ? '' : `the list shows launchUri=${JSON.stringify(l1.cl?.launchUri)}`)), set));
    rec(paired(evaluate('launch-uri-plain-http-400', await patch(appId, { launchUri: LAUNCH_URI_BAD }), 400), set));
    rec(paired(evaluate('launch-uri-clear', await patch(appId, { launchUri: null }), 200,
      (r) => (r.json?.data && !('launchUri' in r.json.data) ? '' : `data.launchUri=${JSON.stringify(r.json?.data?.launchUri)} after null`)), set));
    const l2 = await listed(appId);
    rec(paired(evaluate('launch-uri-cleared-listed', l2.r, 200,
      () => (l2.cl && !('launchUri' in l2.cl) ? '' : l2.cl ? `the list still shows launchUri=${JSON.stringify(l2.cl.launchUri)}` : 'the client is missing from the list')), set));
    rec(paired(paired(evaluate('launch-uri-backend-400', await patch(beId, { launchUri: LAUNCH_URI_OK }), 400), be), set));
  } finally {
    for (const id of made) {
      const r = await patch(id, { status: 'disabled' });
      print(`cleanup client ${id} disabled=${r.status === 200 && r.json?.data?.status === 'disabled'}`);
    }
  }

  // ---- 3. discovery through the PUBLIC issuer ----
  let issuer;
  try {
    issuer = (await discoverIssuer({ cpUrl: c.cpUrl, issuerPath: c.issuerPath, fetchImpl: deps.fetchImpl, sleep: deps.sleep })).issuer;
  } catch (e) {
    rec({ name: 'issuer-discovery', verdict: e instanceof MintError && e.exit === 1 ? 'FAIL' : 'UNMEASURED', observed: redact(e?.message ?? 'error', 300) });
  }
  if (issuer) {
    const want = `${issuer}/${c.a}`;
    const oidc = await call(deps, 'GET', `${want}/.well-known/openid-configuration`); // public document: no bearer
    const o = rec(evaluate('oidc-discovery-issuer', oidc, 200,
      (r) => (r.json?.issuer === want ? '' : `issuer=${JSON.stringify(r.json?.issuer)}, expected ${want}`)));
    rec(evaluate('oidc-discovery-required-fields', oidc, 200, (r) => {
      const missing = OIDC_REQUIRED.filter((k) => r.json?.[k] === undefined || r.json?.[k] === null || r.json?.[k] === '' || (Array.isArray(r.json?.[k]) && r.json[k].length === 0));
      return missing.length ? `missing ${missing.join(',')}` : '';
    }));
    rec(evaluate('oidc-discovery-cors', oidc, 200, (r) => (r.acao === '*' ? '' : `access-control-allow-origin=${JSON.stringify(r.acao)}`)));
    const smart = await call(deps, 'GET', `${want}/.well-known/smart-configuration`);
    rec(evaluate('smart-config-auth-none', smart, 200, (r) => {
      const m = r.json?.token_endpoint_auth_methods_supported;
      return Array.isArray(m) && m.includes('none') ? '' : `token_endpoint_auth_methods_supported=${JSON.stringify(m)}`;
    }));
    rec(paired(evaluate('smart-config-issuer', smart, 200,
      (r) => (r.json?.issuer === want && r.json?.issuer === oidc.json?.issuer ? '' : `issuer=${JSON.stringify(r.json?.issuer)}, per-tenant oidc issuer=${JSON.stringify(oidc.json?.issuer)}`)), o));
    const ghost = `ep-none-${hex()}`;
    rec(paired(evaluate('oidc-discovery-unknown-tenant-400', await call(deps, 'GET', `${issuer}/${ghost}/.well-known/openid-configuration`), 400,
      (r) => (r.json?.error === 'invalid_request' ? '' : `error=${JSON.stringify(r.json?.error)}`)), o));
  }

  return { exit: exitOf(results), results };
}
