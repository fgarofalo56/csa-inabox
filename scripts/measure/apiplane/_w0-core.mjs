/**
 * _w0-core.mjs - shared machinery for w0-apim-probe.mjs (PRPs/active/
 * loom-api-gateway-plane, work items W0-1, W0-2, W0-3, W0-4, W0-6, W0-7).
 *
 * `_`-prefixed: a library, not a control. The entry point is w0-apim-probe.mjs;
 * the tests are __tests__/w0-apim-probe.test.mjs.
 *
 * WHAT THIS FILE OWNS
 *   - the CLOSED verdict taxonomy (measured | not-measured:<reason> |
 *     unknown:<reason>) and the constructors that refuse anything outside it;
 *   - the single publication choke point (sanitize / deepSanitize) that sends
 *     every printed or written string through scripts/ci/_azure-redact.mjs;
 *   - the HTTP engine: Node global fetch with an injected bearer token, REAL
 *     statuses (`az rest` hides them), bounded retry on 429/5xx/network only;
 *   - the scratch-object contract: every object this probe creates is named
 *     `w0-apiplane-*`; EVERY DELETE goes through deleteScratch() and EVERY PUT
 *     through a helper that starts with assertScratchName(), and both throw on
 *     any other name before a request is built.
 *
 * Nothing here knows about a family. Nothing here reads the clock, the network
 * or a process directly: fetch, clock, sleep and the token source are injected,
 * which is what lets the tests run offline and never really sleep.
 *
 * GROUNDING (Microsoft Learn, public pages fetched with curl on 2026-10-29)
 *   Named value PUT/GET/DELETE, api-version 2024-05-01:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/named-value/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/named-value/delete
 *   Policy fragment PUT/GET(format=rawxml)/DELETE/list, 2024-05-01:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/get
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/delete
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/list-by-service
 *   API PUT/DELETE/list (2024-05-01 stable, 2025-09-01-preview for type=mcp):
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/delete
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/list-by-service
 *   APIM service list, 2024-05-01:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api-management-service/list
 *   DELETE needs `If-Match` (Learn: "should be * for unconditional update"), and
 *   PUT of an EXISTING entity needs it too ("required when updating"), so
 *   updates and deletes send `If-Match: *`.
 *   Endpoints per cloud: ARM management.azure.com / management.usgovcloudapi.net
 *   (https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure),
 *   Graph graph.microsoft.com / graph.microsoft.us
 *   (https://learn.microsoft.com/en-us/graph/deployments),
 *   Log Analytics query API api.loganalytics.io / api.loganalytics.us (same
 *   Gov compare page; token resource per
 *   https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/access-api).
 */
import { redact, redactSecrets } from '../../ci/_azure-redact.mjs';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Every object this probe creates carries this prefix; nothing else is ever deleted. */
export const SCRATCH_PREFIX = 'w0-apiplane-';

/**
 * What a scratch NAME may look like. Stricter than `startsWith(SCRATCH_PREFIX)`
 * on purpose: the name is spliced into a DELETE url, so `w0-apiplane-/../x`,
 * `w0-apiplane-a?b` and `w0-apiplane-%2e` must not pass a prefix check.
 */
export const SCRATCH_NAME_RE = /^w0-apiplane-[a-z0-9][a-z0-9-]{0,60}$/;

export const CLOUDS = Object.freeze({
  commercial: Object.freeze({
    name: 'commercial',
    azEnvironment: 'AzureCloud',
    arm: 'https://management.azure.com',
    armAudience: 'https://management.azure.com',
    graph: 'https://graph.microsoft.com',
    graphAudience: 'https://graph.microsoft.com',
    logAnalytics: 'https://api.loganalytics.io',
    logAnalyticsAudience: 'https://api.loganalytics.io',
  }),
  gov: Object.freeze({
    name: 'gov',
    azEnvironment: 'AzureUSGovernment',
    arm: 'https://management.usgovcloudapi.net',
    armAudience: 'https://management.usgovcloudapi.net',
    graph: 'https://graph.microsoft.us',
    graphAudience: 'https://graph.microsoft.us',
    logAnalytics: 'https://api.loganalytics.us',
    logAnalyticsAudience: 'https://api.loganalytics.us',
  }),
});

/** api-versions, each from the Learn page named in the header (or the family file that uses it). */
export const API = Object.freeze({
  apim: '2024-05-01',
  apimPreview: '2025-09-01-preview',
  diag: '2021-05-01-preview',
  logAnalyticsMgmt: '2022-10-01',
  cognitive: '2024-10-01',
  managedIdentity: '2023-01-31',
  // Key Vault list (names only): the api-version the Console itself uses for the same list in both clouds
  // (apps/fiab-console/lib/gates/registry/types.ts); Learn's current page is 2024-11-01 with the same path and shape.
  keyVault: '2023-07-01',
});

export const FAMILIES = Object.freeze(['telemetry', 'policies', 'mcp', 'identity', 'latency', 'foundry']);

