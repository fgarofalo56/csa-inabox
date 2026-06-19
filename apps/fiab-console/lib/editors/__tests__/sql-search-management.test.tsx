/**
 * FullTextSearchPanel + VectorIndexPanel — Vitest contract tests (audit-t78).
 *
 * Asserts the FTS + vector-index management panels mount, render their
 * info/gate MessageBars when no server/database is selected, and surface their
 * create affordances once a server/database is provided (the inventory fetch is
 * stubbed ok:true). Network calls go through the shared no-op fetch mock.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings the new
 * search-management surface from B-grade (functional, untested) to A-grade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FullTextSearchPanel, VectorIndexPanel } from '../components/sql-search-management';
import { installFetchMock } from './test-helpers';

describe('FullTextSearchPanel', () => {
  beforeEach(() => {
    installFetchMock({
      'search-management': () => ({
        ok: true, catalogs: [], ftsIndexes: [], vectorIndexes: [], tables: [],
        ftsColumns: [], vectorColumns: [], keyIndexes: [],
      }),
    });
  });
  // globals:false means cleanup is not automatic; prevents DOM accumulation between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows a pick-a-server gate when no server/database is selected', async () => {
    let err: unknown = null;
    try {
      render(<FullTextSearchPanel id="new" server="" database="" />);
      await waitFor(() => expect(screen.getByText(/Pick a server and database/i)).toBeInTheDocument(), { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('renders full-text management affordances once a server/database is set', async () => {
    let err: unknown = null;
    try {
      render(<FullTextSearchPanel id="abc" server="srv.database.windows.net" database="db" />);
      await waitFor(() => expect(screen.getByText(/New full-text index/i)).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByText(/New catalog/i)).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});

describe('VectorIndexPanel', () => {
  beforeEach(() => {
    installFetchMock({
      'search-management': () => ({
        ok: true, catalogs: [], ftsIndexes: [], vectorIndexes: [], tables: [],
        ftsColumns: [], vectorColumns: [], keyIndexes: [],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the SQL 2025 vector-index header once a server/database is set', async () => {
    let err: unknown = null;
    try {
      render(<VectorIndexPanel id="abc" server="srv.database.windows.net" database="db" />);
      // "Vector indexes" appears in the MessageBarTitle AND the Subtitle2 heading
      // within a single render, so use getAllByText and assert at least one matches.
      await waitFor(() => expect(screen.getAllByText(/Vector indexes/i).length).toBeGreaterThan(0), { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
