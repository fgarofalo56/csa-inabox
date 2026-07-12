/**
 * Vitest — mergePinnedTile (KQL Queryset → Real-Time Dashboard "Save to dashboard").
 *
 * Regression guard for a destructive data-loss bug: the kql-dashboard PUT handler
 * rebuilds the entire persisted model from the request body (sanitizeModel), so
 * pinning a tile with a body of just { tiles } WIPED the target dashboard's data
 * sources, parameters, and base queries. mergePinnedTile round-trips the full
 * model so pinning is additive and non-destructive.
 */
import { describe, it, expect } from 'vitest';
import { mergePinnedTile, type DashboardModelSnapshot } from '../phase3/kql-pin-model';

const TILE = { title: 'Failure rate', kql: 'Events | count', viz: 'table', database: 'loomdb' };

describe('mergePinnedTile', () => {
  it('appends the tile to the existing tiles (does not replace them)', () => {
    const cur: DashboardModelSnapshot = {
      ok: true,
      tiles: [{ title: 'Existing', kql: 'T | take 1', viz: 'stat' }],
    };
    const body = mergePinnedTile(cur, TILE);
    expect(body.tiles).toHaveLength(2);
    expect(body.tiles[0]).toMatchObject({ title: 'Existing' });
    expect(body.tiles[1]).toMatchObject({ title: 'Failure rate', kql: 'Events | count' });
  });

  it('PRESERVES data sources, parameters, base queries, and settings (the bug)', () => {
    const cur: DashboardModelSnapshot = {
      ok: true,
      tiles: [{ title: 'T1', kql: 'A', viz: 'table' }],
      dataSources: [{ id: 'ds1', name: 'ADX', database: 'loomdb' }],
      parameters: [{ variableName: 'region', type: 'single', dataType: 'string' }],
      baseQueries: [{ name: 'base', kql: 'let x = 1;' }],
      timeRange: 'last-7d',
      autoRefreshMs: 30000,
    };
    const body = mergePinnedTile(cur, TILE);
    // These would all be blanked out by a { tiles }-only PUT — assert they survive.
    expect(body.dataSources).toEqual(cur.dataSources);
    expect(body.parameters).toEqual(cur.parameters);
    expect(body.baseQueries).toEqual(cur.baseQueries);
    expect(body.timeRange).toBe('last-7d');
    expect(body.autoRefreshMs).toBe(30000);
  });

  it('never mutates the source snapshot', () => {
    const cur: DashboardModelSnapshot = { ok: true, tiles: [{ title: 'T1', kql: 'A', viz: 'table' }] };
    mergePinnedTile(cur, TILE);
    expect(cur.tiles).toHaveLength(1);
  });

  it('handles a first-ever pin (no tiles / empty dashboard) safely', () => {
    expect(mergePinnedTile(undefined, TILE).tiles).toEqual([TILE]);
    expect(mergePinnedTile({ ok: true }, TILE).tiles).toEqual([TILE]);
    expect(mergePinnedTile({ ok: true, tiles: [] }, TILE).tiles).toEqual([TILE]);
  });

  it('drops undefined optional fields (JSON.stringify omits them → sanitizeModel default)', () => {
    const body = mergePinnedTile({ ok: true, tiles: [] }, TILE);
    expect(JSON.parse(JSON.stringify(body))).toEqual({ tiles: [TILE] });
  });
});
