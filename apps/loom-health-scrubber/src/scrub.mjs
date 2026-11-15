// PHI scrubber core (LHDS W2-5): line scrubber, structured attribute / metric-label
// scrubbers, an OTLP-JSON walker, and a fail-closed line Transform stream.
// No dependencies. Rules live in ./rules.mjs.
import { Transform } from 'node:stream';
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
    out[k] = typeof v === 'string' ? (v.length > 128 ? REDACTED : scrubLine(v)) : v;
  }
  return out;
}

// ---- OTLP JSON (the collector/exporter wire shape) ------------------------------------
function anyValueToPlain(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(anyValueToPlain);
  return v;
}
function plainToAnyValue(orig, plain) {
  if (orig && 'stringValue' in orig) return { stringValue: plain };
  if (orig && 'arrayValue' in orig) {
    return { arrayValue: { values: (orig.arrayValue.values ?? []).map((o, i) => plainToAnyValue(o, plain[i])) } };
  }
  return orig;
}
function scrubKvList(list, labelMode) {
  const plain = {};
  for (const kv of list) plain[kv.key] = anyValueToPlain(kv.value);
  const clean = labelMode ? scrubMetricLabels(plain) : scrubAttributes(plain);
  return list.filter((kv) => kv.key in clean).map((kv) => ({ key: kv.key, value: plainToAnyValue(kv.value, clean[kv.key]) }));
}

/** Walk an OTLP/JSON document; attribute lists under metric data points / exemplars use the label allow-list. */
export function scrubOtlp(node, labelMode = false) {
  if (Array.isArray(node)) return node.map((n) => scrubOtlp(n, labelMode));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const mode = labelMode || k === 'dataPoints' || k === 'exemplars';
    if ((k === 'attributes' || k === 'filteredAttributes') && Array.isArray(v)) {
      out[k] = scrubKvList(v, mode);
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
  let discarding = false;
  const emit = (self, line) => {
    let res;
    try { res = scrub(line); } catch { res = ERROR_MARKER; }
    self.push(`${res}\n`);
  };
  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
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
      if (buf.length > 0 && !discarding) emit(this, buf);
      cb();
    },
  });
}
