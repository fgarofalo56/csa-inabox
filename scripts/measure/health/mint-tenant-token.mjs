#!/usr/bin/env node
/**
 * LHDS per-tenant access-token mint (#5410, W1b-2 lane L2).
 *
 * The LHDS authorization server (apps/loom-health-cp/src/auth/server.ts) issues a
 * `client_credentials` token to a SMART Backend Services client that authenticates with a
 * signed JWT assertion (private_key_jwt, RS384/ES384). Nothing minted such a token, so the
 * edge probe could not run. This does, with no secret at rest:
 *
 *   1. discover the issuer at RUNTIME from the control plane's
 *      `{issuerPath}/.well-known/openid-configuration` (the issuer is moving to a Front Door
 *      host; it is never hardcoded, and `aud` is built from the DISCOVERED value);
 *   2. generate an ES384 key pair IN MEMORY (never written);
 *   3. register a backend client for the tenant via the admin API (caller = the deploy SP's
 *      control-plane token, HealthCP.Admin + caller allowlist);
 *   4. sign the assertion (aud = `${issuer}/${tenant}/token`, exp <= 300 s, fresh jti);
 *   5. POST it to the token endpoint, reached on the CP's INTERNAL origin;
 *   6. hand the access token to the CALLER IN-PROCESS. The CLI prints a redacted verdict only.
 *
 * Tokens and keys are never printed, logged, written, or placed in GITHUB_ENV / outputs.
 *
 * CLI (mint-only verdict for ONE tenant; the client is disabled afterwards):
 *   LHDS_CP_TOKEN=<cp bearer> node mint-tenant-token.mjs --cp-url https://<cp> --tenant <slug>
 *     [--issuer-path /auth] [--client-prefix ep]
 *
 * Exit codes (deploy-integrity R6/R7: an outcome that was not established is not a pass):
 *   0 minted AND every claim check passed
 *   1 DEFECT: the authorization server answered and the answer is wrong (token refused for a
 *     client it just accepted, or a claim does not match)
 *   2 UNMEASURED: bad config, missing permission, or a transient failure that outlived its
 *     bounded retries. This is NOT a claim that the authorization server is broken.
 *
 * Cleanup: the control plane has PATCH (status active|disabled) but NO DELETE for clients, so a
 * minted client is DISABLED, not removed (disableClient). A disabled client cannot mint again.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const DEFAULT_ISSUER_PATH = '/auth';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,19}$/;
const ASSERTION_TTL_S = 120; // the AS refuses anything above 300 (MAX_ASSERTION_LIFETIME_S)
const MAX_ATTEMPTS = 3;
const TRANSIENT = new Set(['network-error', 408, 429, 500, 502, 503, 504]);
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]+/g;

/** An honest failure: `cls` is config | permission | transient | defect. exit 1 = defect, else 2. */
export class MintError extends Error {
  constructor(cls, message) {
    super(message);
    this.cls = cls;
    this.exit = cls === 'defect' ? 1 : 2;
  }
}

