/**
 * RUM1 — App Insights envelope-mapping unit tests (rum-ingest.ts).
 * Pins the connection-string parse (per-cloud by construction), the AI
 * duration literal, the envelope⇄table mapping, and that NO user identifier
 * ever appears in an envelope.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildRumEnvelopes,
  isRumEnvEnabled,
  msToAiDuration,
  parseAiConnectionString,
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
