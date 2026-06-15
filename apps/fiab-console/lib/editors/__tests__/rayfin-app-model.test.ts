import { describe, it, expect } from 'vitest';
import {
  buildBindingDax, buildComponentDax, gbKey, gbParse,
  generateAppConfig, validateAppDefinition, scaffoldAppDefinition,
  emptyPage, emptyComponent, isDataComponent,
  buildTemplatePage, scaffoldFromTemplate, appendTemplatePage, WIZARD_TEMPLATES,
  type RayfinAppDefinition, type RayfinComponent,
} from '../rayfin-app-model';

describe('buildBindingDax', () => {
  it('emits a single-row ROW() for measures-only', () => {
    const dax = buildBindingDax({ measures: ['Total Sales'], groupBy: [], topN: 100 });
    expect(dax).toContain('EVALUATE');
    expect(dax).toContain('ROW(');
    expect(dax).toContain('"Total Sales", [Total Sales]');
    expect(dax).not.toContain('SUMMARIZECOLUMNS');
  });

  it('emits TOPN(SUMMARIZECOLUMNS) with group-by + measures', () => {
    const dax = buildBindingDax({ measures: ['Sales'], groupBy: [gbKey('Date', 'Year')], topN: 25 });
    expect(dax).toContain('SUMMARIZECOLUMNS');
    expect(dax).toContain("'Date'[Year]");
    expect(dax).toContain('"Sales", [Sales]');
    expect(dax).toContain('TOPN(\n  25');
  });

  it('caps topN at 1000 and defaults non-positive to 100', () => {
    expect(buildBindingDax({ measures: ['M'], groupBy: [gbKey('T', 'C')], topN: 99999 })).toContain('TOPN(\n  1000');
    expect(buildBindingDax({ measures: ['M'], groupBy: [gbKey('T', 'C')], topN: 0 })).toContain('TOPN(\n  100');
  });

  it('group-by only (no measures) still produces SUMMARIZECOLUMNS', () => {
    const dax = buildBindingDax({ measures: [], groupBy: [gbKey('Product', 'Category')], topN: 50 });
    expect(dax).toContain('SUMMARIZECOLUMNS');
    expect(dax).toContain("'Product'[Category]");
  });

  it('escapes single quotes in table names and strips closing brackets', () => {
    const dax = buildBindingDax({ measures: ['a]b'], groupBy: [gbKey("O'Brien", 'x]y')], topN: 10 });
    expect(dax).toContain("'O''Brien'[xy]");
    expect(dax).toContain('[ab]');
  });

  it('returns a comment when nothing is selected', () => {
    expect(buildBindingDax({ measures: [], groupBy: [], topN: 100 })).toContain('// select');
  });
});

describe('gbParse / gbKey roundtrip', () => {
  it('roundtrips table|column', () => {
    const k = gbKey('Sales', 'Region');
    expect(k).toBe('Sales|Region');
    expect(gbParse(k)).toEqual({ table: 'Sales', column: 'Region' });
  });
  it('handles keys with no pipe', () => {
    expect(gbParse('Region')).toEqual({ table: '', column: 'Region' });
  });
});

describe('component model', () => {
  it('isDataComponent classifies kinds', () => {
    expect(isDataComponent('table')).toBe(true);
    expect(isDataComponent('metric')).toBe(true);
    expect(isDataComponent('chart')).toBe(true);
    expect(isDataComponent('form')).toBe(false);
    expect(isDataComponent('text')).toBe(false);
  });

  it('emptyComponent gives data components a binding and metric topN=1', () => {
    expect(emptyComponent('table').binding).toBeTruthy();
    expect(emptyComponent('metric').binding?.topN).toBe(1);
    expect(emptyComponent('form', 'Order').entity).toBe('Order');
    expect(emptyComponent('text').text).toBeTruthy();
    expect(emptyComponent('form').binding).toBeUndefined();
  });

  it('emptyPage + emptyComponent ids are unique', () => {
    const a = emptyComponent('table');
    const b = emptyComponent('table');
    expect(a.id).not.toBe(b.id);
    expect(emptyPage().id).not.toBe(emptyPage().id);
  });

  it('buildComponentDax mirrors buildBindingDax for data components', () => {
    const c: RayfinComponent = { id: 'x', kind: 'chart', title: 'c', binding: { measures: ['Sales'], groupBy: [gbKey('Date', 'Year')], topN: 20 } };
    expect(buildComponentDax(c)).toBe(buildBindingDax(c.binding!));
  });

  it('buildComponentDax returns a comment for non-data components', () => {
    expect(buildComponentDax({ id: 'f', kind: 'form', title: 'f', entity: 'X' })).toContain('non-data');
  });
});

describe('scaffoldAppDefinition', () => {
  it('builds an Overview page with metric + table (+ chart when grouped)', () => {
    const def = scaffoldAppDefinition('SalesModel', 'Total Sales', gbKey('Date', 'Year'));
    expect(def.model).toBe('SalesModel');
    expect(def.pages).toHaveLength(1);
    const kinds = def.pages[0].components.map((c) => c.kind);
    expect(kinds).toContain('metric');
    expect(kinds).toContain('table');
    expect(kinds).toContain('chart');
  });

  it('omits the chart when no group-by is provided', () => {
    const def = scaffoldAppDefinition('M', 'Sales');
    const kinds = def.pages[0].components.map((c) => c.kind);
    expect(kinds).toContain('metric');
    expect(kinds).not.toContain('chart');
  });
});

