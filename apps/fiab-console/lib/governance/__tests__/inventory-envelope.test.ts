/**
 * inventory-envelope - pure pagination. Each assertion names the input that
 * breaks it (assertion-design.md).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_PAGE_SIZE,
  ROWS_CHAR_BUDGET,
  TOOL_LOOP_CHAR_CAP,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  paginate,
  pagingHint,
} from '../inventory-envelope';

const rows = (n: number, pad = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, pad: 'x'.repeat(pad) }));
const key = (r: { id: string }) => r.id;

describe('paginate', () => {
  it('500 rows with pageSize 500 over the char budget: cut by whole rows, truncated + nextCursor set, total stays 500', () => {
    // 500 rows x ~70 chars = ~35,000 chars, far over the 12,000 budget. A
    // paginate that ignored the budget would return all 500 (returned === 500)
    // and the orchestrator would cut the JSON mid-row.
    const all = rows(500, 40);
    const p = paginate(all, key, { pageSize: 500 });
    expect(p.total).toBe(500);
    expect(p.returned).toBeLessThan(500);
    expect(p.returned).toBeGreaterThan(0);
    expect(p.truncated).toBe(true);
    expect(p.truncatedBy).toBe('charBudget');
    expect(p.nextCursor).not.toBeNull();
    // Whole rows only: the serialized page parses and is inside the budget.
    const text = JSON.stringify(p.rows);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toHaveLength(p.returned);
    expect(text.length).toBeLessThanOrEqual(ROWS_CHAR_BUDGET);
    expect(ROWS_CHAR_BUDGET + 4_000).toBeLessThanOrEqual(TOOL_LOOP_CHAR_CAP); // headroom is part of the contract
  });

  it('501 rows with pageSize 500 on tiny rows: truncated by pageSize, nextCursor non-null (PRP 7.2 tool pagination row)', () => {
    const p = paginate(rows(501), key, { pageSize: 500 });
    expect(p.returned).toBe(500);
    expect(p.total).toBe(501);
    expect(p.truncated).toBe(true);
    expect(p.truncatedBy).toBe('pageSize');
    expect(p.nextCursor).not.toBeNull();
  });

  it('exactly one full page is NOT truncated (breaking on the limit would report a false "more")', () => {
    const p = paginate(rows(100), key, { pageSize: 100 });
    expect(p.returned).toBe(100);
    expect(p.truncated).toBe(false);
    expect(p.nextCursor).toBeNull();
    expect(p.truncatedBy).toBeNull();
  });

  it('every row is returned exactly once across pages, in key order, whatever the input order', () => {
    // Reverse-ordered input: an implementation that pages the input array order
    // instead of sorting by key would skip every row once the cursor is applied.
    const ordered = rows(237, 30);
    const shuffled = [...ordered].reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = paginate(shuffled, key, { cursor, pageSize: 50 });
      seen.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(100); // a stuck cursor must fail, not hang
    } while (cursor);
    expect(seen).toHaveLength(237);
    expect(new Set(seen).size).toBe(237); // no duplicates (a >= cursor compare would repeat the boundary row)
    expect(seen).toEqual(ordered.map((r) => r.id)); // none skipped, key order
  });

  it('a single row bigger than the budget is still returned (progress guarantee) rather than an empty truncated page', () => {
    const big = [{ id: 'a', pad: 'y'.repeat(ROWS_CHAR_BUDGET + 500) }, { id: 'b', pad: '' }];
    const p = paginate(big, key, { pageSize: 10 });
    expect(p.rows.map((r) => r.id)).toEqual(['a']);
    expect(p.truncated).toBe(true);
    expect(p.nextCursor).not.toBeNull();
  });

  it('empty input is total 0, not truncated, no cursor', () => {
    const p = paginate([], key);
    expect(p).toMatchObject({ total: 0, returned: 0, truncated: false, nextCursor: null });
  });
});

describe('cursor', () => {
  it('round-trips the key, including characters that are awkward in JSON/URLs', () => {
    const k = 'ws"1|é/x?y=z';
    expect(decodeCursor(encodeCursor(k))).toBe(k);
  });

  it('rejects a non-cursor string and a wrong-shape payload instead of restarting silently', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow(InvalidCursorError);
    const wrong = Buffer.from(JSON.stringify({ v: 2, after: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(wrong)).toThrow(InvalidCursorError);
    expect(() => paginate(rows(3), key, { cursor: 'garbage' })).toThrow(InvalidCursorError);
  });
});

describe('clampPageSize', () => {
  it('defaults when absent or NaN, clamps to [1, MAX]', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(100000)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize('25')).toBe(25);
    expect(clampPageSize(12.9)).toBe(12);
  });
});

describe('pagingHint', () => {
  it('names the cursor and tool when partial, and is absent when complete', () => {
    const partial = paginate(rows(300, 40), key, { pageSize: 500 });
    const hint = pagingHint(partial, 'item_list');
    expect(hint).toContain('cursor="' + partial.nextCursor + '"');
    expect(hint).toContain('item_list');
    expect(hint).toContain(`${partial.returned} of 300`);
    expect(pagingHint(paginate(rows(3), key), 'item_list')).toBeUndefined();
  });
});
