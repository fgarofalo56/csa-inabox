/**
 * Unit tests for the KQL Dashboard model substitution engine — the piece that
 * makes parameters + the global time range real (Fabric Real-Time Dashboard
 * parity). Pure functions, no Azure I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  substituteTileKql, buildTileKql, paramTypeToKustoType,
  renderParamLiteral, resolveTimeFrom, resolveTileDatabase,
  sanitizeModel, substituteBaseQueries,
  evalConditionalRules, evalCondition, gradientColor,
  type DashboardParam, type BaseQuery, type ConditionalRule,
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

describe('paramTypeToKustoType', () => {
  it('maps each data type to its KQL scalar type', () => {
    expect(paramTypeToKustoType('long')).toBe('long');
    expect(paramTypeToKustoType('int')).toBe('int');
    expect(paramTypeToKustoType('real')).toBe('real');
    expect(paramTypeToKustoType('datetime')).toBe('datetime');
    expect(paramTypeToKustoType('bool')).toBe('bool');
    expect(paramTypeToKustoType('string')).toBe('string');
    expect(paramTypeToKustoType(undefined)).toBe('string');
  });
});

describe('buildTileKql', () => {
  it('prepends declare query_parameters for a string scalar param', () => {
    const params: DashboardParam[] = [
      { variableName: '_state', type: 'freetext', dataType: 'string', value: 'Texas' },
    ];
    const out = buildTileKql('StormEvents | where State == _state', params, 'all');
    expect(out).toMatch(/^declare query_parameters\(_state:string = "Texas"\);/);
    // The KQL body stays literal — no in-body substitution of _state.
    expect(out).toContain('State == _state');
  });

  it('declares a long-typed param with a bare numeric default', () => {
    const params: DashboardParam[] = [
      { variableName: '_maxInjured', type: 'freetext', dataType: 'long', value: '90' },
    ];
    const out = buildTileKql('StormEvents | where InjuriesDirect > _maxInjured', params, 'all');
    expect(out).toMatch(/declare query_parameters\(_maxInjured:long = 90\);/);
  });

  it('uses a let binding for multi-select (dynamic has no default in declare)', () => {
    const params: DashboardParam[] = [
      { variableName: '_evt', type: 'multi', dataType: 'string', value: ['Hail', 'Flood'] },
    ];
    const out = buildTileKql('T | where EventType in (_evt)', params, 'all');
    expect(out).toMatch(/^let _evt = dynamic\(\["Hail", "Flood"\]\);/);
    expect(out).not.toContain('declare query_parameters');
    expect(out).toContain('EventType in (_evt)');
  });

  it('only emits declarations for params referenced in the KQL body', () => {
    const params: DashboardParam[] = [
      { variableName: '_state', type: 'freetext', dataType: 'string', value: 'Texas' },
      { variableName: '_unrelated', type: 'freetext', dataType: 'long', value: '5' },
    ];
    const out = buildTileKql('StormEvents | where State == _state', params, 'all');
    expect(out).toContain('_state:string');
    expect(out).not.toContain('_unrelated');
  });

  it('still resolves synthetic time tokens in the body', () => {
    const out = buildTileKql('T | where ts between (_startTime .. _endTime)', [], 'last-7d');
    expect(out).toContain('ago(7d) .. now()');
    expect(out).not.toContain('_startTime');
    expect(out).not.toContain('_endTime');
  });

  it('skips params with no value (token left for Kusto to error on)', () => {
    const params: DashboardParam[] = [
      { variableName: '_x', type: 'freetext', value: '' },
    ];
    const out = buildTileKql('T | where a == _x', params, 'all');
    expect(out).not.toContain('declare query_parameters');
    expect(out).toContain('a == _x');
  });

  it('does not declare a duration param (it drives _startTime/_endTime)', () => {
    const params: DashboardParam[] = [
      { variableName: '_range', type: 'duration', value: 'last-7d' },
    ];
    const out = buildTileKql('T | where ts > _startTime', params, 'last-7d');
    expect(out).not.toContain('declare query_parameters');
    expect(out).toContain('ts > ago(7d)');
  });

  it('combines a scalar declare and a dynamic let across two referenced params', () => {
    const params: DashboardParam[] = [
      { variableName: '_state', type: 'freetext', dataType: 'string', value: 'Texas' },
      { variableName: '_evt', type: 'multi', dataType: 'string', value: ['Hail'] },
    ];
    const out = buildTileKql('StormEvents | where State == _state and EventType in (_evt)', params, 'all');
    expect(out).toContain('declare query_parameters(_state:string = "Texas");');
    expect(out).toContain('let _evt = dynamic(["Hail"]);');
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

  it('round-trips conditionalRules on a tile and validates them', () => {
    const m = sanitizeModel({ tiles: [{
      title: 't', kql: 'print 1', viz: 'table',
      conditionalRules: [
        { type: 'condition', color: 'red', applyTo: 'row', conditions: [{ column: 'Count', operator: '>=', value: '500' }] },
        { type: 'value', column: 'Count', theme: 'cold', minValue: 0, maxValue: 1000 },
        // invalid rules below are dropped:
        { type: 'condition', color: 'red', conditions: [] },             // no conditions
        { type: 'condition', conditions: [{ column: 'X', operator: 'bogus', value: '1' }] }, // bad operator
        { type: 'value' },                                                // no column
      ],
    }]});
    expect(m.tiles[0].conditionalRules).toHaveLength(2);
    expect(m.tiles[0].conditionalRules![0]).toMatchObject({ type: 'condition', color: 'red', applyTo: 'row' });
    expect(m.tiles[0].conditionalRules![0].conditions![0]).toMatchObject({ column: 'Count', operator: '>=', value: '500' });
    expect(m.tiles[0].conditionalRules![1]).toMatchObject({ type: 'value', column: 'Count', theme: 'cold' });
  });

  it('leaves conditionalRules undefined when absent or empty', () => {
    expect(sanitizeModel({ tiles: [{ title: 't', kql: 'print 1', viz: 'table' }] }).tiles[0].conditionalRules).toBeUndefined();
    expect(sanitizeModel({ tiles: [{ title: 't', kql: 'print 1', viz: 'table', conditionalRules: [] }] }).tiles[0].conditionalRules).toBeUndefined();
  });

  it('caps conditionalRules at 20 per tile', () => {
    const many = Array.from({ length: 30 }, () => ({ type: 'condition', color: 'red', conditions: [{ column: 'a', operator: '>', value: '1' }] }));
    const m = sanitizeModel({ tiles: [{ title: 't', kql: 'print 1', viz: 'table', conditionalRules: many }] });
    expect(m.tiles[0].conditionalRules).toHaveLength(20);
  });
});

describe('evalCondition', () => {
  it('numeric comparisons', () => {
    expect(evalCondition(120, '>=', '100')).toBe(true);
    expect(evalCondition(80, '>=', '100')).toBe(false);
    expect(evalCondition(5, '<', '10')).toBe(true);
  });
  it('string equality falls back when non-numeric', () => {
    expect(evalCondition('Texas', '==', 'Texas')).toBe(true);
    expect(evalCondition('Texas', '!=', 'Ohio')).toBe(true);
  });
  it('is empty / is not empty', () => {
    expect(evalCondition(null, 'is empty', undefined)).toBe(true);
    expect(evalCondition('', 'is empty', undefined)).toBe(true);
    expect(evalCondition('x', 'is empty', undefined)).toBe(false);
    expect(evalCondition('x', 'is not empty', undefined)).toBe(true);
  });
});

describe('evalConditionalRules', () => {
  const columns = ['State', 'Count'];

  it('colors a row when a numeric threshold passes (>=)', () => {
    const rules: ConditionalRule[] = [
      { type: 'condition', color: 'red', applyTo: 'row', conditions: [{ column: 'Count', operator: '>=', value: '500' }] },
    ];
    const hot = evalConditionalRules(rules, ['Texas', 700], columns);
    expect(hot).toMatchObject({ color: 'red', applyTo: 'row' });
    const cold = evalConditionalRules(rules, ['Ohio', 100], columns);
    expect(cold).toBeUndefined();
  });

  it('matches a string equality condition', () => {
    const rules: ConditionalRule[] = [
      { type: 'condition', color: 'blue', conditions: [{ column: 'State', operator: '==', value: 'Texas' }] },
    ];
    expect(evalConditionalRules(rules, ['Texas', 1], columns)?.color).toBe('blue');
    expect(evalConditionalRules(rules, ['Ohio', 1], columns)).toBeUndefined();
  });

  it('matches "is empty" on a null cell', () => {
    const rules: ConditionalRule[] = [
      { type: 'condition', color: 'yellow', conditions: [{ column: 'State', operator: 'is empty' }] },
    ];
    expect(evalConditionalRules(rules, [null, 1], columns)?.color).toBe('yellow');
    expect(evalConditionalRules(rules, ['Texas', 1], columns)).toBeUndefined();
  });

  it('last matching rule wins (Fabric precedence)', () => {
    const rules: ConditionalRule[] = [
      { type: 'condition', color: 'yellow', applyTo: 'row', conditions: [{ column: 'Count', operator: '>=', value: '100' }] },
      { type: 'condition', color: 'red', applyTo: 'row', conditions: [{ column: 'Count', operator: '>=', value: '500' }] },
    ];
    expect(evalConditionalRules(rules, ['Texas', 700], columns)?.color).toBe('red');   // both match → last (red)
    expect(evalConditionalRules(rules, ['Ohio', 250], columns)?.color).toBe('yellow'); // only first matches
  });

  it('color-by-value gradient: midpoint differs from the endpoints', () => {
    const rules: ConditionalRule[] = [
      { type: 'value', column: 'Count', theme: 'traffic-lights', minValue: 0, maxValue: 100 },
    ];
    const lo = evalConditionalRules(rules, ['a', 0], columns);
    const mid = evalConditionalRules(rules, ['a', 50], columns);
    const hi = evalConditionalRules(rules, ['a', 100], columns);
    expect(lo?.bg).toBeDefined();
    expect(mid?.bg).toBeDefined();
    expect(hi?.bg).toBeDefined();
    expect(mid!.bg).not.toBe(lo!.bg);
    expect(mid!.bg).not.toBe(hi!.bg);
    // traffic-lights low→high is red→yellow→green; midpoint is the yellow stop.
    expect(mid!.bg).toBe('rgb(247, 180, 0)');
  });

  it('reverseColors flips the gradient ends', () => {
    const fwd = evalConditionalRules([{ type: 'value', column: 'Count', theme: 'traffic-lights', minValue: 0, maxValue: 100 }], ['a', 0], columns);
    const rev = evalConditionalRules([{ type: 'value', column: 'Count', theme: 'traffic-lights', minValue: 0, maxValue: 100, reverseColors: true }], ['a', 0], columns);
    expect(rev!.bg).not.toBe(fwd!.bg);
  });

  it('returns undefined when no rules', () => {
    expect(evalConditionalRules(undefined, ['a', 1], columns)).toBeUndefined();
    expect(evalConditionalRules([], ['a', 1], columns)).toBeUndefined();
  });
});

describe('gradientColor', () => {
  it('clamps t and produces a readable fg', () => {
    const c = gradientColor('traffic-lights', 2);
    expect(c.bg).toBe('rgb(16, 124, 16)'); // clamped to high stop (green)
    expect(['#1b1b1b', '#ffffff']).toContain(c.fg);
  });
});

describe('sanitizeModel — baseQueries', () => {
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