// ---------------------------------------------------------------------------
// closed verdict taxonomy (R4)
// ---------------------------------------------------------------------------

/** `not-measured` is STRUCTURAL only: the boundary or the runner made the question unaskable. */
export const NOT_MEASURED_REASONS = Object.freeze([
  'no-gateway-in-boundary',
  'gateway-unreachable-from-runner',
  'api-version-unsupported-in-boundary',
  'boundary-not-exercised',
  'no-in-boundary-runner',
]);

/**
 * `unknown` reasons. The first three are the brief's. The other two are the
 * ONLY additions, each for a case the brief names without giving a reason:
 * "workspace ... else unknown" (telemetry) and "locate the UAMI / sign-in app"
 * (identity) when the read worked and nothing matched the search rule - which
 * must never be rendered as "no".
 */
export const UNKNOWN_REASONS = Object.freeze([
  'transient-exhausted',
  'tooling-error',
  'workspace-not-discovered',
  'not-located',
]);

const PERMISSION_RE = /^permission:[A-Za-z][A-Za-z0-9 ._-]{1,60}@(subscription|resource-group|apim|workspace|tenant|resource)$/;

/** Build `permission:<role>@<scope-kind>`; refuses an unknown scope kind. */
export function permissionReason(role, scopeKind) {
  const r = `permission:${role}@${scopeKind}`;
  if (!PERMISSION_RE.test(r)) throw new Error(`malformed permission reason: ${r}`);
  return r;
}

function checkHttp(http) {
  if (http === null || http === undefined) return null;
  const list = Array.isArray(http) ? http : [http];
  if (list.length === 0 || !list.every((n) => Number.isInteger(n) && n >= 100 && n <= 599)) {
    throw new Error(`http must be an HTTP status (or a non-empty list of them), got ${JSON.stringify(http)}`);
  }
  return Array.isArray(http) ? http.slice() : http;
}

function baseCell(id, verdict, reason, opts) {
  const { required = true, dataPlane = false, evidence = {} } = opts || {};
  return { id, verdict, reason, required, dataPlane, evidence };
}

/**
 * A measured cell carries a VALUE and the evidence it came from: an HTTP status
 * quoted (R4), or - for the two cells that are not HTTP reads (DNS, a derived
 * number) - a named `source`. null/undefined is UNKNOWN, never a measurement.
 */
export function measured(id, value, opts = {}) {
  if (value === null || value === undefined) {
    throw new Error(`measured(${id}) refuses a null/undefined value: that is UNKNOWN, not a measurement`);
  }
  const http = checkHttp(opts.http);
  const source = opts.source ?? null;
  if (http === null && !source) {
    throw new Error(`measured(${id}) needs an http status or a named source: a value with no evidence is not measured`);
  }
  const cell = baseCell(id, 'measured', null, opts);
  cell.value = value;
  cell.http = http;
  cell.source = source;
  return cell;
}

export function notMeasured(id, reason, opts = {}) {
  if (!NOT_MEASURED_REASONS.includes(reason)) {
    throw new Error(`notMeasured(${id}): '${reason}' is not in the closed set ${NOT_MEASURED_REASONS.join(', ')}`);
  }
  return baseCell(id, 'not-measured', reason, opts);
}

export function unknown(id, reason, opts = {}) {
  if (!UNKNOWN_REASONS.includes(reason) && !PERMISSION_RE.test(reason)) {
    throw new Error(`unknown(${id}): '${reason}' is not in the closed set (${UNKNOWN_REASONS.join(', ')}, permission:<role>@<scope-kind>)`);
  }
  return baseCell(id, 'unknown', reason, opts);
}

/** The one-line form quoted in the receipt: value plus the status, or the reason. */
export function verdictText(cell) {
  if (cell.verdict === 'measured') {
    const v = typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value);
    const ev = cell.http !== null && cell.http !== undefined
      ? ` (HTTP ${Array.isArray(cell.http) ? cell.http.join('/') : cell.http})`
      : ` (source: ${cell.source})`;
    return `measured: ${v}${ev}`;
  }
  return `${cell.verdict}:${cell.reason}`;
}

/**
 * Exit code for one family run (R6).
 *   2  a control FAILED, or the script crashed: the instrument is invalid and
 *      no cell of this family is publishable.
 *   3  a REQUIRED cell is unknown (a 401/403, exhausted retries, ...), or the
 *      family left scratch objects behind.
 *   0  controls passed (or could not run for a reason recorded as an unknown
 *      NON-required cell) and every required cell is measured or not-measured.
 */
export function computeExit({ cells, controls, crashed = false }) {
  if (crashed) return 2;
  if (controls.some((c) => c.status === 'failed')) return 2;
  if (cells.some((c) => c.required && c.verdict === 'unknown')) return 3;
  const cleanup = cells.find((c) => c.id.endsWith('.cleanup'));
  if (cleanup && cleanup.verdict === 'measured' && cleanup.evidence && cleanup.evidence.leftovers > 0) return 3;
  return 0;
}

