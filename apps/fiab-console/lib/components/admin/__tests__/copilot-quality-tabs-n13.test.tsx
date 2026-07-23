/**
 * CopilotQualityTabs — N13 "Prompts" + "Budgets" tab wiring (vitest jsdom).
 *
 * Asserts N13 folded its two surfaces into the EXISTING /admin/copilot-quality
 * tab strip (no orphan admin tile, no new admin page), that selecting each tab
 * mounts its panel against the REAL route it reads
 * (/api/admin/copilot-quality/prompts and /budgets — `fetch` is stubbed so we
 * exercise the client wiring without faking a backend, per no-vaporware.md),
 * and that the empty/first-open states are guided rather than red.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CopilotQualityTabs } from '../copilot-quality-tabs';

const PROMPTS_WITH_ROW = {
  ok: true,
  flagEnabled: true,
  evaluatorConfigured: true,
  prompts: [
    {
      promptId: 'help-system',
      surface: 'help',
      label: 'Help system prompt',
      description: 'Grounding instructions for the Learning Hub agent.',
      owner: 'admin@contoso.com',
      activeVersion: '1.1.0',
      activeScore: {
        surface: 'help', runId: 'run-1', finishedAt: '2026-07-23T10:00:00Z', questions: 12,
        retrievalHitRate: 0.9, groundingAvg: 4.3, passRate: 0.85,
        belowFloor: false, belowFloorMetrics: [], provisionalFloor: true,
      },
      activeApproval: { approvedBy: 'admin@contoso.com', approvedAt: '2026-07-23T10:30:00Z' },
      latestVersion: '1.1.0',
      latestStatus: 'approved',
      versionCount: 2,
      pendingApproval: false,
      updatedAt: '2026-07-23T10:30:00Z',
    },
  ],
};

const PROMPTS_EMPTY = { ok: true, flagEnabled: true, evaluatorConfigured: true, prompts: [] };

const BUDGETS_WITH_ROW = {
  ok: true,
  flagEnabled: true,
  totals: { tokens: 1500, usd: 0.02, turns: 3, over: 0, warning: 0 },
  rows: [
    {
      scope: 'workspace',
      scopeId: 'ws-1',
      label: 'Analytics',
      budget: { scope: 'workspace', scopeId: 'ws-1', period: 'monthly', limitTokens: 10000, enabled: true, updatedAt: '2026-07-23T10:00:00Z' },
      usage: {
        scope: 'workspace', scopeId: 'ws-1', period: 'monthly', periodKey: '2026-07',
        promptTokens: 1000, completionTokens: 500, totalTokens: 1500, usd: 0.02, tierUsd: 0.03,
        turns: 3, byTier: { standard: { tokens: 1500, usd: 0.02, turns: 3 } }, updatedAt: '2026-07-23T10:00:00Z',
      },
      verdict: {
        over: false, warning: false, usedTokens: 1500, limitTokens: 10000, remainingTokens: 8500,
        pctUsed: 0.15, usedUsd: 0.02, period: 'monthly', periodKey: '2026-07', resetsAt: '2026-08-01T00:00:00.000Z',
      },
    },
  ],
};

const BUDGETS_EMPTY = { ok: true, flagEnabled: true, rows: [], totals: { tokens: 0, usd: 0, turns: 0, over: 0, warning: 0 } };

function routeFetch(prompts: unknown, budgets: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: unknown = { ok: true, surfaces: [], domains: [], flagEnabled: true, evaluatorConfigured: true, overview: {} };
    if (url.includes('/api/admin/copilot-quality/prompts')) body = prompts;
    else if (url.includes('/api/admin/copilot-quality/budgets')) body = budgets;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

function renderTabs() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FluentProvider theme={webLightTheme}>
      <QueryClientProvider client={qc}>
        <CopilotQualityTabs />
      </QueryClientProvider>
    </FluentProvider>,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CopilotQualityTabs — N13 Prompts + Budgets tabs', () => {
  it('mounts the two new tabs alongside the existing three (one hub, no orphan page)', () => {
    vi.stubGlobal('fetch', routeFetch(PROMPTS_WITH_ROW, BUDGETS_WITH_ROW));
    renderTabs();
    expect(screen.getByRole('tab', { name: /Answer quality/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Search relevance/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Tier routing/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Prompts/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Budgets/i })).toBeTruthy();
  });

  it('selecting Prompts mounts the registry panel with the version + score summary', async () => {
    vi.stubGlobal('fetch', routeFetch(PROMPTS_WITH_ROW, BUDGETS_WITH_ROW));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Prompts/i }));
    expect(await screen.findByText(/Prompt registry/i)).toBeTruthy();
    expect(await screen.findByText(/Help system prompt/i)).toBeTruthy();
    expect(await screen.findByText(/active v1\.1\.0/i)).toBeTruthy();
    expect(await screen.findByText(/at\/above floor/i)).toBeTruthy();
  });

  it('selecting Budgets mounts the attribution dashboard with real spend', async () => {
    vi.stubGlobal('fetch', routeFetch(PROMPTS_WITH_ROW, BUDGETS_WITH_ROW));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Budgets/i }));
    expect(await screen.findByText(/Token budgets & attribution/i)).toBeTruthy();
    expect(await screen.findByText(/Tokens this period/i)).toBeTruthy();
    expect(await screen.findByText(/Analytics/i)).toBeTruthy();
    // the real per-scope spend from the usage ledger renders in the table
    expect(await screen.findByText(/1,500 \/ 10,000/i)).toBeTruthy();
  });

  it('shows guided EmptyStates (never an error banner) on a clean first open', async () => {
    vi.stubGlobal('fetch', routeFetch(PROMPTS_EMPTY, BUDGETS_EMPTY));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Prompts/i }));
    expect(await screen.findByText(/No prompts registered yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Budgets/i }));
    expect(await screen.findByText(/No attributed spend or budgets yet/i)).toBeTruthy();
  });

  it('honors the FLAG0 kill-switches with a guided notice instead of a blank tab', async () => {
    vi.stubGlobal('fetch', routeFetch(
      { ...PROMPTS_EMPTY, flagEnabled: false },
      { ...BUDGETS_EMPTY, flagEnabled: false },
    ));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Prompts/i }));
    expect(await screen.findByText(/Prompts tab is turned off/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Budgets/i }));
    expect(await screen.findByText(/Token budgets are turned off/i)).toBeTruthy();
  });
});
