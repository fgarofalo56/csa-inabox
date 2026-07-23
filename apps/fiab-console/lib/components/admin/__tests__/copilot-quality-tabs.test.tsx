/**
 * CopilotQualityTabs — E6 "Tier routing" tab wiring (vitest jsdom).
 *
 * Asserts the third tab exists alongside Answer quality + Search relevance, and
 * that selecting it mounts the TierRoutingPanel, which reads the REAL
 * /api/admin/copilot-quality/tier route (here `fetch` is stubbed so we exercise
 * the client wiring — request shape + rendered summary — without faking the
 * evaluator, per no-vaporware.md). Two cases: a run present (accuracy + confusion
 * render) and no runs yet (guided EmptyState, clean first-open).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CopilotQualityTabs } from '../copilot-quality-tabs';

const TIER_WITH_RUN = {
  ok: true,
  flagEnabled: true,
  evaluatorConfigured: true,
  meanGrounding: 4,
  costPerQuality: [
    { tier: 'mini', label: 'Mini (cheapest)', coeff: 0.001, qualityPerDollar: 800 },
    { tier: 'standard', label: 'Standard (default)', coeff: 0.005, qualityPerDollar: 160 },
    { tier: 'strong', label: 'Strong (reasoning)', coeff: 0.01, qualityPerDollar: 80 },
  ],
  tier: {
    latest: { runId: 'r1', finishedAt: '2026-07-23T00:05:00Z', trigger: 'manual', totals: { rows: 60, tierAccuracy: 0.95, taskClassAccuracy: 0.93, matrix: { mini: { mini: 19, standard: 1, strong: 0 }, standard: { mini: 0, standard: 20, strong: 0 }, strong: { mini: 0, standard: 2, strong: 18 } }, perClass: { lightweight: { total: 20, correct: 19, accuracy: 0.95 }, general: { total: 20, correct: 20, accuracy: 1 }, reasoning: { total: 20, correct: 18, accuracy: 0.9 } } } },
    trend: [{ runId: 'r1', finishedAt: '2026-07-23T00:05:00Z', trigger: 'manual', tierAccuracy: 0.95, taskClassAccuracy: 0.93, rows: 60 }],
    grade: 'A',
    floorStatus: { metric: 'tierAccuracy', value: 0.95, floor: 0.85, verdict: 'ok' },
    belowFloor: false,
    provisionalFloor: true,
    runCount: 1,
    matrix: [
      { expectedTier: 'mini', cells: [{ chosenTier: 'mini', count: 19 }, { chosenTier: 'standard', count: 1 }, { chosenTier: 'strong', count: 0 }], total: 20 },
      { expectedTier: 'standard', cells: [{ chosenTier: 'mini', count: 0 }, { chosenTier: 'standard', count: 20 }, { chosenTier: 'strong', count: 0 }], total: 20 },
      { expectedTier: 'strong', cells: [{ chosenTier: 'mini', count: 0 }, { chosenTier: 'standard', count: 2 }, { chosenTier: 'strong', count: 18 }], total: 20 },
    ],
    perClass: [
      { taskClass: 'lightweight', label: 'Lightweight', total: 20, correct: 19, accuracy: 0.95 },
      { taskClass: 'general', label: 'General', total: 20, correct: 20, accuracy: 1 },
      { taskClass: 'reasoning', label: 'Reasoning', total: 20, correct: 18, accuracy: 0.9 },
    ],
  },
};

const TIER_EMPTY = { ok: true, flagEnabled: true, evaluatorConfigured: true, meanGrounding: null, costPerQuality: [], tier: null };

function routeFetch(tierBody: any) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: any = { ok: true, surfaces: [], domains: [], flagEnabled: true, evaluatorConfigured: true, overview: {} };
    if (url.includes('/api/admin/copilot-quality/tier')) body = tierBody;
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

describe('CopilotQualityTabs — Tier routing tab (E6)', () => {
  it('renders the three tabs including Tier routing', () => {
    vi.stubGlobal('fetch', routeFetch(TIER_WITH_RUN));
    renderTabs();
    expect(screen.getByRole('tab', { name: /Answer quality/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Search relevance/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Tier routing/i })).toBeTruthy();
  });

  it('selecting Tier routing mounts the panel and renders the accuracy summary', async () => {
    vi.stubGlobal('fetch', routeFetch(TIER_WITH_RUN));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Tier routing/i }));
    expect(await screen.findByText(/Tier-router decision quality/i)).toBeTruthy();
    // The confusion section + a labeled tile appear once the query resolves.
    expect(await screen.findByText(/Tier confusion/i)).toBeTruthy();
    expect(await screen.findByText(/Cost-per-quality/i)).toBeTruthy();
  });

  it('shows a guided EmptyState when no tier runs exist yet (clean first-open)', async () => {
    vi.stubGlobal('fetch', routeFetch(TIER_EMPTY));
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Tier routing/i }));
    expect(await screen.findByText(/No tier-routing runs yet/i)).toBeTruthy();
  });
});