// ---------------------------------------------------------------------------
// publication choke point (R3)
// ---------------------------------------------------------------------------

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/**
 * IPv6, three shapes: the full form (>= 4 groups, so a 12:30:45 timestamp is not one),
 * the compressed form with groups before the `::` (2001:db8::1, fd00::1, fe80::), and a
 * leading `::` that is not glued to a word (::1, but not Foo::Bar).
 */
const IPV6_RE = new RegExp([
  String.raw`\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b`,
  String.raw`\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?(?![0-9A-Za-z:])`,
  String.raw`(?<![A-Za-z0-9:])::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![0-9A-Za-z:])`,
].join('|'), 'g');

const knownSecrets = new Set();

/**
 * Remember a credential this process holds so that sanitize() removes it even
 * when nothing around it looks like a bearer header (an error body echoing the
 * raw token). Short strings are ignored: replacing a 3-letter value would
 * shred ordinary text.
 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
}

export function clearSecretsForTest() {
  knownSecrets.clear();
}

/**
 * Everything printed or written goes through here. Order matters: token-shaped
 * content first, then ids, then addresses. The shared redactor is the repo's
 * (scripts/ci/_azure-redact.mjs); this adds the IP scrub R3 asks for and the
 * registered-secret removal.
 */
function scrub(text) {
  let s = String(text ?? '');
  for (const secret of knownSecrets) s = s.split(secret).join('<token>');
  s = redact(redactSecrets(s));
  return s.replace(IPV4_RE, '<ip>').replace(IPV6_RE, '<ip>');
}

export function sanitize(text, max = 300) {
  let s = scrub(text);
  s = s.replace(/\s+/g, ' ').trim();
  if (max > 0 && s.length > max) s = `${s.slice(0, max)}...`;
  return s;
}

/**
 * The same redaction for a multi-line document (a markdown receipt): line breaks and
 * spacing are kept, because collapsing them would turn a table into one line.
 */
export function sanitizeBlock(text) {
  return String(text ?? '').split('\n').map(scrub).join('\n');
}

/** sanitize() over every string leaf of a JSON-shaped value. Keys are left alone. */
export function deepSanitize(value, max = 2000) {
  if (typeof value === 'string') return sanitize(value, max);
  if (Array.isArray(value)) return value.map((v) => deepSanitize(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepSanitize(v, max);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// error parsing and classification
// ---------------------------------------------------------------------------

/** ARM / Graph / APIM error body -> { code, message }. `message` joins details. */
export function parseErrorBody(text) {
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const err = json && typeof json === 'object' ? (json.error ?? json) : null;
  let code = null;
  let message = null;
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') code = err.code;
    const parts = [];
    if (typeof err.message === 'string') parts.push(err.message);
    if (Array.isArray(err.details)) {
      for (const d of err.details) {
        if (d && typeof d.message === 'string') parts.push(d.message);
        if (d && typeof d.code === 'string' && !code) code = d.code;
      }
    }
    if (parts.length) message = parts.join(' | ');
  }
  if (message === null && typeof text === 'string' && text.length) message = text.slice(0, 2000);
  return { code, message };
}

/** Network error -> a CLASS only. The message can carry an address; it is never kept. */
export function classifyNetworkError(err) {
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const name = String(err?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEDOUT|TIMEOUT/i.test(code)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|ENODATA/i.test(code)) return 'dns';
  if (/ECONNREFUSED/i.test(code)) return 'refused';
  if (/ECONNRESET|EPIPE|SOCKET/i.test(code)) return 'reset';
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code)) return 'tls';
  return 'other';
}

const API_VERSION_CODES = /^(InvalidApiVersionParameter|NoRegisteredProviderFound|UnsupportedApiVersion|ApiVersionNotSupported|InvalidResourceType|InvalidApiVersion)/i;

/**
 * Does this error say the api-version (or resource type at that version) does
 * not exist in this boundary? Keyed to the error CODE first, then to the words
 * "api-version" / "api version" in the message - a code APIM never sends for
 * this would otherwise turn a boundary finding into an instrument error.
 */
export function isApiVersionError(status, code, message) {
  if (status !== 400 && status !== 404) return false;
  if (code && API_VERSION_CODES.test(code)) return true;
  return /api[- ]version/i.test(message || '');
}

/**
 * Does a validation rejection name an ATTRIBUTE - a probe-authoring defect (the body this probe wrote is wrong, so the cell
 * is unknown:tooling-error, exit 3, verbatim message kept) - rather than an ELEMENT (a real finding about what the gateway
 * accepts, so `measured: rejected`)?
 *
 * APIM's validation text is XSD-style and quotes with SINGLE quotes. Learn does not publish it; these are the shapes the
 * hardening review named, not observed from a gateway:
 *   The 'x' attribute is not declared.
 *   The required attribute 'counter-key' is missing.
 *   The 'tokens-per-minute' attribute is invalid - The value 'abc' is invalid according to its datatype 'int'
 * An element rejection never says "attribute":
 *   The element 'inbound' has invalid child element 'llm-token-limit'. List of possible elements expected: ...
 * The previous pattern keyed on a quote or a qualifier ADJACENT to the word and so missed the first and third shapes and every
 * double-quoted form (`The "counter-key" attribute is required`); the bare word (and its plural) is what is left to match.
 *
 * OVER-MATCHING IS THE LOUD DIRECTION, and that is deliberate: a message that merely mentions an attribute becomes
 * unknown:tooling-error and a human reads it, whereas a probe typo quietly published as `rejected` would be a false finding
 * about the gateway. An attribute rejection is therefore never a verdict by itself: it is read against the Commercial row of
 * the same cell. If Commercial accepts the same body and Gov names an attribute, THAT is a boundary difference, and the
 * verbatim message kept next to the cell is how a reader recognises it.
 */
