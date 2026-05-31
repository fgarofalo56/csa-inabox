/**
 * KustoResultsGrid — vitest jsdom render + behavior tests.
 *
 * Exercises the rich KQL results grid the way a user drives the ADX web-UI
 * results grid: it renders REAL `{ columns, columnTypes, rows }` (the exact
 * shape `lib/azure/kusto-client.ts` returns from `executeQuery`), then asserts
 *   - all rows render,
 *   - clicking a column header sorts (type-aware, numeric not lexical),
 *   - the global search-in-grid box narrows the visible rows,
 *   - the CSV / TSV builders produce the right text (pure-fn assertions).
 *
 * No backend is faked — the grid is pure client-side over data already
 * returned (per .claude/rules/no-vaporware.md). The pure helpers are imported
 * directly so the CSV/sort assertions are deterministic, not DOM-scraped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  KustoResultsGrid,
  buildCsv,
  buildTsv,
  makeComparator,
  computeColumnStats,
  isNumericColumn,
  formatCell,
} from '../kusto-results-grid';

// A realistic small Kusto result: one string col + one numeric col.
const COLUMNS = ['City', 'Population'];
const COLUMN_TYPES = ['String', 'Int64'];
const ROWS: unknown[][] = [
  ['Seattle', 100],
  ['Austin', 20],
  ['Boston', 9],
];

function renderGrid(extra?: Partial<React.ComponentProps<typeof KustoResultsGrid>>) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <KustoResultsGrid columns={COLUMNS} columnTypes={COLUMN_TYPES} rows={ROWS} {...extra} />
    </FluentProvider>,
  );
}

// globals:false → no auto-cleanup; unmount each test explicitly.
afterEach(() => cleanup());

function bodyRowTexts(): string[][] {
  // The grid renders a <table>; the body is the only <rowgroup> without <th>.
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  // First row is the header (contains column-header cells); skip it.
  return rows.slice(1).map((r) =>
    within(r).getAllByRole('cell').map((c) => (c.textContent || '').trim()),
  );
}

describe('KustoResultsGrid — rendering', () => {
  it('renders every row and the readout', () => {
    renderGrid();
    const data = bodyRowTexts();
    expect(data).toHaveLength(3);
    // Cell text is present for all three cities.
    const flat = data.flat().join(' ');
    expect(flat).toContain('Seattle');
    expect(flat).toContain('Austin');
    expect(flat).toContain('Boston');
    // "Showing N … rows" readout.
    expect(screen.getByLabelText('row readout').textContent).toContain('3');
  });
});

describe('KustoResultsGrid — sort', () => {
  it('clicking the Population header sorts numerically ascending then descending', () => {
    renderGrid();
    const header = screen.getByLabelText('Sort by Population');

    // 1st click → ascending: 9, 20, 100 (numeric, NOT lexical "100" < "20").
    fireEvent.click(header);
    let popCol = bodyRowTexts().map((r) => r[1]);
    expect(popCol).toEqual(['9', '20', '100']);

    // 2nd click → descending.
    fireEvent.click(header);
    popCol = bodyRowTexts().map((r) => r[1]);
    expect(popCol).toEqual(['100', '20', '9']);

    // 3rd click → back to original (no sort): rows return to insertion order.
    fireEvent.click(header);
    const cityCol = bodyRowTexts().map((r) => r[0]);
    expect(cityCol).toEqual(['Seattle', 'Austin', 'Boston']);
    popCol = bodyRowTexts().map((r) => r[1]);
    expect(popCol).toEqual(['100', '20', '9']);
  });
});

describe('KustoResultsGrid — search-in-grid filter', () => {
  it('typing in the global search narrows the visible rows', () => {
    renderGrid();
    expect(bodyRowTexts()).toHaveLength(3);

    const search = screen.getByLabelText('Search in grid');
    fireEvent.change(search, { target: { value: 'aust' } });

    const data = bodyRowTexts();
    expect(data).toHaveLength(1);
    expect(data[0][0]).toBe('Austin');

    // Clearing restores all rows.
    fireEvent.change(search, { target: { value: '' } });
    expect(bodyRowTexts()).toHaveLength(3);
  });
});

describe('KustoResultsGrid — pure helpers', () => {
  it('buildCsv produces a correct, RFC-4180-quoted CSV', () => {
    const csv = buildCsv(COLUMNS, ROWS);
    expect(csv).toBe('City,Population\nSeattle,100\nAustin,20\nBoston,9');

    // Quoting: a cell with a comma must be wrapped + internal quotes doubled.
    const tricky = buildCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
    expect(tricky).toBe('a,b\n"x,y","he said ""hi"""');
  });

  it('buildTsv produces tab-separated text', () => {
    const tsv = buildTsv(COLUMNS, ROWS);
    expect(tsv).toBe('City\tPopulation\nSeattle\t100\nAustin\t20\nBoston\t9');
  });

  it('isNumericColumn respects declared Kusto types and value sampling', () => {
    expect(isNumericColumn(1, ROWS, COLUMN_TYPES)).toBe(true); // Int64
    expect(isNumericColumn(0, ROWS, COLUMN_TYPES)).toBe(false); // String
    // No declared types → sampled from values.
    expect(isNumericColumn(1, ROWS)).toBe(true);
    expect(isNumericColumn(0, ROWS)).toBe(false);
  });

  it('makeComparator sorts numbers by value (asc) and empties last', () => {
    const cmp = makeComparator(1, 'asc', ROWS, COLUMN_TYPES);
    const order = [...ROWS].sort(cmp).map((r) => r[1]);
    expect(order).toEqual([9, 20, 100]);

    const withEmpty: unknown[][] = [['z', null], ['a', 5], ['b', 1]];
    const cmp2 = makeComparator(1, 'asc', withEmpty, COLUMN_TYPES);
    const order2 = [...withEmpty].sort(cmp2).map((r) => r[1]);
    expect(order2).toEqual([1, 5, null]); // null sorts last even ascending
  });

  it('computeColumnStats returns numeric aggregates for a numeric column', () => {
    const stats = computeColumnStats(1, ROWS, COLUMN_TYPES);
    expect(stats.isNumeric).toBe(true);
    expect(stats.count).toBe(3);
    expect(stats.nulls).toBe(0);
    expect(stats.distinct).toBe(3);
    expect(stats.min).toBe(9);
    expect(stats.max).toBe(100);
    expect(stats.sum).toBe(129);
    expect(stats.avg).toBeCloseTo(43, 5);
  });

  it('formatCell stringifies objects and blanks null/undefined', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell(42)).toBe('42');
  });
});
