/**
 * Hub tab-strip wiring — IA-03 / IA-04 / IA-06 (vitest jsdom).
 *
 * loom-apex Phase B folded eleven standalone admin pages into three tabbed
 * hubs. These tests pin the wiring the fold depends on:
 *   • every folded surface is reachable as a tab,
 *   • the `?tab=` deep link the redirect stubs target selects that tab,
 *   • the Copilot-quality `?sub=` deep link (the token-budget Fix-it target)
 *     reaches the nested sub-tab,
 *   • the c4-finops-hub kill-switch hides ONLY the cockpit and never strands
 *     the user on a tab that no longer exists.
 *
 * The pane components are mocked to sentinels on purpose: each one is the SAME
 * component its standalone page rendered (moved, not rewritten) and carries its
 * own tests + real-backend coverage. What is NEW — and therefore what is under
 * test here — is the hub wiring around them.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/components/admin/finops-cockpit-pane', () => ({
  FinopsCockpitPane: () => <div>PANE:cockpit</div>,
}));
vi.mock('@/lib/components/admin/capacity-chargeback-pane', () => ({
  CapacityChargebackPane: () => <div>PANE:capacity</div>,
}));
vi.mock('@/lib/components/admin/chargeback-report-pane', () => ({
  ChargebackReportPane: () => <div>PANE:chargeback</div>,
}));
vi.mock('@/lib/components/admin/copilot-usage', () => ({
  CopilotUsagePane: () => <div>PANE:usage</div>,
}));
vi.mock('@/lib/components/admin/agent-quality-panel', () => ({
  AgentQualityPanel: () => <div>PANE:agents</div>,
}));
vi.mock('@/lib/components/admin/copilot-quality-tabs', () => ({
  COPILOT_QUALITY_SUBTABS: ['answers', 'search', 'tier', 'prompts', 'budgets'],
  CopilotQualityTabs: ({ initialTab }: { initialTab?: string }) => (
    <div>PANE:quality sub={initialTab ?? 'none'}</div>
  ),
}));
vi.mock('@/lib/components/admin/model-fabric-panel', () => ({
  ModelFabricPanel: () => <div>PANE:fabric</div>,
}));
vi.mock('@/lib/components/admin/parity-autopilot-panel', () => ({
  ParityAutopilotPanel: () => <div>PANE:autopilot</div>,
}));
vi.mock('@/lib/components/admin/access-requests-panel', () => ({
  AccessRequestsPanel: () => <div>PANE:requests</div>,
}));
vi.mock('@/lib/components/admin/access-report-panel', () => ({
  AccessReportPanel: () => <div>PANE:report</div>,
}));
vi.mock('@/lib/components/admin/access-packages-panel', () => ({
  AccessPackagesPanel: () => <div>PANE:packages</div>,
}));
vi.mock('@/lib/components/admin/access-reviews-panel', () => ({
  AccessReviewsPanel: () => <div>PANE:reviews</div>,
}));

import { FinopsHubTabs } from '../finops-hub-tabs';
import { AiOperationsTabs } from '../ai-operations-tabs';
import { AccessGovernanceTabs } from '../access-governance-tabs';

/** Point window.location.search at a hub deep link before mount. */
function deepLink(search: string) {
  window.history.replaceState({}, '', `/admin/hub${search}`);
}

/** The shared /api/runtime-flags read behind useRuntimeFlag. */
function flagsFetch(flags: Record<string, boolean>) {
  return vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, flags }),
  }) as unknown as Response);
}

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FluentProvider theme={webLightTheme}>{ui}</FluentProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', flagsFetch({}));
  deepLink('');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('FinopsHubTabs (IA-03)', () => {
  it('shows all three cost surfaces as tabs and opens on the cockpit', async () => {
    mount(<FinopsHubTabs />);
    expect(screen.getByRole('tab', { name: /Cockpit/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Capacity & LCU/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Chargeback report/ })).toBeTruthy();
    expect(screen.getByText('PANE:cockpit')).toBeTruthy();
  });

  it('honors the ?tab=capacity deep link the /admin/usage-chargeback stub targets', async () => {
    deepLink('?tab=capacity');
    mount(<FinopsHubTabs />);
    await waitFor(() => expect(screen.getByText('PANE:capacity')).toBeTruthy());
  });

  it('honors the ?tab=chargeback deep link the /admin/chargeback stub targets', async () => {
    deepLink('?tab=chargeback');
    mount(<FinopsHubTabs />);
    await waitFor(() => expect(screen.getByText('PANE:chargeback')).toBeTruthy());
  });

  it('kill-switch OFF hides only the cockpit and falls back to capacity', async () => {
    vi.stubGlobal('fetch', flagsFetch({ 'c4-finops-hub': false }));
    mount(<FinopsHubTabs />);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Cockpit/ })).toBeNull());
    expect(screen.getByRole('tab', { name: /Capacity & LCU/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Chargeback report/ })).toBeTruthy();
    expect(screen.getByText('PANE:capacity')).toBeTruthy();
    // Honest explanation, not a silent disappearance.
    expect(screen.getByText(/FinOps cockpit is turned off/)).toBeTruthy();
  });
});

describe('AiOperationsTabs (IA-04)', () => {
  it('carries all five folded surfaces as tabs', () => {
    mount(<AiOperationsTabs />);
    for (const name of [/Usage/, /Agent quality/, /Copilot quality/, /Model Fabric/, /Parity Autopilot/]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }
    expect(screen.getByText('PANE:usage')).toBeTruthy();
  });

  it.each([
    ['agents', 'PANE:agents'],
    ['fabric', 'PANE:fabric'],
    ['autopilot', 'PANE:autopilot'],
  ])('honors the ?tab=%s deep link', async (tab, sentinel) => {
    deepLink(`?tab=${tab}`);
    mount(<AiOperationsTabs />);
    await waitFor(() => expect(screen.getByText(sentinel)).toBeTruthy());
  });

  it('passes ?sub= through to the Copilot-quality sub-tabs (token-budget Fix-it target)', async () => {
    deepLink('?tab=quality&sub=budgets');
    mount(<AiOperationsTabs />);
    await waitFor(() => expect(screen.getByText('PANE:quality sub=budgets')).toBeTruthy());
  });

  it('ignores an unknown ?sub= rather than blanking the sub-tab', async () => {
    deepLink('?tab=quality&sub=bogus');
    mount(<AiOperationsTabs />);
    await waitFor(() => expect(screen.getByText('PANE:quality sub=none')).toBeTruthy());
  });
});

describe('AccessGovernanceTabs (IA-06)', () => {
  it('carries all four folded surfaces as tabs', () => {
    mount(<AccessGovernanceTabs />);
    for (const name of [/Requests/, /Report/, /Packages/, /Reviews/]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }
    expect(screen.getByText('PANE:requests')).toBeTruthy();
  });

  it.each([
    ['report', 'PANE:report'],
    ['packages', 'PANE:packages'],
    ['reviews', 'PANE:reviews'],
  ])('honors the ?tab=%s deep link', async (tab, sentinel) => {
    deepLink(`?tab=${tab}`);
    mount(<AccessGovernanceTabs />);
    await waitFor(() => expect(screen.getByText(sentinel)).toBeTruthy());
  });
});