const ATTRIBUTE_RE = /\battributes?\b/i;
export function namesAnAttribute(message) {
  return ATTRIBUTE_RE.test(String(message || ''));
}

// ---------------------------------------------------------------------------
// HTTP engine (R2)
// ---------------------------------------------------------------------------

const TRANSIENT = (s) => s === 429 || (s >= 500 && s <= 599);

function pathOf(url) {
  try {
    const u = new URL(url);
    return sanitize(`${u.pathname}${u.search}`, 400);
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * createClient - the only place a request is made.
 *
 * The bearer token is attached ONLY when the url's origin equals the origin
 * configured for the named service, so a `nextLink` pointing anywhere else can
 * never receive it. The token is registered with registerSecret() so it cannot
 * reach an output even if a server echoes it back.
 *
 * @param {object} o
 * @param {typeof fetch} o.fetchImpl
 * @param {(audience:string)=>Promise<string>} o.getToken
 * @param {(ms:number)=>Promise<void>} o.sleep
 * @param {{now:()=>number}} o.clock
 * @param {typeof CLOUDS.commercial} o.cloud
 * @param {Array<object>} o.requestLog  mutated: one entry per logical request
 */
export function createClient({
  fetchImpl, getToken, sleep, clock, cloud, requestLog,
  maxAttempts = 3, backoffMs = [1000, 2000], timeoutMs = 30000, logCap = 600, tokenTtlMs = 20 * 60 * 1000,
}) {
  const origins = {
    arm: new URL(cloud.arm).origin,
    graph: new URL(cloud.graph).origin,
    logs: new URL(cloud.logAnalytics).origin,
  };
  const audiences = { arm: cloud.armAudience, graph: cloud.graphAudience, logs: cloud.logAnalyticsAudience };
  const tokenCache = new Map();
  let logged = 0;
  let dropped = 0;

  async function bearer(service) {
    const hit = tokenCache.get(service);
    if (hit && clock.now() - hit.at < tokenTtlMs) return hit.token;
    const token = await getToken(audiences[service]);
    registerSecret(token);
    tokenCache.set(service, { token, at: clock.now() });
    return token;
  }

  function record(entry) {
    if (logged < logCap) { requestLog.push(entry); logged += 1; } else { dropped += 1; }
  }

  /**
   * @param {object} req
   * @param {'arm'|'graph'|'logs'|'gateway'} req.service
   * @param {string} req.method
   * @param {string} req.url
   * @param {object} [req.body]      JSON body
   * @param {string} [req.ifMatch]
   * @param {object} [req.headers]
   * @param {number} [req.timeoutMs]
   * @param {boolean} [req.log]      false for high-volume polling
   */
  async function request(req) {
    const { service, method = 'GET', url, body, ifMatch, headers: extra = {}, log = true } = req;
    const t = req.timeoutMs ?? timeoutMs;
    // A poll must not hide retries (and their sleeps) inside the interval it is timing.
    const attemptsAllowed = req.retry === false ? 1 : maxAttempts;
    const headers = { accept: 'application/json', ...extra };
    if (service !== 'gateway') {
      const origin = new URL(url).origin;
      if (origin !== origins[service]) {
        throw new Error(`refusing to send a ${service} bearer token to a foreign origin (${sanitize(origin, 80)})`);
      }
      headers.authorization = `Bearer ${await bearer(service)}`;
    }
    if (ifMatch) headers['if-match'] = ifMatch;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }

    let attempts = 0;
    let result = null;
    while (attempts < attemptsAllowed) {
      attempts += 1;
      let retryAfter = null;
      try {
        const res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(t) });
        const text = await res.text();
        const status = res.status;
        const { code, message } = status >= 400 ? parseErrorBody(text) : { code: null, message: null };
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        result = {
          ok: status >= 200 && status < 300, status, text, json, headers: res.headers,
          errorCode: code ? sanitize(code, 120) : null,
          errorMessage: message ? sanitize(message, 2000) : null,
          attempts, transientExhausted: false, networkErrorClass: null,
        };
        if (!TRANSIENT(status)) break;
        const ra = Number(res.headers?.get?.('retry-after'));
        retryAfter = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : null;
      } catch (err) {
        result = {
          ok: false, status: null, text: '', json: null, headers: null,
          errorCode: null, errorMessage: null, attempts, transientExhausted: false,
          networkErrorClass: classifyNetworkError(err),
        };
      }
      if (attempts < attemptsAllowed) await sleep(retryAfter ?? backoffMs[Math.min(attempts - 1, backoffMs.length - 1)]);
    }
    if (result.status === null || TRANSIENT(result.status)) result.transientExhausted = true;
    if (log) {
      record({
        n: logged + dropped + 1, service, method, path: pathOf(url),
        status: result.status, attempts: result.attempts,
        errorCode: result.errorCode, networkErrorClass: result.networkErrorClass,
        transientExhausted: result.transientExhausted,
      });
    }
    return result;
  }

  return { request, droppedLogEntries: () => dropped };
}

