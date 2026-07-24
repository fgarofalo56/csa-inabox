/**
 * N3 — result-transport policy: the rule that decides when Loom's own grids
 * stop shipping JSON and start streaming Arrow, and the before/after
 * measurement that has to back the claim.
 */
import { describe, it, expect } from 'vitest';
import {
  chooseTransport,
  compareTransports,
  transportMs,
  arrowRowThreshold,
  DEFAULT_ARROW_ROW_THRESHOLD,
  DEFAULT_ARROW_CELL_THRESHOLD,
} from '../transport-policy';

describe('chooseTransport', () => {
  it('keeps a small result on JSON and says why', () => {
    const d = chooseTransport({ estimatedRows: 200, columns: 5 });
    expect(d.transport).toBe('json');
    expect(d.reason).toContain('below the 5,000-row Arrow threshold');
  });

  it('switches to Arrow at the row threshold', () => {
    const d = chooseTransport({ estimatedRows: DEFAULT_ARROW_ROW_THRESHOLD, columns: 3 });
    expect(d.transport).toBe('arrow');
    expect(d.reason).toContain('Arrow IPC');
  });

  it('switches to Arrow for a wide result even below the row threshold', () => {
    // 2,000 rows x 40 columns = 80,000 cells, past the 50,000-cell threshold.
    const d = chooseTransport({ estimatedRows: 2_000, columns: 40 });
    expect(d.transport).toBe('arrow');
    expect(d.reason).toContain('cells');
    expect(d.cellThreshold).toBe(DEFAULT_ARROW_CELL_THRESHOLD);
  });

  it('stays on JSON when the size is unknown rather than guessing', () => {
    const d = chooseTransport({ estimatedRows: null, columns: 10 });
    expect(d.transport).toBe('json');
    expect(d.reason).toContain('unknown');
  });

  it('honours an explicit override from the UI', () => {
    expect(chooseTransport({ estimatedRows: 10, force: 'arrow' }).transport).toBe('arrow');
    expect(chooseTransport({ estimatedRows: 1_000_000, force: 'json' }).transport).toBe('json');
  });

  it('respects a tuned threshold', () => {
    const d = chooseTransport({ estimatedRows: 800, columns: 2, rowThreshold: 500 });
    expect(d.transport).toBe('arrow');
    expect(d.rowThreshold).toBe(500);
  });
});

describe('arrowRowThreshold', () => {
  it('falls back to the code default for junk, and takes a valid override', () => {
    expect(arrowRowThreshold(undefined)).toBe(DEFAULT_ARROW_ROW_THRESHOLD);
    expect(arrowRowThreshold('')).toBe(DEFAULT_ARROW_ROW_THRESHOLD);
    expect(arrowRowThreshold('not-a-number')).toBe(DEFAULT_ARROW_ROW_THRESHOLD);
    expect(arrowRowThreshold('-5')).toBe(DEFAULT_ARROW_ROW_THRESHOLD);
    expect(arrowRowThreshold('250')).toBe(250);
    expect(arrowRowThreshold(1_000)).toBe(1_000);
  });
});

describe('measurement', () => {
  it('subtracts engine time so the comparison is about the TRANSPORT', () => {
    expect(transportMs({ transport: 'json', totalMs: 900, engineMs: 400, bytes: 1, rows: 1 })).toBe(500);
    // An engine slower than the wall clock (clock skew) can never go negative.
    expect(transportMs({ transport: 'arrow', totalMs: 100, engineMs: 400, bytes: 1, rows: 1 })).toBe(0);
  });

  it('produces a real before/after summary from two measured legs', () => {
    const cmp = compareTransports(
      { transport: 'json', totalMs: 1400, engineMs: 200, bytes: 8_400_000, rows: 120_000 },
      { transport: 'arrow', totalMs: 500, engineMs: 200, bytes: 2_100_000, rows: 120_000 },
    );
    expect(cmp.savedMs).toBe(900);
    expect(cmp.savedBytes).toBe(6_300_000);
    expect(cmp.summary).toContain('4.0× faster transport');
    expect(cmp.summary).toContain('75% fewer bytes');
    expect(cmp.summary).toContain('120,000 rows');
  });

  it('reports honestly when the candidate transport is NOT faster', () => {
    const cmp = compareTransports(
      { transport: 'json', totalMs: 300, engineMs: 100, bytes: 1_000, rows: 50 },
      { transport: 'arrow', totalMs: 700, engineMs: 100, bytes: 4_000, rows: 50 },
    );
    expect(cmp.savedMs).toBeLessThan(0);
    expect(cmp.summary).toContain('slower transport');
    expect(cmp.summary).toContain('more bytes');
  });
});
