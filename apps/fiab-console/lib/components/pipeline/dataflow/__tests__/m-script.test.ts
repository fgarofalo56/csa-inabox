/**
 * Unit tests for the pure Power Query (M) manipulation helpers that back the
 * Dataflow Gen2 authoring surface. No DOM / network — pure string logic.
 */
import { describe, it, expect } from 'vitest';
import {
  splitTopLevel, parseLetBody, buildLetBody, setQueryBody, parseSharedQueries,
  appendStep, renameIdentifier, quoteStepName, RIBBON_TRANSFORMS,
} from '../m-script';

describe('splitTopLevel', () => {
  it('ignores separators nested in delimiters and strings', () => {
    const parts = splitTopLevel('a = f(1, 2), b = {3, 4}, c = "x,y"', ',');
    expect(parts.map((p) => p.trim())).toEqual(['a = f(1, 2)', 'b = {3, 4}', 'c = "x,y"']);
  });
});

describe('parseLetBody / buildLetBody', () => {
  it('round-trips applied steps', () => {
    const body = 'let\n    Source = #table({"c"}, {{1}}),\n    Filtered = Table.SelectRows(Source, each [c] > 0)\nin\n    Filtered';
    const { steps, result } = parseLetBody(body);
    expect(steps.map((s) => s.name)).toEqual(['Source', 'Filtered']);
    expect(result).toBe('Filtered');
    const rebuilt = buildLetBody(steps, result);
    const reparsed = parseLetBody(rebuilt);
    expect(reparsed.steps.map((s) => s.name)).toEqual(['Source', 'Filtered']);
    expect(reparsed.result).toBe('Filtered');
  });

  it('handles quoted step names', () => {
    const body = 'let\n    Source = 1,\n    #"Filtered Rows" = Source\nin\n    #"Filtered Rows"';
    const { steps, result } = parseLetBody(body);
    expect(steps.map((s) => s.name)).toEqual(['Source', 'Filtered Rows']);
    expect(result).toBe('Filtered Rows');
    expect(quoteStepName('Filtered Rows')).toBe('#"Filtered Rows"');
  });
});

describe('parseSharedQueries', () => {
  it('extracts named queries from a section', () => {
    const m = 'section Section1;\n\nshared Query1 = let Source = 1 in Source;\n\nshared Query2 = let Source = 2 in Source;';
    const qs = parseSharedQueries(m);
    expect(qs.map((q) => q.name)).toEqual(['Query1', 'Query2']);
  });
});

describe('setQueryBody', () => {
  it('replaces one query body in place', () => {
    const m = 'section Section1;\n\nshared A = let Source = 1 in Source;\n\nshared B = let Source = 2 in Source;';
    const next = setQueryBody(m, 'A', 'let Source = 9 in Source');
    expect(next).toContain('shared A = let Source = 9 in Source;');
    expect(next).toContain('shared B = let Source = 2 in Source;');
  });
});

describe('appendStep', () => {
  it('appends a ribbon transform chaining off the last step', () => {
    const filter = RIBBON_TRANSFORMS.find((t) => t.key === 'filterRows')!;
    const body = 'let\n    Source = #table({"c"}, {{1}})\nin\n    Source';
    const next = appendStep(body, filter);
    const { steps, result } = parseLetBody(next);
    expect(steps).toHaveLength(2);
    expect(steps[1].name).toBe('Filtered Rows');
    expect(steps[1].expr).toContain('Table.SelectRows(Source');
    expect(result).toBe('Filtered Rows');
  });
});

describe('renameIdentifier', () => {
  it('renames bare + quoted references', () => {
    const text = 'let Source = 1, #"Filtered" = Source in #"Filtered"';
    const renamed = renameIdentifier(text, 'Source', 'Base');
    expect(renamed).toBe('let Base = 1, #"Filtered" = Base in #"Filtered"');
  });
});