// ---------------------------------------------------------------------------
// ARM url helpers and paging
// ---------------------------------------------------------------------------

export function armUrl(ctx, pathAfterApim, apiVersion, query = '') {
  const q = `api-version=${apiVersion}${query ? `&${query}` : ''}`;
  return `${ctx.cloud.arm}${ctx.apim.resourceId}${pathAfterApim}?${q}`;
}

/** GET every page of a list. Follows `nextLink` only on the ARM origin (the client enforces it). */
export async function listAll(ctx, firstUrl, { service = 'arm', maxPages = 25 } = {}) {
  const items = [];
  let url = firstUrl;
  let last = null;
  for (let page = 0; page < maxPages && url; page += 1) {
    last = await ctx.client.request({ service, method: 'GET', url });
    if (!last.ok) return { ok: false, items, last, truncated: false };
    const value = last.json && Array.isArray(last.json.value) ? last.json.value : null;
    if (value === null) return { ok: false, items, last, malformed: true };
    items.push(...value);
    // ARM pages with `nextLink`, Graph with `@odata.nextLink`.
    const next = last.json.nextLink ?? last.json['@odata.nextLink'];
    url = typeof next === 'string' ? next : null;
  }
  return { ok: true, items, last, truncated: Boolean(url) };
}

// ---------------------------------------------------------------------------
// scratch objects (R7)
// ---------------------------------------------------------------------------

const KIND_PATH = Object.freeze({ namedValue: 'namedValues', policyFragment: 'policyFragments', api: 'apis' });

/**
 * THE name guard. The one DELETE and EVERY PUT helper call it BEFORE a request is built, so a bug upstream can never turn into a
 * write to (or a delete of) a customer's object on a live gateway. Anchored: SCRATCH_NAME_RE is `^...$`, so a name that merely
 * starts with the prefix, a trailing newline, a path segment or a query string does not pass. `verb` is only the word in the
 * message ('delete' | 'write'). (A source-shape test pins that every PUT site and the one DELETE sit behind it.)
 */
export function assertScratchName(name, verb) {
  if (typeof name !== 'string' || !SCRATCH_NAME_RE.test(name)) {
    throw new Error(`refusing to ${verb} a non-scratch object: '${sanitize(name, 80)}' (scratch names match ${SCRATCH_NAME_RE})`);
  }
}

/**
 * THE ONLY DELETE IN THIS PROBE. It throws, before a request is built, on any
 * name that is not a scratch name - so a bug upstream can never turn into a
 * delete of a customer's API on a live gateway. (A source-shape test pins that
 * this is the only place the verb appears.)
 */
export async function deleteScratch(ctx, kind, name, apiVersion = API.apim) {
  assertScratchName(name, 'delete');
  const seg = KIND_PATH[kind];
  if (!seg) throw new Error(`deleteScratch: unknown kind '${kind}'`);
  const url = armUrl(ctx, `/${seg}/${encodeURIComponent(name)}`, apiVersion);
  return ctx.client.request({ service: 'arm', method: 'DELETE', url, ifMatch: '*' });
}

const DELETE_OK = (s) => s === 200 || s === 202 || s === 204 || s === 404;

/**
 * Names under each collection that this probe would itself have created, i.e. that
 * match SCRATCH_NAME_RE - exactly the set deleteScratch is willing to delete.
 *
 * A name that merely STARTS with the prefix but is not one of ours (upper case, a
 * trailing symbol, ...) is reported in `nonConforming` and NEVER deleted or counted
 * as a leftover: this probe did not create it, and the delete guard would refuse it.
 *
 * A listing that did not finish (a failed page, a body with no value[], or more
 * pages than the cap) is a FAILURE, never a shorter list: "0 leftovers" over a
 * half-read collection would be the false zero this tool exists to avoid.
 */
