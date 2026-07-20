/**
 * WS-3.1 — report-designer Wave-6 Format-pane persistence.
 *
 * Proves the per-axis / title / legend / effects / data-label / header-icon /
 * tooltip / zoom / small-multiples / per-field-number Format cards SURVIVE the
 * PUT /definition sanitizer round-trip (`sanitizeFormat`). Before the Wave-6
 * whitelist landed, every one of these nested objects was silently dropped on
 * save, so the cards edited + applied live but reset on reload — the
 * no-vaporware.md persistence gap this test guards against regressing.
 *
 * It also asserts the whitelist is HOSTILE-SAFE: unknown enum values, a
 * non-whitelisted font family, out-of-range numbers, and unknown header-icon keys
 * are dropped / clamped, never persisted verbatim.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeFormat } from '../report-definition-sanitizer';

describe('sanitizeFormat — Wave-6 Format-pane card persistence', () => {
  it('round-trips a fully-authored per-axis card (axisX / axisY / axisY2)', () => {
    const out = sanitizeFormat({
      axisX: { show: false, title: 'Category', showTitle: true, labelColor: '#112233', labelFont: 'Arial', axisType: 'categorical' },
      axisY: {
        show: true, title: 'Revenue', showTitle: true, gridlines: false, gridlineColor: '#ddeeff',
        min: 0, max: 1000, logScale: true, displayUnits: 'thousands', decimals: 2,
        labelFont: 'Segoe UI', labelFontSize: 12, labelColor: '#010203', labelRotation: 45,
      },
      axisY2: { series: ['Profit', 'Margin', 'Profit'], title: 'Secondary' },
    });
    expect(out?.axisX).toEqual({ show: false, title: 'Category', showTitle: true, labelColor: '#112233', labelFont: 'Arial', axisType: 'categorical' });
    expect(out?.axisY?.gridlines).toBe(false);
    expect(out?.axisY?.max).toBe(1000);
    expect(out?.axisY?.logScale).toBe(true);
    expect(out?.axisY?.displayUnits).toBe('thousands');
    expect(out?.axisY?.decimals).toBe(2);
    expect(out?.axisY?.labelRotation).toBe(45);
    // de-duplicated result-column series
    expect(out?.axisY2?.series).toEqual(['Profit', 'Margin']);
  });

  it('round-trips the rich Title card incl. the fx-conditional field', () => {
    const out = sanitizeFormat({
      title: {
        show: true, text: 'Sales', font: 'Georgia', fontSize: 20, color: '#ff0000',
        align: 'center', heading: 'subtitle', subtitle: 'FY26', divider: true,
        conditionalField: { table: 'Sales', column: 'Total', measure: 'SumTotal' },
      },
    });
    expect(out?.title).toEqual({
      show: true, text: 'Sales', font: 'Georgia', fontSize: 20, color: '#ff0000',
      align: 'center', heading: 'subtitle', subtitle: 'FY26', divider: true,
      conditionalField: { table: 'Sales', column: 'Total', measure: 'SumTotal' },
    });
  });

  it('round-trips Legend, Effects (border/shadow/plot-area), header-icons, tooltips, zoom, small-multiples, and per-field number format', () => {
    const out = sanitizeFormat({
      legend: { title: 'Series', font: 'Tahoma', fontSize: 11, color: '#0a0a0a', style: 'bold' },
      effects: {
        shadow: { show: true, color: '#333333', offsetX: 4, offsetY: 6, position: 'inner' },
        border: { show: true, color: '#00ff00', width: 2, radius: 8 },
        plotAreaBg: { color: '#f0f0f0', transparency: 30 },
      },
      headerIcons: { visualInfo: true, focus: false, more: true },
      tooltipOptions: { show: true, type: 'report', fields: ['Extra1', 'Extra2'] },
      zoom: { enabled: true, from: 0.1, to: 0.9 },
      smallMultiplesGrid: { columns: 3, sharedY: true, padding: 8, facetColumn: 'Region' },
      numberFormatByField: { Revenue: { preset: 'currency', decimals: 2, units: 'millions' } },
    });
    expect(out?.legend).toEqual({ title: 'Series', font: 'Tahoma', fontSize: 11, color: '#0a0a0a', style: 'bold' });
    expect(out?.effects?.shadow).toEqual({ show: true, color: '#333333', offsetX: 4, offsetY: 6, position: 'inner' });
    expect(out?.effects?.border).toEqual({ show: true, color: '#00ff00', width: 2, radius: 8 });
    expect(out?.effects?.plotAreaBg).toEqual({ color: '#f0f0f0', transparency: 30 });
    expect(out?.headerIcons).toEqual({ visualInfo: true, focus: false, more: true });
    expect(out?.tooltipOptions).toEqual({ show: true, type: 'report', fields: ['Extra1', 'Extra2'] });
    expect(out?.zoom).toEqual({ enabled: true, from: 0.1, to: 0.9 });
    expect(out?.smallMultiplesGrid).toEqual({ columns: 3, sharedY: true, padding: 8, facetColumn: 'Region' });
    expect(out?.numberFormatByField).toEqual({ Revenue: { preset: 'currency', decimals: 2, units: 'millions' } });
  });

  it('round-trips extended data-labels and total-labels styling', () => {
    const out = sanitizeFormat({
      dataLabels: { show: true, position: 'outside', font: 'Calibri', color: '#123456', units: 'thousands', decimals: 1, background: '#eeeeee', content: 'titleValue' },
      totalLabels: { show: true, font: 'Verdana', color: '#654321', units: 'millions' },
    });
    expect(out?.dataLabels).toEqual({ show: true, position: 'outside', font: 'Calibri', color: '#123456', units: 'thousands', decimals: 1, background: '#eeeeee', content: 'titleValue' });
    expect(out?.totalLabels).toEqual({ show: true, font: 'Verdana', color: '#654321', units: 'millions' });
  });

  it('is hostile-safe: drops unknown enums, non-whitelisted fonts, unknown icon keys; clamps out-of-range numbers', () => {
    const out = sanitizeFormat({
      axisY: { displayUnits: 'zillions', decimals: 99, labelRotation: 37, labelFont: 'ComicSans', min: 1e30 },
      title: { align: 'diagonal', heading: 'banner' },
      legend: { style: 'wobble' },
      headerIcons: { visualInfo: true, evilKey: true, notAnIcon: 'x' } as unknown as Record<string, boolean>,
      tooltipOptions: { type: 'hacker' },
      zoom: { from: 5, to: -3 },
      smallMultiplesGrid: { columns: 999 },
    });
    // unknown display-units / rotation / font dropped; decimals clamped to 4; min clamped to bound
    expect(out?.axisY?.displayUnits).toBeUndefined();
    expect(out?.axisY?.labelRotation).toBeUndefined();
    expect(out?.axisY?.labelFont).toBeUndefined();
    expect(out?.axisY?.decimals).toBe(4);
    expect(out?.axisY?.min).toBe(1e15);
    // unknown title/legend enums dropped
    expect(out?.title?.align).toBeUndefined();
    expect(out?.title?.heading).toBeUndefined();
    expect(out?.legend?.style).toBeUndefined();
    // only whitelisted icon keys survive
    expect(out?.headerIcons).toEqual({ visualInfo: true });
    // unknown tooltip type dropped
    expect(out?.tooltipOptions?.type).toBeUndefined();
    // zoom fractions clamped to [0,1]
    expect(out?.zoom).toEqual({ from: 1, to: 0 });
    // columns clamped to the 12 grid max
    expect(out?.smallMultiplesGrid?.columns).toBe(12);
  });

  it('keeps the pre-Wave-6 scalar fields intact (no regression) and returns undefined when empty', () => {
    const out = sanitizeFormat({
      titleText: 'Hello', showTitle: true, showXAxis: false, showLegend: true,
      legendPosition: 'right', numberFormat: 'percent', stylePreset: 'bold',
    });
    expect(out).toMatchObject({
      titleText: 'Hello', showTitle: true, showXAxis: false, showLegend: true,
      legendPosition: 'right', numberFormat: 'percent', stylePreset: 'bold',
    });
    expect(sanitizeFormat({})).toBeUndefined();
    expect(sanitizeFormat(null)).toBeUndefined();
  });
});
