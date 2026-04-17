/**
 * Tests for the Dashboard (index) page.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock Next.js router
jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Mock the API hooks
jest.mock('@/hooks/useApi', () => ({
  useStats: () => ({
    data: {
      registered_sources: 26,
      active_pipelines: 35,
      data_products: 16,
      pending_access_requests: 2,
      total_data_volume_gb: 1247.6,
      last_24h_pipeline_runs: 35,
      avg_quality_score: 0.928,
    },
    isLoading: false,
  }),
  useDomainOverview: () => ({
    data: [
      { name: 'finance', source_count: 5, pipeline_count: 6, data_product_count: 3, avg_quality_score: 0.981, status: 'healthy' },
    ],
    isLoading: false,
  }),
  usePipelines: () => ({
    data: [],
  }),
}));

import DashboardPage from '@/pages/index';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('DashboardPage', () => {
  it('renders the page title', () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Platform Dashboard')).toBeInTheDocument();
  });

  it('displays platform stats', () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Registered Sources')).toBeInTheDocument();
    expect(screen.getByText('Active Pipelines')).toBeInTheDocument();
    expect(screen.getByText('Data Products')).toBeInTheDocument();
  });

  it('shows stat values from API data', () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('26')).toBeInTheDocument();
    // '35' appears twice: Active Pipelines and Pipeline Runs (24h)
    expect(screen.getAllByText('35')).toHaveLength(2);
    expect(screen.getByText('16')).toBeInTheDocument();
  });

  it('renders the Data Domains section', () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('Data Domains')).toBeInTheDocument();
  });

  it('displays domain cards', () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('finance')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});