export async function listScratch(ctx) {
  const found = { api: [], policyFragment: [], namedValue: [] };
  const nonConforming = [];
  const failures = [];
  let apiVersionForApis = API.apimPreview;
  const take = (kind, r) => {
    if (!r.ok || r.truncated) {
      failures.push({
        kind, status: r.last?.status ?? null, code: r.truncated ? 'list-truncated' : (r.last?.errorCode ?? null),
        transient: Boolean(r.last?.transientExhausted),
      });
      return;
    }
    for (const item of r.items) {
      const name = item?.name;
      if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX)) continue;
      if (SCRATCH_NAME_RE.test(name)) found[kind].push(name);
      else nonConforming.push(`${kind}:${name}`);
    }
  };
  // APIs: the preview version first (it also shows type=mcp), the stable one when the preview is not served.
  let apis = await listAll(ctx, armUrl(ctx, '/apis', API.apimPreview));
  if (!apis.ok && apis.last && isApiVersionError(apis.last.status, apis.last.errorCode, apis.last.errorMessage)) {
    apiVersionForApis = API.apim;
    apis = await listAll(ctx, armUrl(ctx, '/apis', API.apim));
  }
  take('api', apis);
  take('policyFragment', await listAll(ctx, armUrl(ctx, '/policyFragments', API.apim)));
  take('namedValue', await listAll(ctx, armUrl(ctx, '/namedValues', API.apim)));
  return { found, nonConforming, failures, apiVersionForApis };
}

/**
 * Delete every `w0-apiplane-*` object: APIs first (they reference fragments),
 * then fragments, then named values (they cannot be deleted while a policy
 * references them). A fragment can be blocked by another fragment that includes
 * it, so deletion runs up to three passes.
 */
export async function sweepScratch(ctx) {
  const before = await listScratch(ctx);
  const deleted = [];
  const failed = [];
  const order = [['api', before.apiVersionForApis], ['policyFragment', API.apim], ['namedValue', API.apim]];
  for (const [kind, version] of order) {
    let remaining = before.found[kind].slice();
    const lastResult = new Map();
    for (let pass = 0; pass < 3 && remaining.length; pass += 1) {
      const next = [];
      for (const name of remaining) {
        const r = await deleteScratch(ctx, kind, name, version);
        lastResult.set(name, r);
        if (r.status !== null && DELETE_OK(r.status)) deleted.push(`${kind}:${name}`);
        else next.push(name);
      }
      remaining = next;
    }
    for (const name of remaining) {
      const r = lastResult.get(name);
      failed.push({ kind, name, status: r.status, code: r.errorCode, transient: r.transientExhausted });
    }
  }
  return { deleted, failed, listFailures: before.failures };
}

/**
 * The cleanup cell: after the end-of-family sweep, LIST what is still there.
 * `measured: 0 leftovers` only when the listing itself succeeded and was empty
 * - a failed list is unknown, never zero.
 */
export async function cleanupCell(ctx, family, sweepEvidence) {
  const id = `${family}.cleanup`;
  const after = await listScratch(ctx);
  if (after.failures.length) {
    const f = after.failures[0];
    const reason = f.status === 401 || f.status === 403
      ? permissionReason('API Management Service Reader', 'apim')
      : (f.transient ? 'transient-exhausted' : 'tooling-error');
    return unknown(id, reason, { evidence: { listFailures: after.failures, sweep: sweepEvidence } });
  }
  const names = [...after.found.api, ...after.found.policyFragment, ...after.found.namedValue];
  return measured(id, `${names.length} leftovers`, {
    http: 200,
    evidence: {
      leftovers: names.length, names, sweep: sweepEvidence,
      // prefixed names this probe did not create and will not delete: disclosed, never counted
      notOursButPrefixed: after.nonConforming,
    },
  });
}

/**
 * Run a family body between a START sweep and an END sweep. The end sweep and
 * the leftover listing are in `finally`, so they also run when the body throws.
 * The cleanup cell is appended to acc.cells either way; a body error is then
 * re-thrown so the entry point records the crash (exit 2) WITH the cells that
 * were already measured.
 */
export async function withScratch(ctx, family, acc, body) {
  const summarize = (s) => ({ deleted: s.deleted.length, failed: s.failed, listFailures: s.listFailures });
  let startEvidence = null;
  try {
    startEvidence = summarize(await sweepScratch(ctx));
  } catch (err) {
    startEvidence = { error: sanitize(err?.message, 200) };
  }
  let bodyError = null;
  try {
    await body();
  } catch (err) {
    bodyError = err;
  } finally {
    try {
      const end = summarize(await sweepScratch(ctx));
      acc.cells.push(await cleanupCell(ctx, family, { start: startEvidence, end }));
    } catch (err) {
      acc.cells.push(unknown(`${family}.cleanup`, 'tooling-error', { evidence: { error: sanitize(err?.message, 200), start: startEvidence } }));
    }
  }
  if (bodyError) throw bodyError;
}

// ---------------------------------------------------------------------------
// APIM entity helpers (writes carry the Learn-documented body shapes)
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

// EVERY PUT below is `async` and starts with assertScratchName(): the guard throws (as a rejection, like deleteScratch) BEFORE a
// request is built, so a non-scratch name never reaches the gateway. A source-shape test pins that no PUT site lacks it.
export const putNamedValue = async (ctx, id, value, { update = false } = {}) => {
  assertScratchName(id, 'write');
  return ctx.client.request({
    service: 'arm', method: 'PUT', ifMatch: update ? '*' : undefined,
    url: armUrl(ctx, `/namedValues/${enc(id)}`, API.apim),
    body: { properties: { displayName: id, value, secret: false, tags: ['w0-apiplane'] } },
  });
};
export const getNamedValue = (ctx, id) => ctx.client.request({ service: 'arm', url: armUrl(ctx, `/namedValues/${enc(id)}`, API.apim) });

