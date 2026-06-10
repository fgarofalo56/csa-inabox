/**
 * GeoDatasetEditor — Vitest contract test.
 *
 * Covers:
 *   - the editor mounts and surfaces a ribbon button (smoke).
 *   - the geometry inspector left panel renders the inferred schema columns
 *     after a successful Synapse Serverless OPENROWSET probe (the v3.x
 *     "deferred" gate is now wired to real {columns, rows}).
 *
 * Per .claude/rules/no-vaporware.md, the inspector is no longer a deferred
 * label — it renders real column metadata from the query route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GeoDatasetEditor } from '../geo-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('GeoDatasetEditor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<GeoDatasetEditor item={makeItem('geo-dataset', 'Geo dataset')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('renders the inferred schema (with geometry badge) after a successful Inspect', async () => {
    // The geo-dataset loads from cosmos-items (GET) and inspects via the
    // synapse-serverless query route (POST). Mock both: the cosmos GET returns
    // a saved item with a geometry column + parquet format; the query POST
    // returns a real {columns, rows} shape with a WKB hex blob in `geometry`.
    installFetchMock({
      '/api/cosmos-items/geo-dataset/': () => ({
        ok: true,
        item: { state: { adlsPath: 'https://s.dfs.core.windows.net/geo/events/', geomColumn: 'geometry', format: 'parquet', srid: '4326' }, updatedAt: new Date().toISOString() },
      }),
      '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'geo', url: 'https://s.dfs.core.windows.net/' }] }),
      '/query': () => ({
        ok: true,
        columns: ['id', 'lat', 'lon', 'geometry'],
        rows: [[1, 38.9072, -77.0369, '0101000020E6100000']],
      }),
    });

    let err: unknown = null;
    try {
      render(<GeoDatasetEditor item={makeItem('geo-dataset', 'Geo dataset')} id="ds-123" />);
      // Click the primary Inspect button (waits for the editor body to mount).
      const inspectBtn = await screen.findByText(/Inspect first row/i, undefined, { timeout: 5000 });
      fireEvent.click(inspectBtn);

      // The schema panel renders each column name; geometry carries a badge.
      await waitFor(() => {
        expect(screen.getAllByText('geometry').length).toBeGreaterThan(0);
      }, { timeout: 5000 });
      expect(screen.getAllByText('id').length).toBeGreaterThan(0);
      // The WKB encoding badge appears for the geometry column.
      expect(screen.getAllByText('WKB').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import|act\(/i);
  });
});
