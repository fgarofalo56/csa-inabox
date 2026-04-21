/**
 * Tests for the minimal Dashboard page at `/dashboard` (CSA-0121).
 *
 * Covers:
 *   - Loading skeleton is announced to assistive tech.
 *   - KPI cards render total sources, 24h pipeline success rate, and
 *     pending access requests once the mocked API resolves.
 *   - Top 5 marketplace products render sorted by quality score.
 *   - Error path surfaces the shared ErrorBanner.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/dashboard',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockUseStats = jest.fn();
const mockUseDomainOverview = jest.fn();
const mockUsePipelines = jest.fn();
const mockUseDataProducts = jest.fn();
// CSA-0124(14): the dashboard now hosts <ActivityFeed/>, which in turn
// calls useAccessRequests. Mock it so the dashboard test doesn't explode
// with "useAccessRequests is not a function".
const mockUseAccessRequests = jest.fn();

jest.mock('@/hooks/useApi', () => ({
  useStats: (...args: unknown[]) => mockUseStats(...args),
  useDomainOverview: (...args: unknown[]) => mockUseDomainOverview(...args),
  usePipelines: (...args: unknown[]) => mockUsePipelines(...args),
  useDataProducts: (...args: unknown[]) => mockUseDataProducts(...args),
  useAccessRequests: (...args: unknown[]) => mockUseAccessRequests(...args),
}));

import DashboardPage from '@/pages/dashboard';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const PIPELINES = [
  { id: 'p1', status: 'succeeded' },
  { id: 'p2', status: 'succeeded' },
  { id: 'p3', status: 'failed' },
  { id: 'p4', status: 'succeeded' },
];

const PRODUCTS = [
  { id: 'dp1', name: 'Alpha', domain: 'finance', quality_score: 0.72 },
  { id: 'dp2', name: 'Beta', domain: 'hr', quality_score: 0.95 },
  { id: 'dp3', name: 'Gamma', domain: 'marketing', quality_score: 0.81 },
  { id: 'dp4', name: 'Delta', domain: 'operations', quality_score: 0.88 },
  { id: 'dp5', name: 'Epsilon', domain: 'finance', quality_score: 0.99 },
  { id: 'dp6', name: 'Zeta', domain: 'sales', quality_score: 0.64 },
];

const DOMAINS = [
  { name: 'finance', source_count: 5, pipeline_count: 3, data_product_count: 2, avg_quality_score: 0.9, status: 'healthy' },
  { name: 'hr', source_count: 2, pipeline_count: 1, data_product_count: 1, avg_quality_score: 0.85, status: 'warning' },
];

const STATS = {
  registered_sources: 7,
  active_pipelines: 4,
  data_products: 6,
  pending_access_requests: 3,
  total_data_volume_gb: 120,
  last_24h_pipeline_runs: 4,
  avg_quality_score: 0.87,
};

describe('DashboardPage (/dashboard)', () => {
  beforeEach(() => {
    mockUseStats.mockReset();
    mockUseDomainOverview.mockReset();
    mockUsePipelines.mockReset();
    mockUseDataProducts.mockReset();
    // ActivityFeed calls useAccessRequests — default to an empty list so
    // tests that don't care about it still render cleanly.
    mockUseAccessRequests.mockReset();
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it('renders the loading skeleton when stats are loading', () => {
    mockUseStats.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: jest.fn() });
    mockUseDomainOverview.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockUsePipelines.mockReturnValue({ data: undefined });
    mockUseDataProducts.mockReturnValue({ data: undefined, isLoading: true });

    renderWithProviders(<DashboardPage />);
    expect(
      screen.getByRole('status', { name: 'Loading dashboard' }),
    ).toBeInTheDocument();
  });

  it('renders KPI cards with live stats once loaded', () => {
    mockUseStats.mockReturnValue({ data: STATS, isLoading: false, error: null, refetch: jest.fn() });
    mockUseDomainOverview.mockReturnValue({ data: DOMAINS, isLoading: false, error: null });
    mockUsePipelines.mockReturnValue({ data: PIPELINES });
    mockUseDataProducts.mockReturnValue({ data: PRODUCTS, isLoading: false });

    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Total sources')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Pending access requests')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 3 of 4 pipelines succeeded → 75%.
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders the sources-by-domain table with each domain row', () => {
    mockUseStats.mockReturnValue({ data: STATS, isLoading: false, error: null, refetch: jest.fn() });
    mockUseDomainOverview.mockReturnValue({ data: DOMAINS, isLoading: false, error: null });
    mockUsePipelines.mockReturnValue({ data: PIPELINES });
    mockUseDataProducts.mockReturnValue({ data: PRODUCTS, isLoading: false });

    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Sources by domain')).toBeInTheDocument();
    // Domain names also appear in the top-products table as product
    // domains, so assert via getAllByText.
    expect(screen.getAllByText('finance').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('hr').length).toBeGreaterThanOrEqual(1);
    // Source counts "5" and "2" appear only in the domain table.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the top 5 products sorted by quality score', () => {
    mockUseStats.mockReturnValue({ data: STATS, isLoading: false, error: null, refetch: jest.fn() });
    mockUseDomainOverview.mockReturnValue({ data: DOMAINS, isLoading: false, error: null });
    mockUsePipelines.mockReturnValue({ data: PIPELINES });
    mockUseDataProducts.mockReturnValue({ data: PRODUCTS, isLoading: false });

    renderWithProviders(<DashboardPage />);
    expect(
      screen.getByText('Top 5 data products by quality score'),
    ).toBeInTheDocument();
    // Top 5 are Epsilon(99), Beta(95), Delta(88), Gamma(81), Alpha(72).
    // Zeta (64) must NOT render.
    expect(screen.getByText('Epsilon')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Delta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Zeta')).not.toBeInTheDocument();
  });

  it('surfaces the error banner when stats fails to load', () => {
    mockUseStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch: jest.fn(),
    });
    mockUseDomainOverview.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockUsePipelines.mockReturnValue({ data: undefined });
    mockUseDataProducts.mockReturnValue({ data: undefined, isLoading: false });

    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Failed to load dashboard')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('falls back to an em dash for pipeline success when there are no runs', () => {
    mockUseStats.mockReturnValue({
      data: { ...STATS, last_24h_pipeline_runs: 0 },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseDomainOverview.mockReturnValue({ data: DOMAINS, isLoading: false, error: null });
    mockUsePipelines.mockReturnValue({ data: [] });
    mockUseDataProducts.mockReturnValue({ data: PRODUCTS, isLoading: false });

    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('No runs in the last 24h')).toBeInTheDocument();
  });
});
