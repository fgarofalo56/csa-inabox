/**
 * RUM1 — server-side forwarding of browser RUM beacons to App Insights
 * (loom-next-level ws-verification-dr.md RUM1).
 *
 * Transport: the SAME App Insights resource the server-side OTel telemetry
 * ships to (lib/telemetry/app-insights.ts), reached through the classic
 * telemetry-envelope track API:
 *
 *   POST {IngestionEndpoint}/v2.1/track    body: JSON array of envelopes
 *
 * The IngestionEndpoint + InstrumentationKey come out of the ONE existing
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` — which is per-cloud by construction
 * (Gov connection strings carry `.us` ingestion endpoints), so both estates
 * work with zero cloud-endpoint plumbing here. Envelope types map to the
 * canonical App Insights browser tables in the workspace (LAW):
 *
 *   pageLoad    → PageviewPerformanceData → browserTimings / AppBrowserTimings
 *   routeChange → PageviewData            → pageViews      / AppPageViews
 *   error       → ExceptionData           → exceptions     / AppExceptions
 *   vitals      → EventData               → customEvents   / AppEvents
 *
 * Every envelope carries ai.cloud.role = 'loom-console-browser' (the filter
 * key for /admin/rum + any LAW consumer) and a `csa-loom.surface` property
 * (the SCRUBBED route shape — ground truth #14's missing dimension). NO user
 * identifier is ever forwarded (no oid, no upn, no session id) — RUM rows are
 * aggregate-only by construction.
 *
 * Honest gate (no-vaporware.md): when LOOM_RUM_ENABLED='false' or the
 * connection string is absent/unparseable this module is a SILENT NO-OP (one
 * debug log) — capture costs nothing, nothing errors, per the RUM1 spec.
 */
import { RUM_CLOUD_ROLE, parseSampleRate, type RumItem } from './rum-shared';

// ── Config resolution ───────────────────────────────────────────────────────

export interface AiConnection {
  ikey: string;
  ingestionEndpoint: string;
}

/**
 * Parse an App Insights connection string
 * (`InstrumentationKey=…;IngestionEndpoint=https://…;…`). Returns null when
 * either half is missing — the caller treats that as "RUM not configured".
 * Pure — unit-tested.
 */
