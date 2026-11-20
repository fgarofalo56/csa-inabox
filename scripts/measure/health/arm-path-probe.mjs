#!/usr/bin/env node
/**
 * ARM path probe (#5380) - repeats ONE ARM GET and prints identifiers only.
 *
 * The health control plane sees an intermittent BARE 403 (no JSON, no
 * x-ms-correlation-request-id) on GET .../deployments/lhds-stamp-<id>. This
 * runs the same GET from another network position so the two can be compared.
 *
 * Input (args override env):
 *   --subscription / ARM_PROBE_SUBSCRIPTION   --resource-group / ARM_PROBE_RG
 *   --deployment   / ARM_PROBE_DEPLOYMENT     --api-version / ARM_PROBE_API_VERSION (2024-03-01)
 *   --repeat / ARM_PROBE_REPEAT (20)          --interval-s / ARM_PROBE_INTERVAL_S (6)
 *   --endpoint / ARM_PROBE_ENDPOINT (https://management.azure.com)
 *   bearer token: env ARM_PROBE_TOKEN ONLY (never an argument, never printed).
 *
 * Exit 0 = measured (ANY HTTP status, including 403, is a result).
 * Exit 1 = could not measure (no token / bad input / every attempt a network error).
 * The body is never printed; only a first-byte class and, for JSON, error.code.
 */

// Header-value allowlist: no CR/LF, quotes, angle brackets. Length-capped.
const HEADER_RE = /^[A-Za-z0-9._~+\-/=:;, ]{1,128}$/;
const CODE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MEDIA_RE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const SEG_RE = /^[A-Za-z0-9._()-]{1,90}$/;

/** A header value is printable only if it matches the strict allowlist. */
export function safeHeader(v) {
  if (v === null || v === undefined || v === '') return '-';
  return HEADER_RE.test(String(v)) ? String(v) : 'invalid';
}

export function mediaType(ct) {
  if (!ct) return '-';
  const m = String(ct).split(';')[0].trim().toLowerCase();
  return MEDIA_RE.test(m) ? m : 'invalid';
}

/** First non-whitespace byte class: < { [ empty other */
export function byteClass(text) {
  const t = text.replace(/^[\s﻿]+/, '');
  if (t === '') return 'empty';
  const c = t[0];
  return c === '<' || c === '{' || c === '[' ? c : 'other';
}

export function armErrorCode(text) {
  try {
    const j = JSON.parse(text);
    const c = j?.error?.code ?? j?.error?.Code ?? j?.code;
    if (c === undefined) return '-';
    return typeof c === 'string' && CODE_RE.test(c) ? c : 'invalid';
  } catch { return '-'; }
}

export function readConfig(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const pick = (k, e, d) => a[k] ?? env[e] ?? d;
  return {
    subscription: pick('subscription', 'ARM_PROBE_SUBSCRIPTION'),
    resourceGroup: pick('resource-group', 'ARM_PROBE_RG'),
    deployment: pick('deployment', 'ARM_PROBE_DEPLOYMENT'),
    apiVersion: pick('api-version', 'ARM_PROBE_API_VERSION', '2024-03-01'),
    endpoint: pick('endpoint', 'ARM_PROBE_ENDPOINT', 'https://management.azure.com'),
    repeat: Number(pick('repeat', 'ARM_PROBE_REPEAT', '20')),
    intervalS: Number(pick('interval-s', 'ARM_PROBE_INTERVAL_S', '6')),
    token: (env.ARM_PROBE_TOKEN ?? '').replace(/[\r\n]/g, '').trim(),
  };
}

export function buildUrl(c) {
  return `${c.endpoint.replace(/\/+$/, '')}/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}` +
    `/providers/Microsoft.Resources/deployments/${c.deployment}?api-version=${c.apiVersion}`;
}

function validate(c) {
  for (const [k, v] of [['subscription', c.subscription], ['resource-group', c.resourceGroup], ['deployment', c.deployment], ['api-version', c.apiVersion]]) {
    if (!v || !SEG_RE.test(v)) return `${k} missing or not a plain identifier`;
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(c.endpoint)) return 'endpoint must be a bare https origin';
  if (!Number.isInteger(c.repeat) || c.repeat < 1 || c.repeat > 500) return 'repeat must be an integer 1..500';
  if (!Number.isFinite(c.intervalS) || c.intervalS < 0 || c.intervalS > 600) return 'interval-s must be 0..600';
  if (!c.token) return 'no bearer token in ARM_PROBE_TOKEN (nothing was measured)';
  return null;
}

/**
 * Run the probe. `deps` = { fetchImpl, sleep, out } for injection.
 * Returns { code, lines, summary }.
 */
export async function runProbe(c, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = deps.out ?? ((s) => console.log(s));
  const bad = validate(c);
  if (bad) { out(`COULD NOT MEASURE: ${bad}`); return { code: 1, lines: [], summary: null }; }
  const url = buildUrl(c);
  const status = new Map(); const shape = new Map(); const lines = [];
  let netErrors = 0;
  for (let n = 1; n <= c.repeat; n++) {
    const at = new Date().toISOString();
    let line;
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${c.token}`, accept: 'application/json' } });
      const text = await res.text();
      const h = (k) => res.headers.get(k);
      const len = h('content-length');
      const lenOut = len !== null && /^\d{1,12}$/.test(len) ? len : `measured:${Buffer.byteLength(text)}`;
      const bc = byteClass(text);
      const code = armErrorCode(text);
      line = `attempt=${n} utc=${at} status=${res.status} content-type=${mediaType(h('content-type'))} length=${lenOut}` +
        ` server=${safeHeader(h('server'))} x-ms-request-id=${safeHeader(h('x-ms-request-id'))}` +
        ` x-ms-correlation-request-id=${safeHeader(h('x-ms-correlation-request-id'))} error.code=${code} first-byte=${bc}`;
      status.set(String(res.status), (status.get(String(res.status)) ?? 0) + 1);
      shape.set(bc, (shape.get(bc) ?? 0) + 1);
    } catch (e) {
      netErrors++;
      const cc = e?.cause?.code;
      line = `attempt=${n} utc=${at} status=network-error class=${typeof cc === 'string' && CODE_RE.test(cc) ? cc : 'unknown'}`;
      status.set('network-error', (status.get('network-error') ?? 0) + 1);
    }
    lines.push(line); out(line);
    if (n < c.repeat && c.intervalS > 0) await sleep(c.intervalS * 1000);
  }
  const fmt = (m) => [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  const summary = `SUMMARY attempts=${c.repeat} status[${fmt(status)}] first-byte[${fmt(shape)}]`;
  out(summary);
  if (netErrors === c.repeat) { out('COULD NOT MEASURE: every attempt was a network error'); return { code: 1, lines, summary }; }
  return { code: 0, lines, summary };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  runProbe(readConfig(process.argv.slice(2), process.env)).then((r) => process.exit(r.code));
}
