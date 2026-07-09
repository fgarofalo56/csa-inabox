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
