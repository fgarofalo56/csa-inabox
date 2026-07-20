/**
 * authoring-errors — pre-flight topology lint behind the Eventstream docked
 * "Authoring errors" tab (Fabric parity: surface problems before publish).
 */
import { describe, it, expect } from 'vitest';
import { collectAuthoringErrors, authoringErrorCounts } from '../authoring-errors';

const empty = { sources: [], transforms: [], sinks: [] };

describe('collectAuthoringErrors — topology completeness', () => {
  it('flags a missing source and a missing destination', () => {
    const errs = collectAuthoringErrors(empty);
    const ids = errs.map((e) => e.id);
    expect(ids).toContain('topology-no-source');
    expect(ids).toContain('topology-no-sink');
    expect(errs.every((e) => e.severity === 'error')).toBe(true);
  });

  it('is clean for a complete, valid topology', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src', eventHubName: 'orders' }],
      transforms: [{ kind: 'filter', name: 'f', expression: 'x > 1' }],
      sinks: [{ kind: 'kusto', name: 'dst', table: 'Orders' }],
    });
    expect(errs).toHaveLength(0);
  });
});

describe('collectAuthoringErrors — node config', () => {
  it('flags a source missing its required field', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src' }],
      transforms: [],
      sinks: [{ kind: 'kusto', name: 'dst', table: 'T' }],
    });
    expect(errs.some((e) => e.id === 'source-0-eventhub-name' && e.severity === 'error')).toBe(true);
  });

  it('flags a KQL destination with no table', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src', eventHubName: 'h' }],
      transforms: [],
      sinks: [{ kind: 'kusto', name: 'dst' }],
    });
    expect(errs.some((e) => e.id === 'sink-0-kusto-table')).toBe(true);
  });

  it('errors on a join with no second source, warns on missing ON', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src', eventHubName: 'h' }],
      transforms: [{ kind: 'join', name: 'j' }],
      sinks: [{ kind: 'kusto', name: 'dst', table: 'T' }],
    });
    expect(errs.some((e) => e.id === 'transform-0-join-source' && e.severity === 'error')).toBe(true);
    expect(errs.some((e) => e.id === 'transform-0-join-on' && e.severity === 'warning')).toBe(true);
  });

  it('warns (not errors) on a filter with no WHERE', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src', eventHubName: 'h' }],
      transforms: [{ kind: 'filter', name: 'f' }],
      sinks: [{ kind: 'kusto', name: 'dst', table: 'T' }],
    });
    const f = errs.find((e) => e.id === 'transform-0-filter-expr');
    expect(f?.severity).toBe('warning');
  });
});

describe('ordering + counts', () => {
  it('orders errors before warnings', () => {
    const errs = collectAuthoringErrors({
      sources: [{ kind: 'eventhub', name: 'src' }], // error: missing hub name
      transforms: [{ kind: 'filter', name: 'f' }],  // warning: empty WHERE
      sinks: [{ kind: 'kusto', name: 'dst', table: 'T' }],
    });
    const firstWarnIdx = errs.findIndex((e) => e.severity === 'warning');
    const lastErrIdx = errs.map((e) => e.severity).lastIndexOf('error');
    expect(lastErrIdx).toBeLessThan(firstWarnIdx);
  });

  it('authoringErrorCounts tallies severities', () => {
    const counts = authoringErrorCounts(collectAuthoringErrors(empty));
    expect(counts).toEqual({ errors: 2, warnings: 0 });
  });
});

// ---- geospatial operators (geo-graph-ml GEO-1) ----
describe('geo operator lint', () => {
  const wrap = (transform: Record<string, unknown>) => collectAuthoringErrors({
    sources: [{ kind: 'eventhub', name: 'src', eventHubName: 'h' }],
    transforms: [transform],
    sinks: [{ kind: 'kusto', name: 'dst', table: 'T' }],
  });

  it('geo-point requires lat + lon columns', () => {
    const errs = wrap({ kind: 'geo-point', name: 'p' });
    expect(errs.some((e) => e.id === 'transform-0-geo-lat' && e.severity === 'error')).toBe(true);
    expect(errs.some((e) => e.id === 'transform-0-geo-lon' && e.severity === 'error')).toBe(true);
    expect(wrap({ kind: 'geo-point', name: 'p', latColumn: 'lat', lonColumn: 'lon' })
      .filter((e) => e.nodeType === 'transform')).toHaveLength(0);
  });

  it('geo-fence (inline) requires a point source and one valid fence', () => {
    const errs = wrap({ kind: 'geo-fence', name: 'g', fences: [] });
    expect(errs.some((e) => e.id === 'transform-0-geo-fence-latlon')).toBe(true);
    expect(errs.some((e) => e.id === 'transform-0-geo-fence-none')).toBe(true);
    const ok = wrap({
      kind: 'geo-fence', name: 'g', latColumn: 'lat', lonColumn: 'lon',
      fences: [{ name: 'z', vertices: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] }],
    });
    expect(ok.filter((e) => e.nodeType === 'transform')).toHaveLength(0);
  });

  it('geo-fence (reference) requires the reference input alias', () => {
    const errs = wrap({ kind: 'geo-fence', name: 'g', pointMode: 'column', pointColumn: 'pos', fenceSource: 'reference', fenceRefInput: '' });
    expect(errs.some((e) => e.id === 'transform-0-geo-fence-ref')).toBe(true);
  });

  it('geo-proximity stream mode requires the joined source + right point', () => {
    const errs = wrap({
      kind: 'geo-proximity', name: 'near', latColumn: 'lat', lonColumn: 'lon',
      proximityTarget: 'stream', thresholdValue: 100,
    });
    expect(errs.some((e) => e.id === 'transform-0-geo-prox-source')).toBe(true);
    expect(errs.some((e) => e.id === 'transform-0-geo-prox-right-latlon')).toBe(true);
  });

  it('geo-proximity requires a positive threshold', () => {
    const errs = wrap({
      kind: 'geo-proximity', name: 'near', latColumn: 'lat', lonColumn: 'lon',
      proximityTarget: 'static', staticLat: 1, staticLon: 2, thresholdValue: 0,
    });
    expect(errs.some((e) => e.id === 'transform-0-geo-prox-threshold' && e.severity === 'error')).toBe(true);
  });

  it('geo-aggregate warns (not errors) on missing region/aggregations', () => {
    const errs = wrap({ kind: 'geo-aggregate', name: 'agg', aggregates: [] });
    const region = errs.find((e) => e.id === 'transform-0-geo-agg-region');
    const aggs = errs.find((e) => e.id === 'transform-0-geo-agg-none');
    expect(region?.severity).toBe('warning');
    expect(aggs?.severity).toBe('warning');
  });
});
