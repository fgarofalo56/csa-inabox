/**
 * Unit tests for the CoE report-render pipeline:
 *   pbir-parse  → ReportModel (pages + visuals + projections)
 *   tmdl-sample → SAMPLE tables (columns + parsed rows)
 *   visual-data → per-visual aggregation / render model
 *
 * Asserted against the REAL bundled templates (no fixtures) so the tests break
 * if the templates drift. Per no-vaporware.md: these exercise the actual parser
 * output, not a mock.
 */

import { describe, it, expect } from 'vitest';
import { TEMPLATE_FILES } from '../../templates-content';
import { parseReportModel } from '../pbir-parse';
import { parseSampleData } from '../tmdl-sample';
import { buildVisualData, formatValue } from '../visual-data';

const MATURITY = TEMPLATE_FILES['coe-adoption-maturity'];
const FINOPS = TEMPLATE_FILES['cloud-cost-finops'];

describe('parseReportModel (PBIR)', () => {
  it('parses the maturity report: 1 page, 7 visuals, sorted by z', () => {
    const model = parseReportModel(MATURITY);
    expect(model.pages).toHaveLength(1);
    const page = model.pages[0];
    expect(page.name).toBe('maturity');
    expect(page.displayName).toBe('Maturity Scorecard');
    expect(page.width).toBe(1280);
    expect(page.height).toBe(720);
    expect(page.visuals).toHaveLength(7);
    // sorted by z ascending
    const zs = page.visuals.map((v) => v.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
  });

  it('resolves literal titles (quotes stripped) and projection fields', () => {
    const model = parseReportModel(MATURITY);
    const visuals = model.pages[0].visuals;
    const bars = visuals.find((v) => v.type === 'clusteredColumnChart')!;
    expect(bars.title).toBe('Maturity by pillar');
    expect(bars.roles.Category[0]).toMatchObject({
      entity: 'Maturity Assessment', property: 'Pillar', kind: 'column',
    });
    expect(bars.roles.Y[0]).toMatchObject({
      entity: 'Maturity Assessment', property: 'Avg Maturity', kind: 'measure',
    });
  });

  it('parses the finops report and includes a donut + table visual', () => {
    const model = parseReportModel(FINOPS);
    expect(model.pages[0].name).toBe('finops');
    const types = model.pages[0].visuals.map((v) => v.type);
    expect(types).toContain('donutChart');
    expect(types).toContain('tableEx');
    expect(model.pages[0].visuals).toHaveLength(7);
  });

  it('never throws on malformed / empty input', () => {
    expect(parseReportModel([]).pages).toEqual([]);
    expect(parseReportModel([{ path: 'x/pages/p/visuals/1/visual.json', content: '{bad' }]).pages)
      .toHaveLength(0);
  });
});

describe('parseSampleData (TMDL #table)', () => {
  it('parses the Maturity Assessment table: 6 cols, 8 rows', () => {
    const sample = parseSampleData(MATURITY);
    const t = sample['Maturity Assessment'];
    expect(t).toBeTruthy();
    expect(t.columns).toEqual(['Pillar', 'Capability', 'CurrentLevel', 'TargetLevel', 'Owner', 'AssessedDate']);
    expect(t.rows).toHaveLength(8);
    expect(t.rows[0]).toMatchObject({
      Pillar: 'Strategy & Governance', Capability: 'Cloud operating model',
      CurrentLevel: 3, TargetLevel: 5, Owner: 'CoE Lead',
    });
    expect(t.rows[0].AssessedDate).toBe('2026-03-01T00:00:00');
  });

  it('parses the Adoption Signals table with datetimes', () => {
    const sample = parseSampleData(MATURITY);
    const t = sample['Adoption Signals'];
    expect(t.rows).toHaveLength(6);
    expect(t.rows[0]).toMatchObject({ Service: 'Azure', MonthlyActiveUsers: 420, WorkloadsOnboarded: 12 });
    expect(t.rows[0].Month).toBe('2026-01-01T00:00:00');
  });

  it('parses the FinOps Cost table: decimal costs + 6 rows', () => {
    const sample = parseSampleData(FINOPS);
    const t = sample['Cost'];
    expect(t.rows).toHaveLength(6);
    expect(t.columns).toContain('PreTaxCost');
    expect(t.rows[0].PreTaxCost).toBeCloseTo(12450.32, 2);
    expect(t.rows.find((r) => r.CostCenterTag === '(untagged)')).toBeTruthy();
  });
});

describe('buildVisualData (aggregation)', () => {
  it('card: sums PreTaxCost for Total Cost (≈ 38931.88)', () => {
    const model = parseReportModel(FINOPS);
    const sample = parseSampleData(FINOPS);
    const totalCost = model.pages[0].visuals.find(
      (v) => v.type === 'card' && v.title === 'Total cost (MTD)',
    )!;
    const data = buildVisualData(totalCost, sample);
    expect(data.kind).toBe('card');
    if (data.kind === 'card') expect(data.raw).toBeCloseTo(38931.88, 2);
  });

  it('card: averages CurrentLevel for Avg maturity (= 2.625)', () => {
    const model = parseReportModel(MATURITY);
    const sample = parseSampleData(MATURITY);
    const avg = model.pages[0].visuals.find(
      (v) => v.type === 'card' && /maturity/i.test(v.title),
    )!;
    const data = buildVisualData(avg, sample);
    if (data.kind === 'card') expect(data.raw).toBeCloseTo(2.625, 3);
  });

  it('bars: groups cost by service into 6 categories', () => {
    const model = parseReportModel(FINOPS);
    const sample = parseSampleData(FINOPS);
    const bars = model.pages[0].visuals.find((v) => v.type === 'clusteredColumnChart')!;
    const data = buildVisualData(bars, sample);
    expect(data.kind).toBe('bars');
    if (data.kind === 'bars') {
      expect(data.categories).toHaveLength(6);
      const aks = data.categories.find((c) => /Kubernetes/.test(c.label));
      expect(aks?.value).toBeCloseTo(12450.32, 2);
    }
  });

  it('line: sums Active Users by month, ordered (500, 650, 860)', () => {
    const model = parseReportModel(MATURITY);
    const sample = parseSampleData(MATURITY);
    const line = model.pages[0].visuals.find((v) => v.type === 'lineChart')!;
    const data = buildVisualData(line, sample);
    expect(data.kind).toBe('line');
    if (data.kind === 'line') {
      expect(data.points.map((p) => p.value)).toEqual([500, 650, 860]);
    }
  });

  it('pie: donut by subscription yields slices', () => {
    const model = parseReportModel(FINOPS);
    const sample = parseSampleData(FINOPS);
    const donut = model.pages[0].visuals.find((v) => v.type === 'donutChart')!;
    const data = buildVisualData(donut, sample);
    expect(data.kind).toBe('pie');
    if (data.kind === 'pie') expect(data.slices.length).toBeGreaterThan(0);
  });

  it('table: projects 5 columns over Cost rows', () => {
    const model = parseReportModel(FINOPS);
    const sample = parseSampleData(FINOPS);
    const table = model.pages[0].visuals.find((v) => v.type === 'tableEx')!;
    const data = buildVisualData(table, sample);
    expect(data.kind).toBe('table');
    if (data.kind === 'table') {
      expect(data.columns).toHaveLength(5);
      expect(data.rows).toHaveLength(6);
    }
  });

  it('unsupported visual type degrades to an honest tile', () => {
    const data = buildVisualData(
      { id: 'x', type: 'filledMap', x: 0, y: 0, z: 0, w: 10, h: 10, title: 'Map', roles: {} },
      {},
    );
    expect(data.kind).toBe('unsupported');
  });

  it('formatValue renders sane percents and dashes', () => {
    expect(formatValue(null, 'number')).toBe('—');
    expect(formatValue(0.42, 'percent')).toBe('42.0%');
    expect(formatValue(2.6, 'percent')).toBe('2.6'); // not an absurd 260%
  });
});
