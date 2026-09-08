/**
 * `ingestionMappingOptions` — the table-scoping rule the free-text box could
 * not express (#3519).
 *
 * WHY THIS FILE EXISTS, stated plainly. The #3519 behaviour was already covered
 * by three rendering tests in `lib/components/azure/__tests__/wave1a-adopted-surfaces.test.tsx`,
 * and the PR body claimed those tests discriminate the defect via
 * `queryByPlaceholderText('EventMapping')`. An independent review MEASURED that
 * claim and it was wrong: at base all three fail on
 * `findByLabelText('Ingestion mapping name')`, because the same commit that
 * introduced the picker also introduced that accessible name. So the rendering
 * tests discriminate "aria-label + picker landed" as ONE bundle, and the
 * scoping rule — the part a wrong implementation would actually get wrong —
 * was never asserted on its own. These are that assertion. They fail against
 * any implementation that returns every mapping regardless of target table.
 *
 * Kusto reference: an ingestion mapping is created ON a table, and
 * `ingestionMappingReference` is resolved within that table's scope — a name
 * valid for `T1` is refused for `T2`.
 */
import { describe, it, expect } from 'vitest';
import { ingestionMappingOptions, mappingListState, type IngestionMappingRef } from '../kql-ingestion-mappings';

const ROWS: IngestionMappingRef[] = [
  { name: 'm1', table: 'T1', kind: 'json' },
  { name: 'm2', table: 'T2', kind: 'csv' },
  { name: 'shared', kind: 'json' }, // database-scoped: `.show` recorded no table
];

describe('ingestionMappingOptions — table scoping', () => {
  it('offers only the picked table’s mappings, plus the table-less ones', () => {
    expect(ingestionMappingOptions(ROWS, 'T1')).toEqual(['m1', 'shared']);
    expect(ingestionMappingOptions(ROWS, 'T2')).toEqual(['m2', 'shared']);
  });

  it('matches the table case-insensitively and ignores surrounding space', () => {
    // Kusto entity names are case-insensitive; the target table arrives from a
    // free-typed box, so a trailing space must not empty the list.
    expect(ingestionMappingOptions(ROWS, '  t1 ')).toEqual(['m1', 'shared']);
  });

  it('offers EVERY mapping when no table is picked yet', () => {
    // The Event Hub data-connection case: per-event routing decides the table,
    // so nothing is out of scope until a target table is chosen.
    expect(ingestionMappingOptions(ROWS, '')).toEqual(['m1', 'm2', 'shared']);
  });

  it('dedupes — `.show` returns one row per (table, mapping) pair', () => {
    const dupes: IngestionMappingRef[] = [
      { name: 'm1', table: 'T1' },
      { name: 'm1', table: 'T1' },
      { name: 'm1' },
    ];
    expect(ingestionMappingOptions(dupes, 'T1')).toEqual(['m1']);
  });

  it('drops rows with no name — an unnamed <option> is unpickable', () => {
    expect(ingestionMappingOptions([{ name: '' }, { name: 'ok' }], '')).toEqual(['ok']);
  });

  it('an EMPTY input yields an empty list — and that is the caller’s cue to fall back to typing, not a claim', () => {
    // The helper is deliberately silent about WHY the list is empty. The
    // unread-vs-empty distinction lives at the call site (deploy-integrity R7):
    // the editor holds `wizMappingsError` separately and says "could not be
    // read" rather than "none exist". A helper that returned a sentinel here
    // would put that judgement in the wrong layer.
    expect(ingestionMappingOptions([], 'T1')).toEqual([]);
  });
});

/**
 * #4357 re-review nit 2 — the caller-side judgement the helper above refuses to
 * make. An empty list plus `loading:false, error:null` was rendered as an
 * ABSENCE ("no ingestion mapping is defined … yet") in three situations, two of
 * which had performed no read at all: the effect returns early on a missing or
 * `new` id, and the first frame precedes the effect. These pin that only a
 * COMPLETED read can produce the absence copy (deploy-integrity.md R7).
 */
describe('mappingListState — none vs NOT READ', () => {
  const S = (o: Partial<Parameters<typeof mappingListState>[0]> = {}) =>
    mappingListState({ loading: false, error: null, read: false, optionCount: 0, ...o });

  it('the never-ran read is `unread`, NOT `none` — the nit, stated as an assertion', () => {
    // id === 'new' / no id / first frame: nothing was fetched.
    expect(S()).toBe('unread');
    expect(S()).not.toBe('none');
  });

  it('`none` requires a COMPLETED read that came back empty', () => {
    expect(S({ read: true, optionCount: 0 })).toBe('none');
  });

  it('a completed read with options is `ready`', () => {
    expect(S({ read: true, optionCount: 2 })).toBe('ready');
  });

  it('an in-flight read is `loading`, whatever the stale option count says', () => {
    expect(S({ loading: true })).toBe('loading');
    expect(S({ loading: true, read: true, optionCount: 3 })).toBe('loading');
  });

  it('a FAILED read is `error`, never `none` and never `unread`', () => {
    // The route's own reason is more informative than "not read yet", so error
    // outranks the unread state it is technically also in.
    expect(S({ error: 'ADX cluster unreachable' })).toBe('error');
    expect(S({ error: 'ADX cluster unreachable', read: false, optionCount: 0 })).not.toBe('none');
  });

  it('a stale non-empty list cannot mask a failure', () => {
    expect(S({ error: 'boom', read: true, optionCount: 5 })).toBe('error');
  });
});
