/**
 * Pure helpers for the cost-estimate report's "Open Azure Pricing Calculator"
 * deep-link and the CSV/JSON export of the computed breakdown. No fetch, no
 * React — unit-testable.
 *
 * HONESTY NOTE: the Azure Pricing Calculator has no documented public API to
 * pre-populate an arbitrary resource list (shared estimates require an
 * interactive save), so the deep-link opens the calculator — it does NOT
 * auto-fill the plan. The real, machine-readable artifact is the CSV/JSON
 * export below, which the operator can transcribe or attach. Per-service
 * azure.microsoft.com/pricing/details links are surfaced per row instead.
 */
import type { CostSummary, CostRow } from './cost-estimate';

const CALC_COMMERCIAL = 'https://azure.microsoft.com/pricing/calculator/';
const CALC_GOV = 'https://azure.microsoft.com/pricing/calculator/'; // same tool; Gov price sheet differs

/** The Azure Pricing Calculator URL (boundary-aware base — same tool today). */
export function pricingCalculatorUrl(boundary?: string): string {
  return boundary && /gcc|il5|gov/i.test(boundary) ? CALC_GOV : CALC_COMMERCIAL;
}

/** Fallback per-service pricing-details URL when a row carries none. */
export function serviceDetailsUrl(row: CostRow): string {
  return row.pricingDetailsUrl || 'https://azure.microsoft.com/pricing/';
}

function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flat CSV of every priced row across domains + a total line. */
export function breakdownToCsv(summary: CostSummary): string {
  const header = ['Domain', 'Service', 'SKU', 'Unit', 'UnitPrice', 'Qty', 'MonthlyEstimate', 'Currency', 'Source', 'Assumption'];
  const lines = [header.join(',')];
  for (const dom of summary.byDomain) {
    for (const r of dom.rows) {
      lines.push([
        dom.name, r.label, r.sku, r.unit, r.unitPrice, r.qty,
        r.monthly.toFixed(2), summary.currency, r.source, r.assumed,
      ].map(csvCell).join(','));
    }
  }
  lines.push(['TOTAL', '', '', '', '', '', summary.total.toFixed(2), summary.currency, summary.source, ''].map(csvCell).join(','));
  for (const u of summary.unestimated) {
    lines.push(['(not estimated)', u.label, '', '', '', '', '', '', '', u.reason].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Pretty JSON of the full summary for attaching / machine consumption. */
export function breakdownToJson(summary: CostSummary): string {
  return JSON.stringify(summary, null, 2);
}

/** Trigger a client-side file download (no-op outside the browser). */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
