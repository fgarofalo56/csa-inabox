/**
 * RUM1 — App Insights envelope-mapping unit tests (rum-ingest.ts).
 * Pins the connection-string parse (per-cloud by construction), the AI
 * duration literal, the envelope⇄table mapping, and that NO user identifier
 * ever appears in an envelope.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildRumEnvelopes,
  isRumEnvEnabled,
  msToAiDuration,
  parseAiConnectionString,
  postRumBatch,
  rumSampleRate,
} from '../rum-ingest';
import { RUM_CLOUD_ROLE, type RumItem } from '../rum-shared';

const COMM_CS =
  'InstrumentationKey=0f8fad5b-d9cb-469f-a165-70867728950e;IngestionEndpoint=https://eastus2-3.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/';
const GOV_CS =
  'InstrumentationKey=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee;IngestionEndpoint=https://usgovvirginia-1.in.applicationinsights.azure.us/';

afterEach(() => {
  delete process.env.LOOM_RUM_ENABLED;
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  delete process.env.LOOM_RUM_SAMPLE_RATE;
});

describe('parseAiConnectionString', () => {
  it('parses commercial + gov strings (endpoint per-cloud by construction)', () => {
    expect(parseAiConnectionString(COMM_CS)).toEqual({
      ikey: '0f8fad5b-d9cb-469f-a165-70867728950e',
      ingestionEndpoint: 'https://eastus2-3.in.applicationinsights.azure.com',
    });
    expect(parseAiConnectionString(GOV_CS)?.ingestionEndpoint).toBe(
      'https://usgovvirginia-1.in.applicationinsights.azure.us',
    );
  });

  it('returns null when either half is missing', () => {
    expect(parseAiConnectionString('')).toBeNull();
    expect(parseAiConnectionString(undefined)).toBeNull();
    expect(parseAiConnectionString('InstrumentationKey=x')).toBeNull();
    expect(parseAiConnectionString('IngestionEndpoint=https://x')).toBeNull();
  });
});

describe('isRumEnvEnabled / rumSampleRate', () => {
  it('default-ON when the connection string is present; LOOM_RUM_ENABLED=false opts out', () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = COMM_CS;
    expect(isRumEnvEnabled()).toBe(true);
    process.env.LOOM_RUM_ENABLED = 'false';
    expect(isRumEnvEnabled()).toBe(false);
  });

  it('silent no-op (disabled) without a connection string', () => {
    process.env.LOOM_RUM_ENABLED = 'true';
    expect(isRumEnvEnabled()).toBe(false);
  });

  it('sample rate rides LOOM_RUM_SAMPLE_RATE (default 100)', () => {
    expect(rumSampleRate()).toBe(100);
    process.env.LOOM_RUM_SAMPLE_RATE = '10';
    expect(rumSampleRate()).toBe(10);
  });
});

describe('msToAiDuration', () => {
  it('formats d.hh:mm:ss.fff', () => {
    expect(msToAiDuration(0)).toBe('0.00:00:00.000');
    expect(msToAiDuration(812)).toBe('0.00:00:00.812');
    expect(msToAiDuration(61_500)).toBe('0.00:01:01.500');
    expect(msToAiDuration(3_600_000 + 1)).toBe('0.01:00:00.001');
  });
});

describe('buildRumEnvelopes', () => {
  const at = '2026-07-22T12:00:00.000Z';
  const items: RumItem[] = [
    { kind: 'pageLoad', surface: '/browse', at, totalMs: 812, networkMs: 20, sendMs: 120, receiveMs: 40, processingMs: 500 },
    { kind: 'routeChange', surface: '/admin/rum', at },
    { kind: 'error', surface: '/items/x/:id', at, name: 'TypeError', message: 'boom', source: 'window' },
    { kind: 'vitals', surface: '/browse', at, lcpMs: 1500, cls: 0.02 },
  ];

  it('maps kinds to the canonical AI browser tables', () => {
    const envs = buildRumEnvelopes(items, 'ikey-1');
    expect(envs.map((e) => e.data.baseType)).toEqual([
      'PageviewPerformanceData', // → browserTimings / AppBrowserTimings
      'PageviewData',            // → pageViews / AppPageViews
      'ExceptionData',           // → exceptions / AppExceptions
      'EventData',               // → customEvents / AppEvents
    ]);
    for (const e of envs) {
      expect(e.iKey).toBe('ikey-1');
      expect(e.time).toBe(at);
      expect(e.tags['ai.cloud.role']).toBe(RUM_CLOUD_ROLE);
    }
    const perf = envs[0].data.baseData as Record<string, unknown>;
    expect(perf.duration).toBe('0.00:00:00.812');
    expect(perf.name).toBe('/browse');
    const vit = envs[3].data.baseData as { name: string; measurements: Record<string, number> };
    expect(vit.name).toBe('loom-rum-vitals');
    expect(vit.measurements).toEqual({ lcpMs: 1500, cls: 0.02 });
  });

  it('carries the csa-loom.surface dimension and NO user identifier', () => {
    const envs = buildRumEnvelopes(items, 'ikey-1');
    const flat = JSON.stringify(envs);
    for (const e of envs) {
      const props = (e.data.baseData as { properties: Record<string, string> }).properties;
      expect(props['csa-loom.surface']).toBeTruthy();
    }
    expect(flat).not.toMatch(/oid|upn|userId|sessionId|authenticatedId/i);
  });
});

/**
 * #3735 — A PARTIAL INGESTION FAILURE MUST NOT REPORT AS A CLEAN SEND.
 *
 * `/admin/rum` shows PAGE LOADS 0 and ROUTE CHANGES 0 for the same 24h window in which
 * Web Vitals reports 55 sampled page views — three independent KQL queries over one
 * `timespan`, three client paths behind one `install()` gate, and an answer that
 * contradicts itself. One of the candidate mechanisms is a per-envelope-TYPE rejection at
 * ingestion: `PageviewPerformanceData` and `PageviewData` refused while `EventData` is
 * accepted produces exactly 0 / 0 / 55.
 *
 * There was nowhere for that to surface. The Breeze track endpoint answers **206 Partial
 * Content** when it accepts only some envelopes, with a body naming the rejected indexes —
 * and `res.ok` is true across the whole 2xx range, so `postRumBatch` returned
 * `{ sent: envelopes.length }` and reported every envelope as shipped regardless.
 *
 * ROOT CAUSE IS NOT CLAIMED. No Log Analytics query was run and no estate call was made,
 * here or anywhere in this change; #3735's own acceptance criteria (a live receipt showing
 * consistent counts) are NOT met and the issue stays open. What these specs pin is the
 * narrower, checkable thing: the code no longer asserts an outcome it did not establish
 * (deploy-integrity.md R7), so the next occurrence is diagnosable instead of silent.
 */
