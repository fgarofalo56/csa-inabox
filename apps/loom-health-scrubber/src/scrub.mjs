// PHI scrubber core (LHDS W2-5): line scrubber, structured attribute / metric-label
// scrubbers, an OTLP-JSON walker, and a fail-closed line Transform stream.
// No dependencies. Rules live in ./rules.mjs.
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  REDACTED, REDACTED_MESSAGE, QUERY_ALLOW, QUERY_SEGMENT, JSON_KEY_RULE, PHI_JSON_KEYS,
  REST_FAILURE_RULE, HAPI_ECHO_RULE, SHAPE_RULES, DROP_KEY, METRIC_LABEL_ALLOW,
} from './rules.mjs';

export const MAX_LINE_BYTES = 1024 * 1024;
export const OVERLONG_MARKER = '[SCRUBBER-DROPPED-OVERLONG-LINE]';
export const ERROR_MARKER = '[SCRUBBER-DROPPED-LINE-ON-ERROR]';

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

function tryDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/** Redact a bare query string ("a=1&b=2"): only allow-listed keys with a constrained value survive. */
export function scrubQueryText(query) {
  if (query === '') return query;
  const trailing = query.endsWith(',') ? ',' : '';
  const body = trailing ? query.slice(0, -1) : query;
  const out = body.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return REDACTED; // a bare token has no key to judge it by
    const rawKey = pair.slice(0, eq);
    const value = tryDecode(pair.slice(eq + 1));
    const key = tryDecode(rawKey);
    const shape = QUERY_ALLOW.get(key.toLowerCase());
    if (shape && shape.test(value)) return pair;
    return `${SAFE_KEY.test(key) ? key : REDACTED}=${REDACTED}`;
  });
  return out.join('&') + trailing;
}

/** Scrub one log line. Idempotent: scrubLine(scrubLine(x)) === scrubLine(x). */
export function scrubLine(line) {
  let s = String(line);
  s = s.replace(REST_FAILURE_RULE, (_m, head, code) => `${head}${code ? ` ${code}` : ''} ${REDACTED_MESSAGE}`);
  s = s.replace(HAPI_ECHO_RULE, `$1 ${REDACTED_MESSAGE}`);
  s = s.replace(QUERY_SEGMENT, (_m, intro, quote, q) => `${intro}${quote}${scrubQueryText(q)}`);
  s = s.replace(JSON_KEY_RULE, (_m, head) => `${head}"${REDACTED}"`);
  for (const [re, rep] of SHAPE_RULES) s = s.replace(re, rep);
  return s;
}

const ALWAYS_DROP_KEYS = new Set(['exception.message', 'exception.stacktrace']);
const BARE_PHI_KEYS = new Set(PHI_JSON_KEYS.map((k) => k.toLowerCase()));

function scrubValue(key, value) {
  if (typeof value === 'string') {
    if (key === 'url.query' || key === 'http.query') return scrubQueryText(value);
    if (!key.includes('.') && BARE_PHI_KEYS.has(key.toLowerCase())) return REDACTED;
    return scrubLine(value);
  }
  if (Array.isArray(value)) {
    if (!key.includes('.') && BARE_PHI_KEYS.has(key.toLowerCase())) return value.map(() => REDACTED);
    return value.map((v) => scrubValue(key, v));
  }
  if (value && typeof value === 'object') return scrubAttributes(value);
  return value;
}

/** Span / resource / event attributes: drop body-ish and exception-message keys, scrub the rest. */
export function scrubAttributes(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (DROP_KEY.test(k) || ALWAYS_DROP_KEYS.has(k)) continue;
    out[k] = scrubValue(k, v);
  }
  return out;
}

