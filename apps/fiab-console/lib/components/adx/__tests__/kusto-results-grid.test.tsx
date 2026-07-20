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
  clampColumnWidth,
  filterRows,
  csvTimestamp,
  CSV_BOM,
  MIN_COL_WIDTH,
  MAX_COL_WIDTH,
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

describe('KustoResultsGrid — per-column filter control', () => {
  it('toggling column filters reveals inputs that narrow rows, and Clear resets', () => {
    renderGrid();
    expect(bodyRowTexts()).toHaveLength(3);

    // Reveal the per-column filter inputs.
    fireEvent.click(screen.getByLabelText('Toggle column filters'));
    const cityFilter = screen.getByLabelText('Filter City');
    fireEvent.change(cityFilter, { target: { value: 'bo' } });

    const data = bodyRowTexts();
    expect(data).toHaveLength(1);
    expect(data[0][0]).toBe('Boston');

    // The Clear-filters button restores every row.
    fireEvent.click(screen.getByLabelText('Clear filters'));
    expect(bodyRowTexts()).toHaveLength(3);
  });
});

describe('KustoResultsGrid — pure helpers', () => {
  it('buildCsv produces a correct, RFC-4180-quoted CSV (CRLF records)', () => {
    const csv = buildCsv(COLUMNS, ROWS);
    expect(csv).toBe('City,Population\r\nSeattle,100\r\nAustin,20\r\nBoston,9');

    // Quoting: a cell with a comma must be wrapped + internal quotes doubled;
    // an embedded newline forces quoting too (and stays intact in the cell).
    const tricky = buildCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
    expect(tricky).toBe('a,b\r\n"x,y","he said ""hi"""');
    const multiline = buildCsv(['a'], [['line1\nline2']]);
    expect(multiline).toBe('a\r\n"line1\nline2"');

    // Header-only (no rows) has no trailing separator.
    expect(buildCsv(['a', 'b'], [])).toBe('a,b');
  });

  it('CSV_BOM is the UTF-8 byte-order mark so Excel reads Unicode', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
    // The exported blob is BOM + CSV — accented text survives round-trip.
    const withBom = CSV_BOM + buildCsv(['name'], [['Åsa']]);
    expect(withBom.startsWith('﻿')).toBe(true);
    expect(withBom).toContain('Åsa');
  });

  it('csvTimestamp is a sortable YYYYMMDD-HHMMSS local stamp', () => {
    const stamp = csvTimestamp(new Date(2026, 6, 20, 9, 5, 3)); // month is 0-based → July
    expect(stamp).toBe('20260720-090503');
    expect(csvTimestamp()).toMatch(/^\d{8}-\d{6}$/);
  });

  it('clampColumnWidth clamps into the allowed range and rounds', () => {
    expect(clampColumnWidth(10)).toBe(MIN_COL_WIDTH);
    expect(clampColumnWidth(5000)).toBe(MAX_COL_WIDTH);
    expect(clampColumnWidth(123.6)).toBe(124);
    expect(clampColumnWidth(NaN)).toBe(MIN_COL_WIDTH);
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

  it('computeColumnStats returns earliest/latest for a datetime column', () => {
    const cols = ['ts'];
    const types = ['DateTime'];
    const rows: unknown[][] = [
      ['2026-07-20T10:00:00Z'],
      ['2026-07-18T06:30:00Z'],
      ['2026-07-19T23:15:00Z'],
      [null],
    ];
    const stats = computeColumnStats(0, rows, types);
    expect(stats.isNumeric).toBe(false);
    expect(stats.isDateTime).toBe(true);
    expect(stats.count).toBe(4);
    expect(stats.nulls).toBe(1);
    expect(stats.distinct).toBe(3);
    expect(stats.min).toBe(Date.parse('2026-07-18T06:30:00Z'));
    expect(stats.max).toBe(Date.parse('2026-07-20T10:00:00Z'));
    expect(stats.minLabel).toBe('2026-07-18T06:30:00.000Z');
    expect(stats.maxLabel).toBe('2026-07-20T10:00:00.000Z');
  });

  it('computeColumnStats reports distinct + most-common for a string column', () => {
    const rows: unknown[][] = [['a'], ['b'], ['a'], ['a'], ['']];
    const stats = computeColumnStats(0, rows, ['String']);
    expect(stats.isNumeric).toBe(false);
    expect(stats.isDateTime).toBe(false);
    expect(stats.nulls).toBe(1); // empty string counts as null/empty
    expect(stats.distinct).toBe(2); // 'a', 'b'
    expect(stats.mostCommon).toEqual({ value: 'a', n: 3 });
  });

  it('filterRows applies global search and per-column filters (AND), ignoring blanks', () => {
    // No terms → identity (same reference).
    expect(filterRows(ROWS, COLUMNS, '', [])).toBe(ROWS);

    // Global search across any column, case-insensitive.
    const g = filterRows(ROWS, COLUMNS, 'aust', []);
    expect(g).toHaveLength(1);
    expect(g[0][0]).toBe('Austin');

    // Numeric cell matched by substring via the global search too.
    expect(filterRows(ROWS, COLUMNS, '100', [])).toHaveLength(1);

    // Per-column filter on the City column only.
    const c = filterRows(ROWS, COLUMNS, '', [[0, 'bo']]);
    expect(c).toHaveLength(1);
    expect(c[0][0]).toBe('Boston');

    // Blank per-column terms are ignored (no over-filtering).
    expect(filterRows(ROWS, COLUMNS, '', [[0, '   ']])).toBe(ROWS);

    // Global + per-column combine with AND (no row satisfies both).
    expect(filterRows(ROWS, COLUMNS, 'seattle', [[0, 'austin']])).toHaveLength(0);
  });

  it('formatCell stringifies objects and blanks null/undefined', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell(42)).toBe('42');
  });
});

describe('KustoResultsGrid — column resize', () => {
  it('dragging a header resize handle sets an explicit column width on header + cells', () => {
    renderGrid();
    const handle = screen.getByLabelText('Resize Population column');
    const th = handle.parentElement as HTMLElement;
    expect(th.tagName).toBe('TH');
    expect(th.style.width).toBe(''); // auto-size before any drag

    // Drag 60px right. jsdom getBoundingClientRect width is 0 → start clamps to
    // MIN_COL_WIDTH (48), so final width = 48 + 60 = 108px.
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 160 });
    expect(th.style.width).toBe(`${MIN_COL_WIDTH + 60}px`);
    fireEvent.mouseUp(window);

    // The matching body cell receives the same width so the column stays aligned.
    const table = screen.getByRole('table');
    const firstBodyRow = within(table).getAllByRole('row')[1];
    const popCell = within(firstBodyRow).getAllByRole('cell')[1] as HTMLElement;
    expect(popCell.style.width).toBe(`${MIN_COL_WIDTH + 60}px`);
  });

  it('double-clicking the handle clears the explicit width (auto-fit)', () => {
    renderGrid();
    const handle = screen.getByLabelText('Resize Population column');
    const th = handle.parentElement as HTMLElement;
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 120 });
    fireEvent.mouseUp(window);
    expect(th.style.width).not.toBe('');
    fireEvent.doubleClick(handle);
    expect(th.style.width).toBe('');
  });
});