describe('#3735 — postRumBatch reports what App Insights ACCEPTED', () => {
  const CS = COMM_CS;
  const one: RumItem[] = [
    { kind: 'vitals', at: '2026-08-01T00:00:00.000Z', surface: '/browse', lcpMs: 1500 } as RumItem,
    { kind: 'routeChange', at: '2026-08-01T00:00:00.000Z', surface: '/browse' } as RumItem,
  ];

  afterEach(() => { vi.restoreAllMocks(); });

  it('EMBEDDED CONTROL: a 200 reports every envelope as sent', () => {
    // Without this, "it counts rejections" is also satisfiable by a function that reports
    // everything as rejected, or that never sends at all.
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ itemsReceived: 2, itemsAccepted: 2, errors: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as any,
    );
    return postRumBatch(one).then((r) => {
      expect(r.sent).toBe(2);
      expect(r.rejected).toBeUndefined();
    });
  });

  it('a 206 with a rejected envelope is NOT reported as a clean send', async () => {
    // The exact shape that could produce 0 loads / 0 route changes / 55 vitals: the
    // PageviewData envelope refused, the EventData one accepted.
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          itemsReceived: 2,
          itemsAccepted: 1,
          errors: [{ index: 1, statusCode: 400, message: 'Invalid instrumentation key' }],
        }),
        { status: 206, headers: { 'content-type': 'application/json' } },
      ) as any,
    );

    const r = await postRumBatch(one);

    expect(r.sent).toBe(1);
    expect(r.rejected).toBe(1);
    // …and it SAYS so, naming the per-item reason. A count nobody reads is not an
    // improvement over a wrong count.
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/accepted 1\/2/);
    expect(msg).toMatch(/Invalid instrumentation key/);
    expect(msg).toMatch(/not the same as "nobody loaded a page"/);
  });

  it('a 206 whose body is UNREADABLE claims no rejections rather than inventing them', async () => {
    // R7 one level down: the warning must not fire on a response this code failed to
    // parse. "I could not tell" is not "one was rejected".
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<html>gateway</html>', { status: 206, headers: { 'content-type': 'text/html' } }) as any,
    );

    const r = await postRumBatch(one);

    expect(r.sent).toBe(2);
    expect(r.rejected).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a real transport failure still throws, unchanged', async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 503 }) as any,
    );
    await expect(postRumBatch(one)).rejects.toThrow(/App Insights track 503/);
  });

  it('stays a silent no-op when RUM is not configured', async () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    const f = vi.spyOn(global, 'fetch');
    const r = await postRumBatch(one);
    expect(r).toEqual({ sent: 0, skipped: 'not-configured' });
    expect(f).not.toHaveBeenCalled();
  });
});
