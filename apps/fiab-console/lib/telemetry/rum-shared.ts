/**
 * RUM1 — shared (isomorphic) types + PII scrubbing for client-side real-user
 * monitoring (loom-next-level ws-verification-dr.md RUM1).
 *
 * PURE data + functions with ZERO server-only imports: the browser capture
 * module (rum.ts, 'use client') scrubs BEFORE anything leaves the page, and
 * the BFF ingest route re-runs the SAME scrub server-side (defense in depth)
 * before forwarding to App Insights. No PII by construction:
 *   - surfaces are ROUTE SHAPES, never raw URLs — id-like path segments
 *     (GUIDs, hex ids, numerics, long random ids, anything @-ish) collapse to
 *     ':id', and query strings / fragments are dropped entirely;
 *   - free text (error name/message) is scrubbed of emails, GUIDs, JWTs,
 *     bearer tokens and URL query strings, then length-capped;
 *   - beacons carry NO user identifier — the App Insights rows are keyed by
 *     surface + boundary only (the ingest route authenticates the session but
 *     never forwards who it was).
 */

// ── Wire caps (ingest route enforces; client respects) ──────────────────────

/** Max beacon items per POST body. */
export const RUM_MAX_ITEMS = 30;
/** Max POST body size in bytes (bigger → 413). */
export const RUM_MAX_BODY_BYTES = 64_000;
/** Max error beacons a single browser session may emit (client-side cap). */
export const RUM_MAX_ERRORS_PER_SESSION = 10;
/** The ai.cloud.role every RUM envelope carries — the /admin/rum queries and
 * any LAW consumer filter on exactly this. */
export const RUM_CLOUD_ROLE = 'loom-console-browser';
/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const RUM_FLAG_ID = 'rum1-client-telemetry';

// ── Beacon item types ───────────────────────────────────────────────────────

export type RumKind = 'pageLoad' | 'routeChange' | 'error' | 'vitals';

interface RumBase {
  kind: RumKind;
  /** Scrubbed route shape, e.g. `/items/data-pipeline/:id` — NEVER a raw URL. */
  surface: string;
  /** ISO-8601 client timestamp. */
  at: string;
}

/** A HARD page load with REAL Navigation Timing durations (ms). */
export interface RumPageLoadItem extends RumBase {
  kind: 'pageLoad';
  /** navigationStart → loadEventEnd (or entry.duration). */
  totalMs: number;
  /** fetchStart → connectEnd (DNS + TCP + TLS). */
  networkMs?: number;
  /** requestStart → responseStart (server think + first byte). */
  sendMs?: number;
  /** responseStart → responseEnd (payload receive). */
  receiveMs?: number;
  /** responseEnd → domComplete (parse + render). */
  processingMs?: number;
}

/** A soft (App Router) route change — a view count, no fabricated duration. */
export interface RumRouteChangeItem extends RumBase {
  kind: 'routeChange';
}

/** An unhandled browser error / promise rejection (scrubbed). */
export interface RumErrorItem extends RumBase {
  kind: 'error';
  name: string;
  message: string;
  source?: 'window' | 'unhandledrejection';
}

/** Web-Vitals snapshot for one page view (sent once, on pagehide). */
export interface RumVitalsItem extends RumBase {
  kind: 'vitals';
  lcpMs?: number;
  fcpMs?: number;
  ttfbMs?: number;
  /** Cumulative Layout Shift (unitless, 0..~10). */
  cls?: number;
  /** Interaction-to-Next-Paint approximation: worst event duration (ms). */
  inpMs?: number;
}

export type RumItem = RumPageLoadItem | RumRouteChangeItem | RumErrorItem | RumVitalsItem;

// ── Surface scrubbing (route params → ':id') ───────────────────────────────

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;
const DIGIT_RUN_RE = /\d{6,}/;

/** True when a path segment looks like an id / user-supplied value, not a
 * static route literal. */
export function isIdLikeSegment(seg: string): boolean {
  if (!seg) return false;
  if (seg.length > 64) return true;
  if (GUID_RE.test(seg)) return true;
  if (HEX_ID_RE.test(seg)) return true;
  if (NUMERIC_RE.test(seg)) return true;
  if (DIGIT_RUN_RE.test(seg)) return true;
  if (seg.includes('@') || seg.toLowerCase().includes('%40')) return true;
  // Long mixed alphanumeric (random ids like base64url / nanoid): ≥20 chars
  // containing both letters and digits.
  if (seg.length >= 20 && /[0-9]/.test(seg) && /[a-z]/i.test(seg)) return true;
  return false;
}

