import { describe, it, expect } from 'vitest';
import {
  LIVE, parseAsOf, parseAsOfLenient, TimeMachineError, isLive, asOfLabel,
  serializeAsOf, asOfCacheToken, resolveTimeTravel, backendForOntologySourceKind,
  applySqlTableSuffix, applyKqlFilter, withAsOfParam,
  type TimeTravelClause, type TimeTravelGate,
} from '../time-machine';

describe('time-machine — parseAsOf', () => {
  it('treats empty / live / now / null as live', () => {
    for (const v of ['', '  ', 'live', 'LIVE', 'now', 'latest', null, undefined]) {
      expect(parseAsOf(v as string)).toEqual(LIVE);
    }
  });

  it('parses a full ISO instant, normalizing to UTC ISO', () => {
    const spec = parseAsOf('2026-07-01T17:00:00Z');
    expect(spec).toEqual({ kind: 'timestamp', iso: '2026-07-01T17:00:00.000Z' });
  });

  it('parses a bare calendar date to UTC midnight', () => {
    expect(parseAsOf('2026-07-01')).toEqual({ kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' });
  });

  it('parses version forms (v:42, version=42, v42, number)', () => {
    expect(parseAsOf('v:42')).toEqual({ kind: 'version', version: 42 });
    expect(parseAsOf('version=7')).toEqual({ kind: 'version', version: 7 });
    expect(parseAsOf('v12')).toEqual({ kind: 'version', version: 12 });
    expect(parseAsOf(3)).toEqual({ kind: 'version', version: 3 });
  });

  it('throws TimeMachineError on malformed non-empty input', () => {
    for (const bad of ['garbage', '2026-13-99', 'v:-1', 'yesterday', -5]) {
      expect(() => parseAsOf(bad as string)).toThrow(TimeMachineError);
    }
  });

  it('parseAsOfLenient never throws — bad input degrades to live', () => {
    expect(parseAsOfLenient('garbage')).toEqual(LIVE);
    expect(parseAsOfLenient('2026-07-01T00:00:00Z')).toEqual({ kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' });
  });

  it('isLive / label / serialize / cacheToken round-trip', () => {
    expect(isLive(LIVE)).toBe(true);
    expect(isLive(null)).toBe(true);
    expect(isLive({ kind: 'version', version: 1 })).toBe(false);
    expect(asOfLabel(LIVE)).toBe('Live');
    expect(asOfLabel({ kind: 'version', version: 9 })).toBe('as of v9');
    expect(serializeAsOf(LIVE)).toBe('');
    expect(serializeAsOf({ kind: 'version', version: 9 })).toBe('v:9');
    expect(serializeAsOf({ kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' })).toBe('2026-07-01T00:00:00.000Z');
    expect(asOfCacheToken(LIVE)).toBe('live');
    expect(asOfCacheToken({ kind: 'version', version: 9 })).toBe('v:9');
    expect(asOfCacheToken({ kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' })).toBe('t:2026-07-01T00:00:00.000Z');
  });
});

describe('time-machine — resolveTimeTravel per backend', () => {
  const ts = parseAsOf('2026-07-01T17:00:00Z'); // {timestamp}
  const ver = parseAsOf('v:42');                 // {version:42}

  it('live is a supported no-op on every backend (byte-identical queries)', () => {
    for (const b of ['delta', 'synapse-serverless-delta', 'synapse-temporal', 'adx', 'dax'] as const) {
      const r = resolveTimeTravel(b, LIVE) as TimeTravelClause;
      expect(r.supported).toBe(true);
      expect(r.noop).toBe(true);
      expect(r.sqlTableSuffix).toBe('');
      expect(r.kqlFilter).toBe('');
    }
  });

  it('delta → TIMESTAMP AS OF and VERSION AS OF', () => {
    const t = resolveTimeTravel('delta', ts) as TimeTravelClause;
    expect(t.supported).toBe(true);
    expect(t.sqlTableSuffix).toBe(" TIMESTAMP AS OF '2026-07-01T17:00:00.000Z'");
    const v = resolveTimeTravel('delta', ver) as TimeTravelClause;
    expect(v.sqlTableSuffix).toBe(' VERSION AS OF 42');
  });

  it('synapse-temporal → FOR SYSTEM_TIME AS OF; version is honest-gated', () => {
    const t = resolveTimeTravel('synapse-temporal', ts) as TimeTravelClause;
    expect(t.sqlTableSuffix).toBe(" FOR SYSTEM_TIME AS OF '2026-07-01T17:00:00.000Z'");
    const v = resolveTimeTravel('synapse-temporal', ver) as TimeTravelGate;
    expect(v.supported).toBe(false);
    expect(v.code).toBe('temporal_needs_timestamp');
  });

  it('adx → ingestion_time() filter; version is honest-gated', () => {
    const t = resolveTimeTravel('adx', ts) as TimeTravelClause;
    expect(t.kqlFilter).toBe('| where ingestion_time() <= datetime(2026-07-01T17:00:00.000Z)');
    const v = resolveTimeTravel('adx', ver) as TimeTravelGate;
    expect(v.supported).toBe(false);
    expect(v.code).toBe('adx_needs_timestamp');
  });

  it('serverless-delta and dax honest-gate (no inline time-travel), naming the remediation', () => {
    const s = resolveTimeTravel('synapse-serverless-delta', ts) as TimeTravelGate;
    expect(s.supported).toBe(false);
    expect(s.code).toBe('serverless_delta_no_time_travel');
    expect(s.reason).toMatch(/Databricks SQL|ADX|temporal/);
    const d = resolveTimeTravel('dax', ts) as TimeTravelGate;
    expect(d.supported).toBe(false);
    expect(d.code).toBe('dax_no_time_travel');
  });
});

describe('time-machine — source-kind map + clause application', () => {
  it('maps ontology source kinds to backends', () => {
    expect(backendForOntologySourceKind('lakehouse-table')).toBe('synapse-serverless-delta');
    expect(backendForOntologySourceKind('warehouse-table')).toBe('synapse-temporal');
    expect(backendForOntologySourceKind('kql')).toBe('adx');
    expect(backendForOntologySourceKind('semantic-measure')).toBe('dax');
    expect(backendForOntologySourceKind('shortcut')).toBe('synapse-serverless-delta');
  });

  it('applySqlTableSuffix appends only for a supported clause; no-op passes through', () => {
    const live = resolveTimeTravel('delta', LIVE);
    expect(applySqlTableSuffix('[dbo].[t]', live)).toBe('[dbo].[t]');
    const t = resolveTimeTravel('delta', parseAsOf('2026-07-01'));
    expect(applySqlTableSuffix('[dbo].[t]', t)).toBe("[dbo].[t] TIMESTAMP AS OF '2026-07-01T00:00:00.000Z'");
    // A gate never mutates the query.
    const gated = resolveTimeTravel('synapse-serverless-delta', parseAsOf('2026-07-01'));
    expect(applySqlTableSuffix('[dbo].[t]', gated)).toBe('[dbo].[t]');
  });

  it('applyKqlFilter inserts the filter between table and the rest of the pipe', () => {
    const t = resolveTimeTravel('adx', parseAsOf('2026-07-01T00:00:00Z'));
    expect(applyKqlFilter('Events', '| take 100', t))
      .toBe('Events | where ingestion_time() <= datetime(2026-07-01T00:00:00.000Z) | take 100');
    const live = resolveTimeTravel('adx', LIVE);
    expect(applyKqlFilter('Events', '| take 100', live)).toBe('Events | take 100');
  });

  it('withAsOfParam appends only for a non-live spec, preserving existing query', () => {
    expect(withAsOfParam('/api/x', LIVE)).toBe('/api/x');
    expect(withAsOfParam('/api/x', { kind: 'version', version: 42 })).toBe('/api/x?asOf=v%3A42');
    expect(withAsOfParam('/api/x?top=5', { kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' }))
      .toBe('/api/x?top=5&asOf=2026-07-01T00%3A00%3A00.000Z');
  });
});
