/**
 * Unit tests for the KQL Dashboard model substitution engine — the piece that
 * makes parameters + the global time range real (Fabric Real-Time Dashboard
 * parity). Pure functions, no Azure I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  substituteTileKql, renderParamLiteral, resolveTimeFrom, resolveTileDatabase,
  sanitizeModel, substituteBaseQueries, type DashboardParam, type BaseQuery,
} from '../kql-dashboard-model';

describe('resolveTimeFrom', () => {
  it('maps known keys to ago() tokens', () => {
    expect(resolveTimeFrom('last-1h')).toBe('ago(1h)');
    expect(resolveTimeFrom('last-24h')).toBe('ago(24h)');
    expect(resolveTimeFrom('all')).toBe('datetime(1970-01-01)');
  });
  it('passes through a raw ago() token', () => {
    expect(resolveTimeFrom('ago(90d)')).toBe('ago(90d)');
  });
  it('defaults to last-24h when undefined', () => {
    expect(resolveTimeFrom(undefined)).toBe('ago(24h)');
  });
});

describe('renderParamLiteral', () => {
  it('quotes strings and escapes inner quotes', () => {
    expect(renderParamLiteral('us-east', 'string')).toBe('"us-east"');
    expect(renderParamLiteral('a"b', 'string')).toBe('"a\\"b"');
  });
  it('renders numerics bare', () => {
    expect(renderParamLiteral('42', 'long')).toBe('42');
    expect(renderParamLiteral('nan', 'int')).toBe('0');
  });
  it('wraps datetime, but passes ago()/now() through', () => {
    expect(renderParamLiteral('2024-01-01', 'datetime')).toBe('datetime(2024-01-01)');
    expect(renderParamLiteral('ago(7d)', 'datetime')).toBe('ago(7d)');
  });
  it('renders bool', () => {
    expect(renderParamLiteral('true', 'bool')).toBe('true');
    expect(renderParamLiteral('0', 'bool')).toBe('false');
  });
});

describe('substituteTileKql', () => {
  it('substitutes the global time range into _startTime/_endTime/_loomTimeFrom', () => {
    const out = substituteTileKql(
      'T | where ts between (_startTime .. _endTime) | where ts > _loomTimeFrom',
      [], 'last-7d',
    );
    expect(out).toContain('ago(7d) .. now()');
    expect(out).toContain('ts > ago(7d)');
  });

  it('substitutes a string param as a quoted literal', () => {
    const params: DashboardParam[] = [{ variableName: '_state', type: 'freetext', dataType: 'string', value: 'Texas' }];
    const out = substituteTileKql('StormEvents | where State == _state', params, 'all');
    expect(out).toContain('State == "Texas"');
  });

  it('renders a multi-select param as dynamic([...]) for in()', () => {
    const params: DashboardParam[] = [{ variableName: '_evt', type: 'multi', dataType: 'string', value: ['Hail', 'Flood'] }];
    const out = substituteTileKql('T | where EventType in (_evt)', params, 'all');
    expect(out).toContain('in (dynamic(["Hail", "Flood"]))');
  });

  it('leaves a token in place when the param has no value (honest unset)', () => {
    const params: DashboardParam[] = [{ variableName: '_x', type: 'freetext', value: '' }];
    const out = substituteTileKql('T | where a == _x', params, 'all');
    expect(out).toContain('a == _x');
  });

  it('does not substitute partial-word matches', () => {
    const params: DashboardParam[] = [{ variableName: '_st', type: 'freetext', dataType: 'long', value: '5' }];
    // `_state` must NOT be touched by `_st`.
    const out = substituteTileKql('T | where _state == 1 and n == _st', params, 'all');
    expect(out).toContain('_state == 1');
    expect(out).toContain('n == 5');
  });
});

describe('substituteBaseQueries', () => {
  const baseQueries: BaseQuery[] = [
    { id: 'q1', name: 'Filtered', kql: 'StormEvents | where State == "Texas"' },
    { id: 'q2', name: 'Recent', kql: 'T | where ts > ago(1h)' },
  ];

  it('inlines a $baseQuery() reference as a parenthesised sub-query', () => {
    const out = substituteBaseQueries(`$baseQuery('Filtered') | summarize count()`, baseQueries);
    expect(out).toBe('(StormEvents | where State == "Texas") | summarize count()');
  });

  it('supports double quotes and surrounding whitespace', () => {
    const out = substituteBaseQueries('$baseQuery( "Recent" ) | take 5', baseQueries);
    expect(out).toBe('(T | where ts > ago(1h)) | take 5');
  });

  it('leaves unknown base-query names intact (honest unresolved error)', () => {
    const out = substituteBaseQueries(`$baseQuery('Missing') | count`, baseQueries);
    expect(out).toContain(`$baseQuery('Missing')`);
  });

  it('substituteTileKql expands base queries before params/time', () => {
    const params: DashboardParam[] = [{ variableName: '_n', type: 'freetext', dataType: 'long', value: '5' }];
    const out = substituteTileKql(
      `$baseQuery('Filtered') | where ts > _startTime | take _n`,
      params, 'last-1h', baseQueries,
    );
    expect(out).toContain('(StormEvents | where State == "Texas")');
    expect(out).toContain('ts > ago(1h)');
    expect(out).toContain('take 5');
  });
});

describe('resolveTileDatabase', () => {
  const sources = [{ id: 'a', name: 'A', database: 'db_a' }, { id: 'b', name: 'B', database: 'db_b' }];
  it('prefers explicit database override', () => {
    expect(resolveTileDatabase({ title: '', kql: 'x', viz: 'table', database: 'db_x' }, sources, 'fb')).toBe('db_x');
  });
  it('resolves the bound data source', () => {
    expect(resolveTileDatabase({ title: '', kql: 'x', viz: 'table', dataSourceId: 'b' }, sources, 'fb')).toBe('db_b');
  });
  it('falls back when nothing bound', () => {
    expect(resolveTileDatabase({ title: '', kql: 'x', viz: 'table' }, sources, 'fb')).toBe('fb');
  });
});

describe('sanitizeModel', () => {
  it('coerces viz, clamps w/h, drops empty-kql tiles', () => {
    const m = sanitizeModel({
      tiles: [
        { title: 'ok', kql: 'print 1', viz: 'pie', w: 99, h: -3 },
        { title: 'empty', kql: '', viz: 'table' },
        { title: 'badviz', kql: 'print 2', viz: 'nonsense' },
      ],
    });
    expect(m.tiles).toHaveLength(2);
    expect(m.tiles[0].viz).toBe('pie');
    expect(m.tiles[0].w).toBe(12);
    expect(m.tiles[0].h).toBe(1);
    expect(m.tiles[1].viz).toBe('table'); // bad viz → table
  });

  it('keeps only valid parameter variable names', () => {
    const m = sanitizeModel({ parameters: [
      { variableName: '_good', type: 'freetext' },
      { variableName: '9bad', type: 'freetext' },
    ]});
    expect(m.parameters.map((p) => p.variableName)).toEqual(['_good']);
  });

  it('preserves data sources', () => {
    const m = sanitizeModel({ dataSources: [{ id: 's1', name: 'Src', database: 'd1' }] });
    expect(m.dataSources[0]).toMatchObject({ id: 's1', name: 'Src', database: 'd1' });
  });

  it('coerces base queries and drops empty-kql entries', () => {
    const m = sanitizeModel({ baseQueries: [
      { id: 'bq1', name: 'Filtered', kql: 'T | where x == 1' },
      { name: 'NoKql', kql: '' },
      { name: 'NoId', kql: 'T | take 1' },
    ]});
    expect(m.baseQueries).toHaveLength(2);
    expect(m.baseQueries[0]).toMatchObject({ id: 'bq1', name: 'Filtered', kql: 'T | where x == 1' });
    expect(m.baseQueries[1].name).toBe('NoId');
    expect(m.baseQueries[1].id).toBeTruthy(); // auto-generated id
  });

  it('always returns a baseQueries array even when absent', () => {
    const m = sanitizeModel({ tiles: [] });
    expect(Array.isArray(m.baseQueries)).toBe(true);
    expect(m.baseQueries).toHaveLength(0);
  });
});
