/**
 * EstateAlwaysOnSection render tests (#5099 phase C). jsdom only: NOT a G1 browser
 * E2E (ux-baseline.md G1 - the live click-walk is still owed). Every `it` names the
 * input that breaks it (assertion-design.md).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const jsonGet = vi.fn();
vi.mock('@/lib/components/admin-scaling/json-get', () => ({ jsonGet: (...a: unknown[]) => jsonGet(...a) }));

import { EstateAlwaysOnSection, costBadgeText, formatMoney } from '../estate-always-on-section';

const mount = () => render(<FluentProvider theme={webLightTheme}><EstateAlwaysOnSection /></FluentProvider>);
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const totals = {
  actualMtd: { amount: 0, rows: 0 },
  estimateMonthly: { amount: 0, currency: 'USD', rows: 0 },
  unknownRows: 0,
};
const FW_ROW = {
  resourceId: '/subscriptions/s/fw', name: 'fw-hub', resourceType: 'microsoft.network/azurefirewalls', typeLabel: 'Azure Firewall',
  location: 'eastus',
  reason: "Never paused: the console's outbound traffic routes through it, so a deallocated firewall would make a paused estate impossible to resume from Loom.",
  cost: {
    source: 'estimate', amount: 912.5, currency: 'USD', label: 'estimate (list price, East US)',
    detail: 'Azure Firewall Standard, deployment charge only, 1.25 USD/h x 730 h. List price excludes discounts; this is NOT actual spend.',
  },
};
const BAS_ROW = {
  resourceId: '/subscriptions/s/bas', name: 'bas-hub', resourceType: 'microsoft.network/bastionhosts', typeLabel: 'Azure Bastion',
  reason: 'Azure has no stop verb for Bastion; the only way to stop the charge is to delete it, which Loom never does on its own.',
  cost: { source: 'actual', amount: 0 } as unknown,
};
const ACTUAL_BAS = { ...BAS_ROW, cost: { source: 'actual-mtd', amount: 140.12, currency: 'USD', label: 'actual month-to-date (Cost Management)', detail: 'Month-to-date spend reported by Azure Cost Management.' } };
const UNKNOWN_ROW = {
  resourceId: '/subscriptions/s/pv', name: 'pv-acct', resourceType: 'microsoft.purview/accounts', typeLabel: 'Microsoft Purview',
  reason: 'Azure has no stop verb for Purview; the account bills for its capacity units while it exists.',
  cost: { source: 'unknown', label: 'cost unknown', detail: 'This SKU is not in the list-price table (or the resource is usage-priced).' },
};
const ok = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true, rows, incomplete: false,
  totals: { ...totals, actualMtd: { amount: 140.12, currency: 'USD', rows: 1 }, estimateMonthly: { amount: 912.5, currency: 'USD', rows: 1 }, unknownRows: 1 },
  ...extra,
});

beforeEach(() => { jsonGet.mockReset(); });
afterEach(() => { cleanup(); });

describe('EstateAlwaysOnSection', () => {
  // Breaks if: the loading state is a blank gap (or the fetch never targets the always-on route).
  it('shows a skeleton while loading, from GET /api/admin/estate/always-on', async () => {
    jsonGet.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByTestId('estate-always-on-loading')).toBeTruthy();
    expect(jsonGet).toHaveBeenCalledWith('/api/admin/estate/always-on');
    expect(screen.queryAllByTestId('estate-always-on-row')).toHaveLength(0);
  });

  // Breaks if: any row field (name, type, reason, cost) is not rendered, or the Firewall reason is altered.
  it('renders each row: name, type label, plain-words reason and cost', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW, ACTUAL_BAS, UNKNOWN_ROW]));
    mount();
    await settle();
    const rows = screen.getAllByTestId('estate-always-on-row');
    expect(rows).toHaveLength(3);
    const fw = rows[0].textContent ?? '';
    expect(fw).toContain('fw-hub');
    expect(fw).toContain('Azure Firewall');
    expect(fw).toContain("console's outbound traffic routes through it");
    expect(fw).toContain('impossible to resume from Loom');
    expect(rows[1].textContent).toContain('no stop verb for Bastion');
    expect(rows[2].textContent).toContain('Microsoft Purview');
  });

  // THE R7 CASE. Breaks if: an estimate badge drops the word "estimate" or shows without a tilde, or an actual says "estimate".
  it('cost badges carry their provenance: estimate says estimate, actual says actual month-to-date, unknown shows no number', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW, ACTUAL_BAS, UNKNOWN_ROW]));
    mount();
    await settle();
    const badges = screen.getAllByTestId('estate-always-on-cost').map((b) => b.textContent ?? '');
    expect(badges[0]).toBe('~$912.50 / month, estimate (list price, East US)');
    expect(badges[0]).not.toContain('actual');
    expect(badges[1]).toBe('$140.12 actual month-to-date (Cost Management)');
    expect(badges[1]).not.toContain('estimate');
    expect(badges[2]).toBe('cost unknown');
    expect(badges[2]).not.toMatch(/\d/); // no number is invented
    // the card also repeats the caveat in words
    expect(screen.getAllByTestId('estate-always-on-row')[0].textContent).toContain('NOT actual spend');
  });

  // Breaks if: actual and estimate are added into one figure.
  it('totals keep actual and estimate SEPARATE (never one summed figure)', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW, ACTUAL_BAS, UNKNOWN_ROW]));
    mount();
    await settle();
    const t = screen.getByTestId('estate-always-on-totals').textContent ?? '';
    expect(t).toContain('actual month-to-date: $140.12 (1)');
    expect(t).toContain('estimate, list price per month: ~$912.50 (1)');
    expect(t).toContain('cost unknown: 1');
    expect(t).not.toContain('1,052.62'); // 140.12 + 912.50 would be the dishonest sum
  });

  // Breaks if: a failed inventory renders as the empty state ("nothing always-on").
  it('INCOMPLETE inventory (response says so): warning with the note, the empty state is NOT shown', async () => {
    jsonGet.mockResolvedValue({
      ok: true, rows: [], incomplete: true, totals,
      note: 'inventory incomplete: the Azure Resource Graph query failed, so the always-on resources are NOT listed. Raw: AuthorizationFailed-xyz',
    });
    mount();
    await settle();
    const warn = screen.getByTestId('estate-always-on-incomplete').textContent ?? '';
    expect(warn).toContain('AuthorizationFailed-xyz');
    expect(warn).toContain('not a statement that nothing is always on');
    expect(screen.queryByTestId('estate-always-on-empty')).toBeNull();
  });

  // Breaks if: a request failure (ok:false / timeout) renders as an empty list.
  it('REQUEST failure (ok:false): "inventory incomplete: <reason>", never the empty state', async () => {
    jsonGet.mockResolvedValue({ ok: false, error: 'Timed out loading /api/admin/estate/always-on' });
    mount();
    await settle();
    expect(screen.getByTestId('estate-always-on-incomplete').textContent).toContain('inventory incomplete: Timed out loading');
    expect(screen.queryByTestId('estate-always-on-empty')).toBeNull();
  });

  // Breaks if: an unexpected body (wrong route, shape drift) is treated as an empty inventory.
  it('an unexpected response shape is an incomplete inventory, not an empty one', async () => {
    jsonGet.mockResolvedValue({ ok: true, state: 'RUNNING' });
    mount();
    await settle();
    expect(screen.getByTestId('estate-always-on-incomplete').textContent).toContain('unexpected response');
    expect(screen.queryByTestId('estate-always-on-empty')).toBeNull();
  });

  // Breaks if: incomplete hides the rows that WERE found (positive pair for the absence checks above).
  it('incomplete WITH rows: the warning and the rows are both shown', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW], { incomplete: true, note: 'inventory incomplete: subscription x unreadable' }));
    mount();
    await settle();
    expect(screen.getByTestId('estate-always-on-incomplete')).toBeTruthy();
    expect(screen.getAllByTestId('estate-always-on-row')).toHaveLength(1);
  });

  // Breaks if: a COMPLETE zero-row answer shows no designed empty state (the only time "nothing" may be said).
  it('complete and empty: the designed empty state, no warning', async () => {
    jsonGet.mockResolvedValue(ok([], { totals }));
    mount();
    await settle();
    expect(screen.getByTestId('estate-always-on-empty').textContent).toContain('Nothing always-on found');
    expect(screen.queryByTestId('estate-always-on-incomplete')).toBeNull();
  });

  // Breaks if: a failed actual-cost read is not disclosed.
  it('shows the cost note when actual cost could not be read', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW], { costNote: 'Actual cost could not be read for every subscription (aaa: 429).' }));
    mount();
    await settle();
    expect(screen.getByTestId('estate-always-on-cost-note').textContent).toContain('aaa: 429');
  });

  // Breaks if: the link to the existing hold-out list is dropped (the reasons would then be duplicated or lost).
  it('links to the existing "deliberately NOT paused" list instead of repeating it', async () => {
    jsonGet.mockResolvedValue(ok([FW_ROW]));
    mount();
    await settle();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('#estate-held-out');
  });

  // NARROW WIDTH (jsdom has no layout, so this pins the CSS contract that prevents overlap, not pixels):
  // Breaks if: a long name/badge row loses wrap or min-width:0 (the overlap defect class).
  it('narrow width: rows and badge rows carry flex-wrap / min-width:0 / wrapping badge text (no overlap contract)', async () => {
    const longName = 'a-very-long-resource-name-that-would-overflow-a-narrow-card-if-it-were-not-allowed-to-wrap-anywhere';
    jsonGet.mockResolvedValue(ok([{ ...FW_ROW, name: longName }]));
    const { container } = mount();
    await settle();
    const card = screen.getByTestId('estate-always-on-row');
    expect(card.textContent).toContain(longName);
    // Griffel inserts atomic rules through CSSOM (insertRule), so read the sheets' rules, not <style> text.
    const css = Array.from(document.styleSheets)
      .flatMap((sh) => Array.from(sh.cssRules))
      .map((r) => r.cssText.replace(/\s+/g, ''))
      .join('\n');
    const classOf = (el: Element | null) => (el?.className ?? '').toString().split(/\s+/);
    const badgeRow = card.querySelectorAll('div')[1];
    const costBadge = screen.getByTestId('estate-always-on-cost');
    const rulesFor = (cls: string[]) => cls.flatMap((c) => css.match(new RegExp(`\\.${c}[^{]*\\{[^}]*\\}`, 'g')) ?? []).join(' ');
    const badgeRowCss = rulesFor(classOf(badgeRow));
    expect(badgeRowCss).toContain('flex-wrap:wrap');
    expect(badgeRowCss).toContain('min-width:0');
    const costCss = rulesFor(classOf(costBadge));
    expect(costCss).toContain('white-space:normal');
    expect(costCss).toContain('max-width:100%');
    expect(container.querySelector('[data-testid="estate-always-on-row"]')).toBeTruthy();
  });
});

describe('pure helpers', () => {
  // Breaks if: an unknown currency is shown as dollars.
  it('formatMoney: known currency formats; unknown currency says it was not reported', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatMoney(5, undefined)).toBe('5.00 (currency not reported)');
  });
  // Breaks if: an estimate without an amount is shown as a number.
  it('costBadgeText: an estimate with no amount is "cost unknown"', () => {
    expect(costBadgeText({ source: 'estimate', label: 'estimate (list price, East US)', detail: '' })).toBe('cost unknown');
  });
});