export const putApi = async (ctx, apiId, properties, apiVersion = API.apim) => {
  assertScratchName(apiId, 'write');
  return ctx.client.request({
    service: 'arm', method: 'PUT', url: armUrl(ctx, `/apis/${enc(apiId)}`, apiVersion), body: { properties },
  });
};
export const getApi = (ctx, apiId, apiVersion = API.apim) => ctx.client.request({ service: 'arm', url: armUrl(ctx, `/apis/${enc(apiId)}`, apiVersion) });

export const putApiPolicy = async (ctx, apiId, xml, apiVersion = API.apim) => {
  assertScratchName(apiId, 'write');
  return ctx.client.request({
    service: 'arm', method: 'PUT', url: armUrl(ctx, `/apis/${enc(apiId)}/policies/policy`, apiVersion),
    body: { properties: { format: 'xml', value: xml } },
  });
};
export const getApiPolicyRaw = (ctx, apiId, apiVersion = API.apim) => ctx.client.request({
  service: 'arm', url: armUrl(ctx, `/apis/${enc(apiId)}/policies/policy`, apiVersion, 'format=rawxml'),
});

export const putOperation = async (ctx, apiId, opId, properties, apiVersion = API.apim) => {
  // the API id AND the operation id: an operation is created UNDER an API, and both come from the caller
  assertScratchName(apiId, 'write');
  assertScratchName(opId, 'write');
  return ctx.client.request({
    service: 'arm', method: 'PUT', url: armUrl(ctx, `/apis/${enc(apiId)}/operations/${enc(opId)}`, apiVersion), body: { properties },
  });
};
export const getOperation = (ctx, apiId, opId, apiVersion = API.apim) => ctx.client.request({
  service: 'arm', url: armUrl(ctx, `/apis/${enc(apiId)}/operations/${enc(opId)}`, apiVersion),
});

// ---------------------------------------------------------------------------
// gateway reachability (shared by telemetry and latency)
// ---------------------------------------------------------------------------

/**
 * GET {gatewayUrl}/status-0123456789abcdef with a 10 s timeout. Learn documents
 * that path as the default health endpoint on every instance
 * (https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway).
 * ANY HTTP status means the host answered, so the gateway is reachable from
 * this runner; only a network failure is "unreachable", and then only its CLASS
 * is kept. Memoised on ctx so every family in one process asks once.
 */
export async function probeGateway(ctx) {
  if (ctx.gatewayProbe) return ctx.gatewayProbe;
  const base = String(ctx.apim.gatewayUrl || '').replace(/\/+$/, '');
  if (!base) {
    // The service resource carried no gatewayUrl: there is nothing to probe, and that is not "reachable".
    ctx.gatewayProbe = { reachable: false, status: null, errorClass: 'no-gateway-url' };
    return ctx.gatewayProbe;
  }
  const r = await ctx.client.request({
    service: 'gateway', method: 'GET', timeoutMs: 10000,
    url: `${base}/status-0123456789abcdef`,
  });
  ctx.gatewayProbe = r.status !== null
    ? { reachable: true, status: r.status, errorClass: null }
    : { reachable: false, status: null, errorClass: r.networkErrorClass || 'other' };
  return ctx.gatewayProbe;
}

// ---------------------------------------------------------------------------
// provisioning wait
// ---------------------------------------------------------------------------

/**
 * APIM answers a PUT with `provisioningState: InProgress` (Learn samples). Poll
 * `read()` until the state is no longer InProgress, bounded by the injected
 * clock. Returns { state, last } where state is 'Succeeded' | 'Failed' |
 * 'timeout' | 'read-failed'.
 */
export async function waitProvisioned(ctx, read, { capMs = 90000, intervalMs = 2000 } = {}) {
  const t0 = ctx.clock.now();
  let last = null;
  for (;;) {
    last = await read();
    if (!last.ok) return { state: 'read-failed', last };
    const state = last.json?.properties?.provisioningState;
    if (state === undefined || state === null || /^succeeded$/i.test(state)) return { state: 'Succeeded', last };
    if (/^failed$/i.test(state)) return { state: 'Failed', last };
    if (ctx.clock.now() - t0 >= capMs) return { state: 'timeout', last };
    await ctx.sleep(intervalMs);
  }
}

const WRITE_ROLE = 'API Management Service Contributor';

/**
 * PUT a policy document, wait for provisioning, GET it back, and compare how
 * many of each named element came back against how many were sent. A 2xx PUT
 * proves nothing on its own: APIM can accept a document and drop what it does
 * not know. Outcomes:
 *   accepted | silent-drop | rejected | rejected-failed | unknown
 * `rejected` means the service answered with a VALIDATION status (400 / 422) and carries `attribute: true` when the message names
 * an ATTRIBUTE (a probe-authoring defect, to be classified tooling-error by the caller). A 409 / 412, an exhausted 429 / 5xx, a
 * 401 / 403 and any other non-2xx are `unknown`: they are not a verdict on the body.
 */