/** Metric labels: deny by default. Only allow-listed keys survive, with scrubbed short values. */
export function scrubMetricLabels(labels) {
  const out = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!METRIC_LABEL_ALLOW.has(k)) continue;
    if (typeof v === 'string') out[k] = v.length > 128 ? REDACTED : scrubLine(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ---- OTLP JSON (the collector/exporter wire shape) ------------------------------------
// Fail closed: an AnyValue whose type is not understood (bytesValue, a future type, an array
// holding anything unknown) makes scrubAnyValue return undefined and the attribute is DROPPED.
const SCALAR_KINDS = ['intValue', 'doubleValue', 'boolValue'];
function scrubString(attrName, s, labelMode) {
  if (labelMode) return s.length > 128 ? REDACTED : scrubLine(s);
  return scrubValue(attrName, s);
}
function scrubAnyValue(v, attrName, labelMode) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const kinds = Object.keys(v);
  if (kinds.length !== 1) return undefined;
  const [kind] = kinds;
  if (kind === 'stringValue') {
    return typeof v.stringValue === 'string' ? { stringValue: scrubString(attrName, v.stringValue, labelMode) } : undefined;
  }
  if (SCALAR_KINDS.includes(kind)) return { [kind]: v[kind] };
  if (kind === 'arrayValue') {
    const values = v.arrayValue?.values ?? [];
    if (!Array.isArray(values)) return undefined;
    const out = values.map((e) => scrubAnyValue(e, attrName, labelMode));
    return out.some((e) => e === undefined) ? undefined : { arrayValue: { values: out } };
  }
  if (kind === 'kvlistValue') {
    const values = v.kvlistValue?.values ?? [];
    return Array.isArray(values) ? { kvlistValue: { values: scrubKvList(values, labelMode) } } : undefined;
  }
  return undefined;
}
function scrubKvList(list, labelMode) {
  const out = [];
  for (const entry of list) {
    const name = entry && entry.key;
    if (typeof name !== 'string') continue;
    if (DROP_KEY.test(name) || ALWAYS_DROP_KEYS.has(name)) continue;
    if (labelMode && !METRIC_LABEL_ALLOW.has(name)) continue;
    const value = scrubAnyValue(entry.value, name, labelMode);
    if (value !== undefined) out.push({ key: name, value });
  }
  return out;
}

/**
 * Walk an OTLP/JSON document. Attribute lists under metric data points / exemplars use the
 * label allow-list; span/metric `name`, status `message` and log-record `body` are scrubbed.
 */
export function scrubOtlp(node, labelMode = false) {
  if (Array.isArray(node)) return node.map((n) => scrubOtlp(n, labelMode));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const mode = labelMode || k === 'dataPoints' || k === 'exemplars';
    if ((k === 'attributes' || k === 'filteredAttributes') && Array.isArray(v)) {
      out[k] = scrubKvList(v, mode);
    } else if (k === 'body' && v && typeof v === 'object') {
      out[k] = scrubAnyValue(v, 'body', false) ?? { stringValue: REDACTED };
    } else if ((k === 'name' || k === 'message') && typeof v === 'string') {
      out[k] = scrubLine(v);
    } else {
      out[k] = scrubOtlp(v, mode);
    }
  }
  return out;
}

// ---- stream ---------------------------------------------------------------------------
/** Transform: bytes in, scrubbed lines out. A line that cannot be scrubbed is DROPPED, never passed. */
export function createScrubTransform(scrub = scrubLine) {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  let discarding = false;
  const emit = (self, line) => {
    let res;
    try { res = scrub(line); } catch { res = ERROR_MARKER; }
    self.push(`${res}\n`);
  };
  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, cb) {
      buf += decoder.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (discarding) { discarding = false; continue; }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) this.push(`${OVERLONG_MARKER}\n`);
        else emit(this, line);
      }
      if (buf.length > MAX_LINE_BYTES) {
        if (!discarding) this.push(`${OVERLONG_MARKER}\n`);
        discarding = true;
        buf = '';
      }
      cb();
    },
    flush(cb) {
      buf += decoder.end();
      if (buf.length > 0 && !discarding) emit(this, buf);
      cb();
    },
  });
}