/** Public-safe text: JWT-shaped strings masked, control characters flattened, length capped. */
export function redact(v, cap = 300) {
  const s = String(v ?? '').replace(JWT_RE, '<jwt>').replace(CTRL_RE, ' ');
  return s.length > cap ? `${s.slice(0, cap)}...` : s;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

export function classifyStatus(status) {
  if (TRANSIENT.has(status)) return 'transient';
  if (status === 401 || status === 403) return 'permission';
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'config';
  return 'defect';
}

/** One call; never throws. A network failure is a value (status 'network-error'). */
export async function cpCall(c, method, url, { body, form, bearer } = {}) {
  const f = c.fetchImpl ?? globalThis.fetch;
  const headers = { accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let payload;
  if (form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  try {
    const res = await f(url, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json };
  } catch (e) {
    const cc = e?.cause?.code;
    return { status: 'network-error', json: null, code: typeof cc === 'string' && /^[A-Z0-9_]{1,40}$/.test(cc) ? cc : 'unknown' };
  }
}

const errText = (r) => {
  if (r.status === 'network-error') return `network-error code=${r.code}`;
  const e = r.json?.error;
  const code = typeof e === 'string' ? e : e?.code;
  const msg = typeof e === 'string' ? r.json?.error_description : e?.message;
  return `HTTP ${r.status} ${redact(code ?? '-', 60)}: ${redact(msg ?? '(no error body)', 200)}`;
};

/** Bounded retry, transient outcomes only. `attempt` is passed so callers can tell a replay. */
async function withRetry(c, what, fn) {
  const sleep = c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await fn(attempt);
    if (!TRANSIENT.has(last.status)) return last;
    if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  throw new MintError('transient', `${what}: still failing after ${MAX_ATTEMPTS} attempts (${errText(last)}); this does not establish the authorization server is broken`);
}

const cleanOrigin = (cpUrl) => {
  let u;
  try { u = new URL(cpUrl); } catch { throw new MintError('config', 'cp-url is not a URL'); }
  const loop = u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if ((u.protocol !== 'https:' && !loop) || u.username || u.password || u.search || u.hash) {
    throw new MintError('config', 'cp-url must be a bare https origin (http only for loopback)');
  }
  return u.origin;
};

/** Discover the issuer from the control plane's internal origin. aud/iss checks use THIS value. */
export async function discoverIssuer(c) {
  const origin = cleanOrigin(c.cpUrl);
  const issuerPath = c.issuerPath ?? DEFAULT_ISSUER_PATH;
  if (!/^\/[A-Za-z0-9._/-]*$/.test(issuerPath) || issuerPath.endsWith('/')) throw new MintError('config', 'issuer-path must start with / and not end with /');
  const r = await withRetry(c, 'issuer discovery', () => cpCall(c, 'GET', `${origin}${issuerPath}/.well-known/openid-configuration`));
  if (r.status !== 200 || typeof r.json?.issuer !== 'string') {
    throw new MintError(r.status === 404 ? 'config' : classifyStatus(r.status), `issuer discovery at ${issuerPath}/.well-known/openid-configuration failed: ${errText(r)}`);
  }
  let iu;
  try { iu = new URL(r.json.issuer); } catch { throw new MintError('defect', 'discovered issuer is not a URL'); }
  const loop = iu.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(iu.hostname);
  if ((iu.protocol !== 'https:' && !loop) || iu.username || iu.password) throw new MintError('defect', 'discovered issuer is not https');
  const issuer = r.json.issuer.replace(/\/+$/, '');
  return { issuer, origin, tokenBase: `${origin}${iu.pathname.replace(/\/+$/, '')}` };
}

/** ES384 key pair in memory; the private half never leaves this closure. */
export function newKeyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const kid = `ep-${randomBytes(6).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES384', use: 'sig' };
  return { kid, publicJwk: jwk, signAssertion: (claims) => signJwt(privateKey, kid, claims) };
}

function signJwt(privateKey, kid, claims) {
  const head = b64u(JSON.stringify({ alg: 'ES384', typ: 'JWT', kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = sign('sha384', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

export function decodeClaims(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/**
 * Claim checks on a freshly minted token (decode only: the signature is the AS's, and the edge
 * validates it). Returns booleans and the scope; never the token.
 */
export function checkClaims(token, { tenant, issuer, nowMs = Date.now() }) {
  const p = decodeClaims(token);
  if (!p) return { decoded: false, tenantOk: false, issOk: false, expOk: false, scope: '' };
  return {
    decoded: true,
    tenantOk: p.tenant === tenant,
    issOk: typeof p.iss === 'string' && p.iss.replace(/\/+$/, '') === issuer,
    expOk: typeof p.exp === 'number' && p.exp * 1000 > nowMs,
    scope: typeof p.scope === 'string' ? p.scope : Array.isArray(p.scope) ? p.scope.join(' ') : '',
  };
}

/** Disable a minted client (no DELETE route exists). Returns true when the CP confirmed it. */
export async function disableClient(c, clientId) {
  const origin = cleanOrigin(c.cpUrl);
  const r = await cpCall(c, 'PATCH', `${origin}/api/health/auth/clients/${encodeURIComponent(clientId)}`, { body: { status: 'disabled' }, bearer: c.cpToken });
  return r.status === 200 && r.json?.data?.status === 'disabled';
}

/**
 * Mint one access token for `tenant`. Returns { accessToken, clientId, issuer, scope, expiresIn,
 * claims }. The caller owns the token; this function never prints it.
 */
export async function mintTenantToken(c) {
  if (!c.cpToken) throw new MintError('config', 'no control-plane bearer token (set env LHDS_CP_TOKEN)');
  if (!SLUG_RE.test(c.tenant ?? '')) throw new MintError('config', 'tenant must match ^[a-z0-9][a-z0-9-]{1,19}$');
  const disc = await discoverIssuer(c);
  const km = newKeyMaterial();
  const clientId = `${c.clientPrefix ?? 'ep'}-${c.tenant}-${randomBytes(4).toString('hex')}`.slice(0, 64);

  const reg = await withRetry(c, 'client registration', (attempt) => cpCall(c, 'POST', `${disc.origin}/api/health/auth/clients`, {
    bearer: c.cpToken,
    body: {
      clientId, tenant: c.tenant, clientType: 'backend', displayName: `edge probe ${c.tenant}`,
      jwks: { keys: [km.publicJwk] },
      // Least privilege: read-only system scope on the reader role. 409 on a REPLAY means the first
      // attempt landed (same client id, same key): accept it, never on the first attempt.
      allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-reader'],
    },
  }).then((r) => (attempt > 1 && r.status === 409 ? { status: 201, json: { ok: true } } : r)));
  if (reg.status !== 201 || reg.json?.ok !== true) {
    const hint = reg.status === 401 || reg.status === 403
      ? ' The caller needs the HealthCP.Admin app role AND a place on the control plane caller allowlist.' : '';
    throw new MintError(classifyStatus(reg.status), `client registration for tenant ${c.tenant} refused: ${errText(reg)}.${hint}`);
  }

  const now = Math.floor((c.nowMs ?? Date.now()) / 1000);
  const aud = `${disc.issuer}/${c.tenant}/token`; // the AS compares against ITS issuer: the discovered one
  const assertion = km.signAssertion({ iss: clientId, sub: clientId, aud, jti: randomUUID(), iat: now, exp: now + ASSERTION_TTL_S });
  const tok = await withRetry(c, 'token request', () => cpCall(c, 'POST', `${disc.tokenBase}/${c.tenant}/token`, {
    form: { grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE, client_assertion: assertion, scope: 'system/*.rs' },
  })).catch(async (e) => { await disableClient(c, clientId).catch(() => false); throw e; });
  if (tok.status !== 200 || typeof tok.json?.access_token !== 'string') {
    await disableClient(c, clientId).catch(() => false);
    const notAvail = tok.json?.error === 'invalid_request' && /tenant is not available/.test(String(tok.json?.error_description));
    throw new MintError(notAvail ? 'config' : 'defect',
      `token endpoint refused a client it had just accepted for tenant ${c.tenant}: ${errText(tok)}${notAvail ? ' (the tenant is not active yet)' : ''}`);
  }
  return {
    accessToken: tok.json.access_token,
    clientId,
    issuer: disc.issuer,
    scope: String(tok.json.scope ?? ''),
    expiresIn: tok.json.expires_in,
    claims: checkClaims(tok.json.access_token, { tenant: c.tenant, issuer: disc.issuer, nowMs: c.nowMs }),
  };
}

/** The redacted verdict lines for one mint (no token material). Returns { lines, ok }. */
export function verdictLines(tenant, m) {
  const k = m.claims;
  const ok = k.decoded && k.tenantOk && k.issOk && k.expOk;
  return {
    ok,
    lines: [
      `mint tenant=${tenant} minted=true decoded=${k.decoded} tenant_claim_matches=${k.tenantOk} iss_matches_discovered_issuer=${k.issOk} exp_in_future=${k.expOk} scope="${redact(m.scope, 120)}"`,
      `VERDICT ${ok ? 'PASS' : 'FAIL'} tenant=${tenant}`,
    ],
  };
}

export function parseArgs(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  return {
    cpUrl: String(a['cp-url'] ?? env.LHDS_CP_URL ?? '').trim(),
    tenant: String(a.tenant ?? env.LHDS_TENANT ?? '').trim(),
    issuerPath: String(a['issuer-path'] ?? env.LHDS_ISSUER_PATH ?? DEFAULT_ISSUER_PATH).trim(),
    clientPrefix: String(a['client-prefix'] ?? 'ep').trim(),
    cpToken: String(env.LHDS_CP_TOKEN ?? '').replace(/[\r\n]/g, ''),
  };
}

/** CLI body, injectable for tests. Returns the exit code. */
export async function cli(argv, env, out = (s) => console.log(s), deps = {}) {
  const c = { ...parseArgs(argv, env), ...deps };
  let m;
  try {
    m = await mintTenantToken(c);
  } catch (e) {
    if (e instanceof MintError) {
      out(`mint tenant=${redact(c.tenant, 40)} minted=false class=${e.cls}: ${redact(e.message, 500)}`);
      out(`VERDICT ${e.exit === 1 ? 'FAIL' : 'UNMEASURED'} tenant=${redact(c.tenant, 40)}`);
      return e.exit;
    }
    out(`mint tenant=${redact(c.tenant, 40)} minted=false class=defect: unexpected ${redact(e?.name ?? 'error', 40)}`);
    out(`VERDICT FAIL tenant=${redact(c.tenant, 40)}`);
    return 1;
  }
  const v = verdictLines(c.tenant, m);
  for (const l of v.lines) out(l);
  const disabled = await disableClient(c, m.clientId).catch(() => false);
  out(`cleanup client_disabled=${disabled}${disabled ? '' : ' (the control plane did not confirm; the client remains registered)'}`);
  return v.ok ? (disabled ? 0 : 2) : 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  cli(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
