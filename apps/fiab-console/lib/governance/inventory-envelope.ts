/**
 * inventory-envelope - the stable list envelope for Copilot list tools
 * (`workspace_list`, `item_list`, `governance_inventory`).
 *
 * WHY THIS EXISTS (governance-autopilot W1, PRP section 5.9). The Copilot tool
 * loop cuts any serialized tool result at 16,000 characters with
 * `slice(0, 16_000) + '...[truncated]'` (copilot-orchestrator.ts, the
 * "Cap result size fed back to the model" block). For a list that is a
 * mid-JSON cut with NO structured signal: the model reads half an array,
 * cannot parse it, and has no way to know more rows exist. That is how the
 * 2026-10-16 operator transcript ended with "the truncated inventory is not
 * authoritative".
 *
 * The fix is to never reach that cap. Every list tool returns THIS envelope,
 * bounded by WHOLE ROWS against a documented character budget, with
 * `truncated` and `nextCursor` telling the model plainly that more exists.
 *
 * BUDGET (documented, single source): {@link ROWS_CHAR_BUDGET} characters of
 * serialized rows per page. The loop cap is {@link TOOL_LOOP_CHAR_CAP}; the
 * budget leaves ~4,000 characters of headroom for the envelope fields, the
 * hint text and one oversized row, so the cap can never fire on these tools.
 * A row is never split: the page ends BEFORE the row that would not fit.
 */

/** The orchestrator's hard cut on a serialized tool result (characters). */
export const TOOL_LOOP_CHAR_CAP = 16_000;
/** Max characters of serialized ROWS per page (envelope fields excluded). */
export const ROWS_CHAR_BUDGET = 12_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

export class InvalidCursorError extends Error {
  constructor(detail: string) {
    super(`invalid cursor: ${detail}`);
    this.name = 'InvalidCursorError';
  }
}

/** Clamp a caller-supplied page size into [1, MAX_PAGE_SIZE]; default when absent/NaN. */
export function clampPageSize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

/** Opaque cursor = the sort key of the last row already returned. */
export function encodeCursor(afterKey: string): string {
  return Buffer.from(JSON.stringify({ v: 1, after: afterKey }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('not a cursor returned by this tool; omit cursor to start from the beginning');
  }
  const after = (parsed as { v?: unknown; after?: unknown } | null)?.after;
  if ((parsed as { v?: unknown } | null)?.v !== 1 || typeof after !== 'string') {
    throw new InvalidCursorError('unrecognised cursor shape; omit cursor to start from the beginning');
  }
  return after;
}

export interface Page<T> {
  rows: T[];
  /** Rows in the whole filtered set (before paging). */
  total: number;
  returned: number;
  /** True when at least one more row exists beyond this page. */
  truncated: boolean;
  nextCursor: string | null;
  /** Why the page ended early: the row-count bound or the character budget. */
  truncatedBy: 'pageSize' | 'charBudget' | null;
}

/**
 * Take one page of `rows` (already filtered), in a STABLE order by `keyOf`.
 * `keyOf` must be unique per row; the cursor is the key of the last row
 * returned and the next page starts at the first key strictly greater than it,
 * so every row is returned exactly once across pages.
 */
export function paginate<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  opts: { cursor?: string; pageSize?: number; charBudget?: number } = {},
): Page<T> {
  const pageSize = clampPageSize(opts.pageSize);
  const budget = opts.charBudget ?? ROWS_CHAR_BUDGET;
  const sorted = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rest = after === null ? sorted : sorted.filter((r) => keyOf(r) > after);

  const page: T[] = [];
  let used = 0;
  let truncatedBy: Page<T>['truncatedBy'] = null;
  for (const row of rest) {
    if (page.length >= pageSize) { truncatedBy = 'pageSize'; break; }
    const size = JSON.stringify(row).length + 1; // +1 for the array comma
    // The FIRST row is always taken (a page that returned nothing could never
    // make progress); every later row must fit whole.
    if (page.length > 0 && used + size > budget) { truncatedBy = 'charBudget'; break; }
    page.push(row);
    used += size;
  }
  const more = page.length < rest.length;
  return {
    rows: page,
    total: sorted.length,
    returned: page.length,
    truncated: more,
    nextCursor: more && page.length > 0 ? encodeCursor(keyOf(page[page.length - 1])) : null,
    truncatedBy: more ? truncatedBy : null,
  };
}

/** The plain-language instruction a model needs when a page is partial. */
export function pagingHint(page: Page<unknown>, toolName: string): string | undefined {
  if (!page.truncated || !page.nextCursor) return undefined;
  return (
    `PARTIAL RESULT: ${page.returned} of ${page.total} rows returned (page ended on ${page.truncatedBy}). ` +
    `Call ${toolName} again with cursor="${page.nextCursor}" (same other arguments) until truncated is false. ` +
    'Do not report totals or "all" from this page alone.'
  );
}
