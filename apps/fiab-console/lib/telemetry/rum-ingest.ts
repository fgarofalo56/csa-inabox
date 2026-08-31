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
 *
 * `sent` counts envelopes App Insights ACCEPTED, not envelopes posted (#3735). `rejected`
 * is present only when some were refused; see the 206 note in the body.
 */
export async function postRumBatch(
  items: RumItem[],
): Promise<{ sent: number; rejected?: number; skipped?: 'not-configured' | 'empty' }> {
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
  // `res.ok` COVERS 206, AND 206 IS HOW BREEZE SAYS "I DROPPED SOME OF THAT" (#3735).
  //
  // The classic track endpoint answers 200 when every envelope is accepted and 206 Partial
  // Content when only some are — with a body naming the rejected INDEXES and why. `res.ok`
  // is true for the whole 2xx range, so the previous shape returned
  // `{ sent: envelopes.length }` on a 206 and reported every envelope as shipped whether
  // it was or not. That is a message asserting what the code never established
  // (deploy-integrity.md R7), and it is silent in exactly the direction that hides a
  // partial ingestion failure.
  //
  // WHY THIS IS HERE RATHER THAN IN A LATER PR. #3735 reports `/admin/rum` showing
  // PAGE LOADS 0 and ROUTE CHANGES 0 in the same 24h window that Web Vitals reports 55
  // sampled page views — three independent KQL queries over one `timespan`, three client
  // paths behind one `install()` gate, and a self-contradictory answer. A per-envelope-TYPE
  // rejection (PageviewPerformanceData / PageviewData refused, EventData accepted) produces
  // precisely that shape, and with `res.ok` swallowing 206 there was nowhere for it to
  // surface. THIS IS NOT A ROOT-CAUSE CLAIM: it is one candidate of several the issue
  // lists, and it has NOT been confirmed against Log Analytics — no estate call was made.
  // What this change does is make the case observable instead of silent, so the next
  // occurrence is diagnosable rather than a second investigation from zero.
  const accepted = await readAcceptedCount(res, envelopes.length);
  if (accepted.rejected > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rum] App Insights accepted ${accepted.received - accepted.rejected}/${accepted.received} envelope(s) `
        + `(HTTP ${res.status}). REJECTED: ${accepted.reasons.join('; ') || 'no per-item reason supplied'}. `
        + 'Browser telemetry for the rejected kinds will be MISSING from /admin/rum — the panel will read 0, '
        + 'which is not the same as "nobody loaded a page".',
    );
  }
  return { sent: envelopes.length - accepted.rejected, rejected: accepted.rejected || undefined };
}

/**
 * Read Breeze's per-item accounting off a track response.
 *
 * Total over every response shape: a 200 with no body, a 206 with the documented
 * `{ itemsReceived, itemsAccepted, errors: [{ index, statusCode, message }] }`, and a body
 * that is not JSON at all. When it cannot tell, it says nothing was rejected rather than
 * inventing a number — the caller's warning must not fire on a response this function
 * failed to parse (R7 again, one level down).
 */
async function readAcceptedCount(
  res: Response,
  sentCount: number,
): Promise<{ received: number; rejected: number; reasons: string[] }> {
  if (res.status === 200) return { received: sentCount, rejected: 0, reasons: [] };
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { received: sentCount, rejected: 0, reasons: [] };
  }
  const received = Number.isFinite(body?.itemsReceived) ? Number(body.itemsReceived) : sentCount;
  const acceptedCount = Number.isFinite(body?.itemsAccepted) ? Number(body.itemsAccepted) : received;
  const rejected = Math.max(0, received - acceptedCount);
  const reasons = Array.isArray(body?.errors)
    ? body.errors
        .slice(0, 5)
        .map((e: any) => `#${e?.index} ${e?.statusCode ?? '?'} ${String(e?.message ?? '').slice(0, 120)}`)
    : [];
  return { received, rejected, reasons };
}
