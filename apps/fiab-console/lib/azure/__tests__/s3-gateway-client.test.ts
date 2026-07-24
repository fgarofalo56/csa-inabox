/**
 * N8 lab 3 — S3-compatible ADLS gateway client tests.
 *
 * Honest-gate contract: unset → the config gate fires and s3GatewayInfo carries
 * the gate + the native (no-gateway) path but NO fabricated endpoint; set → the
 * real endpoint + connect snippets are returned. Pure (no Azure SDK) — the
 * client only reads env + the cloud DFS suffix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  s3GatewayConfigGate,
  isS3GatewayConfigured,
  s3GatewayInfo,
  S3_GATEWAY_GATE_ID,
} from '../s3-gateway-client';

const ORIG = process.env.LOOM_S3_GATEWAY_URL;
afterEach(() => {
  if (ORIG === undefined) delete process.env.LOOM_S3_GATEWAY_URL;
  else process.env.LOOM_S3_GATEWAY_URL = ORIG;
});

describe('s3-gateway-client — honest gate when unset', () => {
  it('gates on LOOM_S3_GATEWAY_URL and fabricates no endpoint', () => {
    delete process.env.LOOM_S3_GATEWAY_URL;
    expect(isS3GatewayConfigured()).toBe(false);
    expect(s3GatewayConfigGate()).toEqual({ missing: 'LOOM_S3_GATEWAY_URL' });

    const info = s3GatewayInfo();
    expect(info.configured).toBe(false);
    expect(info.endpoint).toBeNull();
    expect(info.snippets).toEqual([]);
    expect(info.gate).toEqual({ missing: ['LOOM_S3_GATEWAY_URL'] });
    // The native no-gateway path is ALWAYS present — the surface is useful even
    // without a gateway (points at the Iceberg REST Catalog + abfss path).
    expect(info.nativePath.abfssExample).toMatch(/^abfss:\/\//);
    expect(info.nativePath.icebergCatalogNote).toMatch(/Iceberg REST Catalog/i);
    expect(S3_GATEWAY_GATE_ID).toBe('svc-s3-gateway');
  });
});

describe('s3-gateway-client — real endpoint + snippets when set', () => {
  it('returns the configured endpoint and per-engine connect snippets', () => {
    process.env.LOOM_S3_GATEWAY_URL = 's3-gateway.internal.example.net';
    expect(isS3GatewayConfigured()).toBe(true);

    const info = s3GatewayInfo();
    expect(info.configured).toBe(true);
    // scheme-normalized to https, no trailing slash.
    expect(info.endpoint).toBe('https://s3-gateway.internal.example.net');
    expect(info.gate).toBeUndefined();
    expect(info.snippets.length).toBeGreaterThan(0);
    const engines = info.snippets.map((s) => s.engine).join(' ');
    expect(engines).toMatch(/DuckDB/);
    expect(engines).toMatch(/Trino/);
    // The DuckDB snippet references the real endpoint host.
    const duck = info.snippets.find((s) => /DuckDB/.test(s.engine))!;
    expect(duck.snippet).toContain('s3-gateway.internal.example.net');
  });
});