/**
 * Collapse a browser pathname to its ROUTE SHAPE: strip origin/query/fragment,
 * replace id-like segments with ':id', bound depth + length. Deterministic and
 * pure — unit-tested; the server re-runs it on every inbound surface string.
 */
export function scrubSurfacePath(rawPath: string): string {
  let p = String(rawPath || '');
  // Strip origin if a full URL slipped in.
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  // Drop query + fragment wholesale (never inspect them).
  p = p.split('?')[0].split('#')[0];
  const segs = p
    .split('/')
    .filter(Boolean)
    .slice(0, 8)
    .map((seg) => (isIdLikeSegment(seg) ? ':id' : seg));
  const out = `/${segs.join('/')}`;
  return out.length > 200 ? out.slice(0, 200) : out;
}

// ── Free-text scrubbing (error names / messages) ────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const GUID_ANY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JWT_RE = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const BEARER_RE = /Bearer\s+[\w.~+/-]+=*/gi;
const URL_QUERY_RE = /\?[^\s"'<>]*/g;

/** Scrub emails / GUIDs / JWTs / bearer tokens / URL queries; cap length. */
export function scrubText(raw: unknown, max = 300): string {
  let s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  s = s
    .replace(JWT_RE, '[token]')
    .replace(BEARER_RE, 'Bearer [token]')
    .replace(EMAIL_RE, '[email]')
    .replace(GUID_ANY_RE, '[id]')
    .replace(URL_QUERY_RE, '?[query]');
  s = s.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Numeric sanitizers ──────────────────────────────────────────────────────

/** Clamp a millisecond duration to a sane range, else undefined. */
export function clampMs(v: unknown, maxMs = 10 * 60_000): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.round(n), maxMs);
}

/** Clamp a CLS-style unitless score, else undefined. */
export function clampScore(v: unknown, max = 10): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.round(n * 1000) / 1000, max);
}

/** Parse a 0–100 sample-rate string (LOOM_RUM_SAMPLE_RATE); default 100. */
export function parseSampleRate(raw: string | undefined | null): number {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, n));
}

// ── Batch validation (the ingest route's ONLY accepted shape) ───────────────

const ISO_AT_MAX_SKEW_MS = 24 * 3600_000;

function sanitizeAt(v: unknown): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  const now = Date.now();
  if (!Number.isFinite(t) || Math.abs(now - t) > ISO_AT_MAX_SKEW_MS) {
    return new Date(now).toISOString();
  }
  return new Date(t).toISOString();
}

/**
 * Validate + re-scrub an inbound batch. Unknown kinds and malformed items are
 * DROPPED (never an error — telemetry must not create failure modes); at most
 * {@link RUM_MAX_ITEMS} items survive. Every string field is re-scrubbed
 * server-side even though the client already scrubbed (defense in depth).
 */
export function parseRumBatch(raw: unknown): RumItem[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] })?.items) ? (raw as { items: unknown[] }).items : null;
  if (!arr) return [];
  const out: RumItem[] = [];
  for (const it of arr) {
    if (out.length >= RUM_MAX_ITEMS) break;
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const surface = scrubSurfacePath(typeof o.surface === 'string' ? o.surface : '');
    const at = sanitizeAt(o.at);
    switch (o.kind) {
      case 'pageLoad': {
        const totalMs = clampMs(o.totalMs);
        if (totalMs === undefined) continue;
        out.push({
          kind: 'pageLoad', surface, at, totalMs,
          networkMs: clampMs(o.networkMs),
          sendMs: clampMs(o.sendMs),
          receiveMs: clampMs(o.receiveMs),
          processingMs: clampMs(o.processingMs),
        });
        break;
      }
      case 'routeChange':
        out.push({ kind: 'routeChange', surface, at });
        break;
      case 'error': {
        const name = scrubText(o.name, 80) || 'Error';
        const message = scrubText(o.message, 300) || '(no message)';
        const source = o.source === 'unhandledrejection' ? 'unhandledrejection' : 'window';
        out.push({ kind: 'error', surface, at, name, message, source });
        break;
      }
      case 'vitals': {
        const item: RumVitalsItem = {
          kind: 'vitals', surface, at,
          lcpMs: clampMs(o.lcpMs),
          fcpMs: clampMs(o.fcpMs),
          ttfbMs: clampMs(o.ttfbMs),
          cls: clampScore(o.cls),
          inpMs: clampMs(o.inpMs),
        };
        if (
          item.lcpMs === undefined && item.fcpMs === undefined && item.ttfbMs === undefined &&
          item.cls === undefined && item.inpMs === undefined
        ) continue;
        out.push(item);
        break;
      }
      default:
        continue;
    }
  }
  return out;
}
