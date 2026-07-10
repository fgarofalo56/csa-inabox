import { describe, it, expect } from 'vitest';
import { resolveDbxCommand, parseLeadingMagic, parseKeyVals } from '../dbx-magics';
import { parseWidgets, buildWidgetPreamble, effectiveWidgetValues } from '../dbx-widgets';
import { diffLines, countChanges } from '../dbx-line-diff';
import { buildDbxDataProfile } from '../dbx-data-profile';

const cell = (source: string, lang = 'python') => ({ source, lang } as any);

describe('dbx-magics: parseLeadingMagic', () => {
  it('detects a leading magic and body', () => {
    const m = parseLeadingMagic('%sql\nSELECT 1');
    expect(m?.magic).toBe('sql');
    expect(m?.bodyAfter).toBe('SELECT 1');
  });
  it('returns null for a plain cell', () => {
    expect(parseLeadingMagic('x = 1')).toBeNull();
  });
});

describe('dbx-magics: resolveDbxCommand', () => {
  it('binds %sql to _sqldf in a Python notebook (D8 chaining)', () => {
    const r = resolveDbxCommand(cell('%sql\nSELECT * FROM t'), 'PYTHON');
    expect(r.commandLanguage).toBe('python');
    expect(r.boundSqldf).toBe(true);
    expect(r.command).toContain('_sqldf = spark.sql(');
    expect(r.command).toContain('display(_sqldf)');
  });
  it('runs a %sql cell as SQL when the notebook default is SQL', () => {
    const r = resolveDbxCommand(cell('%sql\nSELECT 1', 'sql'), 'SQL');
    expect(r.commandLanguage).toBe('sql');
    expect(r.command.trim()).toBe('SELECT 1');
  });
  it('routes %scala / %r / %python language magics', () => {
    expect(resolveDbxCommand(cell('%scala\nval x = 1'), 'PYTHON').commandLanguage).toBe('scala');
    expect(resolveDbxCommand(cell('%r\nx <- 1'), 'PYTHON').commandLanguage).toBe('r');
    expect(resolveDbxCommand(cell('%python\nx=1', 'sql'), 'SQL').commandLanguage).toBe('python');
  });
  it('translates %sh to a real driver subprocess call', () => {
    const r = resolveDbxCommand(cell('%sh ls -la /tmp'), 'PYTHON');
    expect(r.commandLanguage).toBe('python');
    expect(r.command).toContain('subprocess');
    expect(r.command).toContain('ls -la /tmp');
  });
  it('translates %fs ls to dbutils.fs', () => {
    const r = resolveDbxCommand(cell('%fs ls /mnt'), 'PYTHON');
    expect(r.command).toContain('dbutils.fs.ls("/mnt")');
    expect(r.command).toContain('display(');
  });
  it('translates %pip to a driver pip install', () => {
    const r = resolveDbxCommand(cell('%pip install pandas'), 'PYTHON');
    expect(r.command).toContain('"install"');
    expect(r.command).toContain('"pandas"');
  });
  it('translates %run to dbutils.notebook.run with args', () => {
    const r = resolveDbxCommand(cell('%run /Shared/child a=1 b="two"'), 'PYTHON');
    expect(r.command).toContain('dbutils.notebook.run("/Shared/child"');
    expect(r.command).toContain('"a": "1"');
    expect(r.command).toContain('"b": "two"');
  });
  it('runs a plain cell in its own language', () => {
    expect(resolveDbxCommand(cell('x = 1', 'python'), 'PYTHON').commandLanguage).toBe('python');
    expect(resolveDbxCommand(cell('SELECT 1', 'sparksql'), 'PYTHON').commandLanguage).toBe('sql');
  });
});

describe('dbx-magics: parseKeyVals', () => {
  it('parses quoted and bare values', () => {
    expect(parseKeyVals('a=1 b="two words" c=3')).toEqual([['a', '1'], ['b', 'two words'], ['c', '3']]);
  });
});

describe('dbx-widgets: parseWidgets', () => {
  it('parses all four widget types', () => {
    const src = [
      'dbutils.widgets.text("name", "alice", "Your name")',
      'dbutils.widgets.dropdown("env", "dev", ["dev", "prod"], "Environment")',
      'dbutils.widgets.combobox("region", "eastus", ["eastus", "westus"])',
      'dbutils.widgets.multiselect("cols", "a", ["a", "b", "c"])',
    ];
    const w = parseWidgets(src);
    expect(w).toHaveLength(4);
    const byName = Object.fromEntries(w.map((x) => [x.name, x]));
    expect(byName.name.type).toBe('text');
    expect(byName.name.defaultValue).toBe('alice');
    expect(byName.name.label).toBe('Your name');
    expect(byName.env.type).toBe('dropdown');
    expect(byName.env.choices).toEqual(['dev', 'prod']);
    expect(byName.cols.choices).toEqual(['a', 'b', 'c']);
  });
  it('parses SQL CREATE WIDGET and de-dupes by name (last wins for python)', () => {
    const w = parseWidgets(["CREATE WIDGET TEXT city DEFAULT 'seattle'"]);
    expect(w[0]).toMatchObject({ name: 'city', type: 'text', defaultValue: 'seattle' });
  });
  it('builds a preamble that sets the chosen value', () => {
    const w = parseWidgets(['dbutils.widgets.dropdown("env", "dev", ["dev", "prod"])']);
    const pre = buildWidgetPreamble(w, { env: 'prod' });
    expect(pre).toContain('dbutils.widgets.remove("env")');
    expect(pre).toContain('dbutils.widgets.dropdown("env", "prod"');
  });
  it('effectiveWidgetValues fills defaults', () => {
    const w = parseWidgets(['dbutils.widgets.text("name", "alice")']);
    expect(effectiveWidgetValues(w, {})).toEqual({ name: 'alice' });
    expect(effectiveWidgetValues(w, { name: 'bob' })).toEqual({ name: 'bob' });
  });
});

describe('dbx-line-diff', () => {
  it('marks added and removed lines', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc');
    expect(countChanges(d)).toBe(2); // b removed, B added
    expect(d.some((l) => l.op === 'removed' && l.text === 'b')).toBe(true);
    expect(d.some((l) => l.op === 'added' && l.text === 'B')).toBe(true);
  });
  it('identical text has zero changes', () => {
    expect(countChanges(diffLines('x\ny', 'x\ny'))).toBe(0);
  });
});

describe('dbx-data-profile', () => {
  it('computes numeric + categorical stats from a table result', () => {
    const cols = ['age', 'city'];
    const rows: unknown[][] = [[30, 'nyc'], [40, 'sf'], [50, 'nyc']];
    const p = buildDbxDataProfile(cols, rows);
    expect(p).not.toBeNull();
    const age = p!.columns.find((c) => c.name === 'age')!;
    const city = p!.columns.find((c) => c.name === 'city')!;
    expect(age.min).toBe('30');
    expect(age.max).toBe('50');
    expect(city.cardinality).toBe(2);
    expect(city.topValues?.[0]).toEqual({ value: 'nyc', count: 2 });
  });
  it('returns null with no columns', () => {
    expect(buildDbxDataProfile([], [])).toBeNull();
  });
});
