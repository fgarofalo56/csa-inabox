/**
 * Unit tests for the KQL Dashboard model substitution engine — the piece that
 * makes parameters + the global time range real (Fabric Real-Time Dashboard
 * parity). Pure functions, no Azure I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  substituteTileKql, renderParamLiteral, resolveTimeFrom, resolveTileDatabase,
  sanitizeModel, evalConditionalRules, evalCondition, gradientColor,
  type DashboardParam, type ConditionalRule,
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