export function parseAiConnectionString(cs: string | undefined | null): AiConnection | null {
  if (!cs || !cs.trim()) return null;
  const parts: Record<string, string> = {};
  for (const kv of cs.split(';')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  const ikey = parts['instrumentationkey'] || '';
  const ingestionEndpoint = (parts['ingestionendpoint'] || '').replace(/\/+$/, '');
  if (!ikey || !ingestionEndpoint) return null;
  return { ikey, ingestionEndpoint };
}

/**
 * RUM env posture: default-ON (loom_default_on_opt_out) — enabled unless
 * LOOM_RUM_ENABLED is explicitly 'false' — AND the shared App Insights
 * connection string is present + parseable. The FLAG0 runtime kill-switch
 * (`rum1-client-telemetry`) layers on top in the route, not here.
 */
export function isRumEnvEnabled(): boolean {
  const flag = (process.env.LOOM_RUM_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'false') return false;
  return parseAiConnectionString(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) !== null;
}

/** Session sample rate 0–100 from LOOM_RUM_SAMPLE_RATE (default 100). */
export function rumSampleRate(): number {
  return parseSampleRate(process.env.LOOM_RUM_SAMPLE_RATE);
}

// ── Envelope building (pure — unit-tested) ─────────────────────────────────

/** ms → App Insights duration literal `d.hh:mm:ss.fff`. */
export function msToAiDuration(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const msPart = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600) % 24;
  const d = Math.floor(totalSec / 86400);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d}.${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

interface AiEnvelope {
  name: string;
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: { baseType: string; baseData: Record<string, unknown> };
}

function baseProps(surface: string): Record<string, string> {
  return {
    'csa-loom.surface': surface,
    'csa-loom.boundary': process.env.CSA_LOOM_BOUNDARY || 'Unknown',
    'csa-loom.app': 'fiab-console',
  };
}

function envelope(
  ikey: string,
  type: 'Pageview' | 'PageviewPerformance' | 'Exception' | 'Event',
  baseType: string,
  time: string,
  surface: string,
  baseData: Record<string, unknown>,
): AiEnvelope {
  return {
    name: `Microsoft.ApplicationInsights.${type}`,
    time,
    iKey: ikey,
    tags: {
      'ai.cloud.role': RUM_CLOUD_ROLE,
      'ai.operation.name': surface,
      'ai.device.type': 'Browser',
      'ai.internal.sdkVersion': 'loom-rum:1.0',
    },
    data: { baseType, baseData },
  };
}

/** Map validated RUM items to App Insights envelopes. Pure — unit-tested. */
export function buildRumEnvelopes(items: RumItem[], ikey: string): AiEnvelope[] {
  const out: AiEnvelope[] = [];
  for (const it of items) {
    const props = baseProps(it.surface);
    switch (it.kind) {
      case 'pageLoad':
        out.push(envelope(ikey, 'PageviewPerformance', 'PageviewPerformanceData', it.at, it.surface, {
          ver: 2,
          name: it.surface,
          url: it.surface,
          duration: msToAiDuration(it.totalMs),
          perfTotal: msToAiDuration(it.totalMs),
          networkConnect: msToAiDuration(it.networkMs ?? 0),
          sentRequest: msToAiDuration(it.sendMs ?? 0),
          receivedResponse: msToAiDuration(it.receiveMs ?? 0),
          domProcessing: msToAiDuration(it.processingMs ?? 0),
          properties: props,
        }));
        break;
      case 'routeChange':
        out.push(envelope(ikey, 'Pageview', 'PageviewData', it.at, it.surface, {
          ver: 2,
          name: it.surface,
          url: it.surface,
          properties: { ...props, 'csa-loom.navigation': 'soft' },
        }));
        break;
      case 'error':
        out.push(envelope(ikey, 'Exception', 'ExceptionData', it.at, it.surface, {
          ver: 2,
          severityLevel: 3,
          exceptions: [{
            typeName: it.name,
            message: it.message,
            hasFullStack: false,
            parsedStack: [],
          }],
          properties: { ...props, 'csa-loom.errorSource': it.source || 'window' },
        }));
        break;
      case 'vitals': {
        const measurements: Record<string, number> = {};
        if (it.lcpMs !== undefined) measurements.lcpMs = it.lcpMs;
        if (it.fcpMs !== undefined) measurements.fcpMs = it.fcpMs;
        if (it.ttfbMs !== undefined) measurements.ttfbMs = it.ttfbMs;
        if (it.cls !== undefined) measurements.cls = it.cls;
        if (it.inpMs !== undefined) measurements.inpMs = it.inpMs;
        out.push(envelope(ikey, 'Event', 'EventData', it.at, it.surface, {
          ver: 2,
          name: 'loom-rum-vitals',
          properties: props,
          measurements,
        }));
        break;
      }
    }
  }
  return out;
}

// ── Forwarding ──────────────────────────────────────────────────────────────

let warnedDisabled = false;

/**
 * Forward a validated batch to App Insights. Silent no-op when RUM is not
 * configured (per the RUM1 spec); bounded (5s) so a slow ingestion endpoint
 * can never stall the BFF; throws only on a real transport error so the route
 * can log it (the route still answers 200 — telemetry loss is never a caller
 * failure).
 */
export async function postRumBatch(
  items: RumItem[],
): Promise<{ sent: number; skipped?: 'not-configured' | 'empty' }> {
  if (!items.length) return { sent: 0, skipped: 'empty' };
  if (!isRumEnvEnabled()) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      // eslint-disable-next-line no-console
      console.debug(
        '[rum] client RUM forwarding disabled — set LOOM_RUM_ENABLED (default true) and ' +
          'APPLICATIONINSIGHTS_CONNECTION_STRING (modules/admin-plane/main.bicep monitoring module) ' +
          'to ship browser page-load timings, Web Vitals and client errors to App Insights.',
      );
    }
    return { sent: 0, skipped: 'not-configured' };
  }
  const conn = parseAiConnectionString(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)!;
  const envelopes = buildRumEnvelopes(items, conn.ikey);
  const res = await fetch(`${conn.ingestionEndpoint}/v2.1/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelopes),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`App Insights track ${res.status}: ${body.slice(0, 200)}`);
  }
  return { sent: envelopes.length };
}
