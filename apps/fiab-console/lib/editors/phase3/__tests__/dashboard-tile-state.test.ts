/**
 * dashboard-tile-state — unit coverage for the Loom dashboard tile-body render
 * discriminator. Pure import of the exported helper (no React render) keeps this
 * off the jsdom render path.
 *
 * Locks the fix for the first-load "No rows." defect: DashboardEditor.runLoomTile
 * sets an optimistic `{ ok: true, rows: undefined }` marker before a tile query
 * resolves; the tile body must read that as 'loading' (spinner), NOT as a
 * genuinely empty result. A resolved result always carries `rows` (`[]` at
 * minimum), which is what makes the discriminator sound.
 */
import { describe, it, expect } from 'vitest';
import { loomTileBodyState } from '../dashboard-tile-state';
import type { KqlResult } from '../kql-results';

describe('loomTileBodyState', () => {
  it('treats a fully-absent result as loading (tile never queried)', () => {
    expect(loomTileBodyState(undefined)).toBe('loading');
  });

  it('treats the optimistic in-flight marker { ok:true, rows:undefined } as loading', () => {
    // This is exactly what runLoomTile sets on a tile's FIRST run, before the
    // query returns — it must NOT read as an empty result.
    const marker: KqlResult = { ok: true, rows: undefined, columns: undefined };
    expect(loomTileBodyState(marker)).toBe('loading');
  });

  it('treats a resolved zero-row result as empty (rows === [])', () => {
    const empty: KqlResult = { ok: true, columns: ['a'], rows: [] };
    expect(loomTileBodyState(empty)).toBe('empty');
  });

  it('treats a resolved result with rows as data', () => {
    const data: KqlResult = { ok: true, columns: ['a'], rows: [[1], [2]] };
    expect(loomTileBodyState(data)).toBe('data');
  });

  it('treats a failed/gated result as error regardless of rows', () => {
    expect(loomTileBodyState({ ok: false, error: 'ADX not configured' })).toBe('error');
    // A refresh that fails can carry stale rows on an !ok result — still 'error'.
    expect(loomTileBodyState({ ok: false, error: 'boom', rows: [[1]] })).toBe('error');
  });

  it('does NOT flash a spinner when refreshing a tile that already has rows', () => {
    // runLoomTile preserves prior rows on the optimistic marker during a refresh
    // (`rows: prev.rows`), so `rows` is defined → stays on 'data' (shows prior
    // values while re-querying), never a mid-refresh 'loading' blank.
    const refreshing: KqlResult = { ok: true, columns: ['a'], rows: [[42]] };
    expect(loomTileBodyState(refreshing)).toBe('data');
  });
});
