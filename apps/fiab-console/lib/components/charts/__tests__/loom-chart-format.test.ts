/**
 * WS-3.1 — report-designer Wave-6 Format-pane → LoomChart adapter.
 *
 * Proves each Format card control MUTATES the rendered chart via
 * `formatToChartProps` (the pane↔chart seam wired in report-designer.tsx's
 * VisualBody). Together with the persistence test (lib/report/__tests__/
 * format-pane-persistence.test.ts) this covers the full card → model → chart →
 * persist loop: the card writes a structured field, the adapter turns it into a
 * real frozen-W5 LoomChart lever / row transform / axis-chrome payload (no dead
 * controls, no-vaporware.md).
 */
import { describe, it, expect } from 'vitest';
import { formatToChartProps } from '../loom-chart-format';
import type { ChartAdapterContext } from '../loom-chart-format';
import type { ReportVisualFormat } from '@/lib/editors/report/format-pane';

const rows = [
  { Month: 'Jan', Revenue: 1000, Profit: 200 },
  { Month: 'Feb', Revenue: 2000, Profit: 400 },
  { Month: 'Mar', Revenue: 4000, Profit: 800 },
];
const ctx = (over: Partial<ChartAdapterContext> = {}): ChartAdapterContext => ({
  visualType: 'column', rows, numericColumns: ['Revenue', 'Profit'], ...over,
});

describe('formatToChartProps — Format cards drive real chart levers', () => {
  it('axisY.max → sharedValueMax (non-gauge)', () => {
    const fmt = { axisY: { max: 5000 } } as ReportVisualFormat;
    expect(formatToChartProps(fmt, ctx()).chartProps.sharedValueMax).toBe(5000);
  });

  it('gauge axis min/max/target → gaugeMin/gaugeMax/target', () => {
    const fmt = { axisY: { min: 0, max: 100, target: 80 } } as ReportVisualFormat;
    const { chartProps } = formatToChartProps(fmt, ctx({ visualType: 'gauge' }));
    expect(chartProps.gaugeMin).toBe(0);
    expect(chartProps.gaugeMax).toBe(100);
    expect((chartProps as Record<string, unknown>).target).toBe(80);
  });

  it('axisY2.series → comboLineSeries, filtered to real numeric columns', () => {
    const fmt = { axisY2: { series: ['Profit', 'NotAColumn'] } } as ReportVisualFormat;
    expect(formatToChartProps(fmt, ctx({ visualType: 'combo' })).chartProps.comboLineSeries).toEqual(['Profit']);
  });

  it('axisY.gridlines=false → structural.gridline transparent', () => {
    const fmt = { axisY: { gridlines: false } } as ReportVisualFormat;
    expect(formatToChartProps(fmt, ctx()).chartProps.structural?.gridline).toBe('transparent');
  });

  it('axis label color/font → structural.foreground + fontFamily', () => {
    const fmt = { axisY: { labelColor: '#123456', labelFont: 'Georgia' } } as ReportVisualFormat;
    const { chartProps } = formatToChartProps(fmt, ctx());
    expect(chartProps.structural?.foreground).toBe('#123456');
    expect(chartProps.fontFamily).toBe('Georgia');
  });

  it('displayUnits (thousands) pre-scales the plotted numeric columns', () => {
    const fmt = { axisY: { displayUnits: 'thousands' } } as ReportVisualFormat;
    const out = formatToChartProps(fmt, ctx());
    expect(out.rows).not.toBe(rows); // transformed (new ref)
    expect(out.rows[2].Revenue).toBe(4); // 4000 / 1e3
    expect(out.rows[0].Month).toBe('Jan'); // non-numeric untouched
  });

  it('logScale → log10 of the plotted numeric columns', () => {
    const fmt = { axisY: { logScale: true } } as ReportVisualFormat;
    const out = formatToChartProps(fmt, ctx());
    expect(out.rows[0].Revenue).toBeCloseTo(3); // log10(1000)
  });

  it('zoom window slices rows to the category range', () => {
    const fmt = { zoom: { enabled: true, from: 0.34, to: 1 } } as ReportVisualFormat;
    const out = formatToChartProps(fmt, ctx());
    expect(out.rows.length).toBeLessThan(rows.length);
    expect(out.rows[0].Month).not.toBe('Jan'); // leading category dropped
  });

  it('axis titles → axisChrome (drawn by VisualChrome margins)', () => {
    const fmt = {
      axisX: { title: 'Month', showTitle: true },
      axisY: { title: 'Revenue', showTitle: true },
      axisY2: { title: 'Profit', showTitle: true },
      title: { align: 'center' },
    } as ReportVisualFormat;
    const { axisChrome } = formatToChartProps(fmt, ctx({ visualType: 'combo' }));
    expect(axisChrome).toEqual({ xTitle: 'Month', yTitle: 'Revenue', y2Title: 'Profit', titleAlign: 'center' });
  });

  it('tooltipOptions.fields → tooltips + hover', () => {
    const fmt = { tooltipOptions: { fields: ['Profit'] } } as ReportVisualFormat;
    const { chartProps } = formatToChartProps(fmt, ctx());
    expect(chartProps.tooltips).toEqual(['Profit']);
    expect(chartProps.hover).toBe(true);
  });

  it('no format → passthrough: SAME rows reference, no transform', () => {
    const out = formatToChartProps(undefined, ctx());
    expect(out.rows).toBe(rows);
    expect(out.axisChrome).toBeUndefined();
  });
});