describe('generateAppConfig', () => {
  it('emits a typed APP_CONFIG embedding per-component DAX', () => {
    const def = scaffoldAppDefinition('SalesModel', 'Total Sales', gbKey('Date', 'Year'));
    const ts = generateAppConfig(def);
    expect(ts).toContain('export const APP_CONFIG: RayfinAppConfig');
    expect(ts).toContain('"model": "SalesModel"');
    expect(ts).toContain('SUMMARIZECOLUMNS'); // chart/table dax embedded
  });

  it('returns a placeholder comment for an empty app', () => {
    expect(generateAppConfig({ model: '', pages: [] })).toContain('No pages yet');
  });
});

describe('validateAppDefinition', () => {
  it('warns when there are no pages', () => {
    const issues = validateAppDefinition({ model: 'M', pages: [] });
    expect(issues.some((i) => /No pages/.test(i.message))).toBe(true);
  });

  it('flags duplicate component ids as errors', () => {
    const dup: RayfinAppDefinition = {
      model: 'M',
      pages: [{ id: 'p', name: 'P', components: [
        { id: 'same', kind: 'metric', title: 'A', binding: { measures: ['x'], groupBy: [], topN: 1 } },
        { id: 'same', kind: 'metric', title: 'B', binding: { measures: ['y'], groupBy: [], topN: 1 } },
      ] }],
    };
    expect(validateAppDefinition(dup).some((i) => i.level === 'error' && /Duplicate/.test(i.message))).toBe(true);
  });

  it('warns when a chart lacks a measure or category', () => {
    const def: RayfinAppDefinition = {
      model: 'M',
      pages: [{ id: 'p', name: 'P', components: [
        { id: 'c', kind: 'chart', title: 'Chart', binding: { measures: ['Sales'], groupBy: [], topN: 20 } },
      ] }],
    };
    expect(validateAppDefinition(def).some((i) => /Chart .* needs/.test(i.message))).toBe(true);
  });

  it('a fully-specified single-page app has no errors', () => {
    const def = scaffoldAppDefinition('M', 'Sales', gbKey('Date', 'Year'));
    expect(validateAppDefinition(def).some((i) => i.level === 'error')).toBe(false);
  });
});

describe('wizard templates', () => {
  it('exposes the four catalog templates', () => {
    expect(WIZARD_TEMPLATES.map((t) => t.id)).toEqual(['overview', 'kpi-dashboard', 'detail-drill', 'entity-form']);
  });

  it('kpi-dashboard builds one metric tile per measure', () => {
    const page = buildTemplatePage({ template: 'kpi-dashboard', model: 'M', measures: ['Revenue', 'Cost', 'Margin'] });
    expect(page.components).toHaveLength(3);
    expect(page.components.every((c) => c.kind === 'metric')).toBe(true);
    expect(page.components.map((c) => c.title)).toEqual(['Revenue', 'Cost', 'Margin']);
    // each metric binds exactly its own measure, single row
    expect(page.components[0].binding).toEqual({ measures: ['Revenue'], groupBy: [], topN: 1 });
  });

  it('detail-drill builds a chart over a detail table', () => {
    const page = buildTemplatePage({ template: 'detail-drill', model: 'M', measure: 'Sales', groupBy: gbKey('Geo', 'Region') });
    expect(page.components.map((c) => c.kind)).toEqual(['chart', 'table']);
    expect(page.components[0].title).toBe('Sales by Region');
    expect(page.components[1].binding?.groupBy).toEqual([gbKey('Geo', 'Region')]);
  });

  it('entity-form builds a heading + a form bound to the entity', () => {
    const page = buildTemplatePage({ template: 'entity-form', model: 'M', entity: 'Order' });
    expect(page.components.map((c) => c.kind)).toEqual(['text', 'form']);
    const form = page.components.find((c) => c.kind === 'form');
    expect(form?.entity).toBe('Order');
    expect(page.name).toBe('Order form');
  });

  it('overview template delegates to the canonical scaffold', () => {
    const page = buildTemplatePage({ template: 'overview', model: 'M', measure: 'Sales', groupBy: gbKey('Date', 'Year') });
    expect(page.name).toBe('Overview');
    expect(page.components.map((c) => c.kind)).toEqual(['metric', 'table', 'chart']);
  });

  it('scaffoldFromTemplate wraps a single page into an app definition', () => {
    const def = scaffoldFromTemplate({ template: 'kpi-dashboard', model: 'SalesModel', measures: ['A'] });
    expect(def.model).toBe('SalesModel');
    expect(def.pages).toHaveLength(1);
  });

  it('appendTemplatePage adds to an existing app and never mutates it', () => {
    const first = scaffoldFromTemplate({ template: 'kpi-dashboard', model: 'M', measures: ['A'] });
    const next = appendTemplatePage(first, { template: 'entity-form', model: 'M', entity: 'Order' });
    expect(next.pages).toHaveLength(2);
    expect(first.pages).toHaveLength(1); // immutability
    // appended pages keep unique ids → a multi-page app still validates clean
    expect(validateAppDefinition(next).some((i) => i.level === 'error')).toBe(false);
  });

  it('appendTemplatePage creates the app when none exists', () => {
    const def = appendTemplatePage(undefined, { template: 'overview', model: 'M', measure: 'Sales', groupBy: gbKey('Date', 'Year') });
    expect(def.model).toBe('M');
    expect(def.pages).toHaveLength(1);
  });
});
