/**
 * Unit tests for the KQL Dashboard model substitution engine — the piece that
 * makes parameters + the global time range real (Fabric Real-Time Dashboard
 * parity). Pure functions, no Azure I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  substituteTileKql, renderParamLiteral, resolveTimeFrom, resolveTileDatabase,
  sanitizeModel, type DashboardParam,
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
});

describe('sanitizeModel — drillthrough', () => {
  it('preserves a valid drillthrough definition', () => {
    const m = sanitizeModel({
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: 'State', paramName: '_state' } }],
    });
    expect(m.tiles[0].drillthrough).toEqual({ column: 'State', paramName: '_state' });
  });
  it('drops drillthrough when column is empty', () => {
    const m = sanitizeModel({
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: '', paramName: '_state' } }],
    });
    expect(m.tiles[0].drillthrough).toBeUndefined();
  });
  it('drops drillthrough when paramName is empty', () => {
    const m = sanitizeModel({
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: 'State', paramName: '' } }],
    });
    expect(m.tiles[0].drillthrough).toBeUndefined();
  });
  it('leaves drillthrough undefined when absent', () => {
    const m = sanitizeModel({ tiles: [{ title: 'T', kql: 'print 1', viz: 'table' }] });
    expect(m.tiles[0].drillthrough).toBeUndefined();
  });
  it('truncates column and paramName to 80 chars', () => {
    const long = 'x'.repeat(100);
    const m = sanitizeModel({
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: long, paramName: long } }],
    });
    expect(m.tiles[0].drillthrough!.column).toHaveLength(80);
    expect(m.tiles[0].drillthrough!.paramName).toHaveLength(80);
  });
});