export async function putAndReadBack(ctx, { put, read, xml, count, role = WRITE_ROLE }) {
  const p = await put();
  const base = { put: p, xml, count };
  const early = reasonForFailure(p, { role, scope: 'apim' });
  if (early) return { ...base, outcome: 'unknown', reason: early };
  if (!p.ok) {
    if (isValidationRejection(p)) return { ...base, outcome: 'rejected', attribute: namesAnAttribute(p.errorMessage) };
    return { ...base, outcome: 'unknown', reason: 'tooling-error', note: `the write answered HTTP ${p.status}, which is not a validation response (400/422): not a verdict on the body` };
  }
  const w = await waitProvisioned(ctx, read);
  const get = w.last;
  if (w.state === 'read-failed') {
    return { ...base, get, outcome: 'unknown', reason: reasonForFailure(get, { role, scope: 'apim' }) ?? 'tooling-error' };
  }
  if (w.state === 'timeout') {
    return { ...base, get, outcome: 'unknown', reason: 'transient-exhausted', note: 'provisioningState still InProgress at the wait cap' };
  }
  if (w.state === 'Failed') return { ...base, get, outcome: 'rejected-failed' };
  const got = get.json?.properties?.value;
  if (typeof got !== 'string') {
    return { ...base, get, outcome: 'unknown', reason: 'tooling-error', note: 'GET-back answered 2xx without properties.value' };
  }
  const counts = Object.fromEntries(count.map((el) => [el, { sent: countElement(xml, el), got: countElement(got, el) }]));
  const mismatched = count.filter((el) => counts[el].got !== counts[el].sent);
  return { ...base, get, counts, outcome: mismatched.length ? 'silent-drop' : 'accepted', mismatched };
}

// ---------------------------------------------------------------------------
// shared small helpers
// ---------------------------------------------------------------------------

/** "Central US" / "USGov Virginia" -> "centralus" / "usgovvirginia". */
export function normalizeLocation(display) {
  return String(display || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** How many `<name ...>` start tags a policy document carries (entity-escaped XML is decoded first). */
export function countElement(xml, name) {
  const decoded = String(xml || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const re = new RegExp(`<${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s/>])`, 'g');
  return (decoded.match(re) || []).length;
}

/**
 * Map a non-2xx or transient result to the cell reason it implies, or null when it is a verdict-bearing answer (a validation
 * 400 / 422 on a write, a 404 on a read).
 *
 * 409 and 412 are NOT verdicts: a write that collides with the service's state (another operation in progress) or with a stale
 * precondition (an ETag that moved) says nothing about whether the body is acceptable, so it is `transient-exhausted` - never
 * `rejected`. The same holds for an exhausted 429 / 5xx or a network failure (the client sets `transientExhausted`).
 */
export function reasonForFailure(result, { role, scope }) {
  if (result.transientExhausted) return 'transient-exhausted';
  if (result.status === 401 || result.status === 403) return permissionReason(role, scope);
  if (result.status === 409 || result.status === 412) return 'transient-exhausted';
  return null;
}

/**
 * The only statuses that mean "the service read the body and refused it". `rejected` is a VERDICT about a body, so only these earn
 * it; any other non-2xx on a write (a 404, 405, 413, 415 ...) is the probe's own request failing, not the gateway judging the body.
 */
export const VALIDATION_STATUSES = Object.freeze([400, 422]);
export const isValidationRejection = (result) => !result.ok && VALIDATION_STATUSES.includes(result.status);

/** Families that PUT or DELETE on the gateway. A source-shape test pins this list against the family modules that call withScratch(). */
export const WRITE_FAMILIES = Object.freeze(['policies', 'mcp', 'latency']);

/**
 * May a write family start? A write against a service that is not in provisioningState `Succeeded` (Updating, Activating, Failed,
 * Deleting ...) is answered 409 or silently queued, so what it measured would say nothing about the feature. Returns null when
 * writes may proceed, else the evidence for the family's cells. A MISSING state is not assumed to be Succeeded: what was not
 * established is not asserted (deploy-integrity.md R7).
 */
export function writeGate(apim) {
  const state = apim?.provisioningState;
  if (typeof state === 'string' && /^succeeded$/i.test(state)) return null;
  const shown = typeof state === 'string' && state ? sanitize(state, 40) : null;
  return {
    provisioningState: shown,
    note: `the APIM is not in provisioningState Succeeded (${shown ?? 'not reported'}), so nothing was written: a write against a busy or failed service answers 409 or queues`,
  };
}

/** Trim a verbatim server message for the receipt. */
export function quote(result, max = 300) {
  return {
    status: result.status,
    code: result.errorCode,
    message: result.errorMessage ? sanitize(result.errorMessage, max) : null,
  };
}
