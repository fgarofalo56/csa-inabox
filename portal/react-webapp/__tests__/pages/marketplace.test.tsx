/**
 * Tests for the Data Marketplace page.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPush = jest.fn();

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/marketplace',
    push: mockPush,
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockUseDataProducts = jest.fn();
const mockUseDomains = jest.fn();

jest.mock('@/hooks/useApi', () => ({
  useDataProducts: (...args: unknown[]) => mockUseDataProducts(...args),
  useDomains: (...args: unknown[]) => mockUseDomains(...args),
}));

jest.mock('@/hooks/useDebounce', () => ({
  useDebounce: (val: unknown) => val,
}));

import MarketplacePage from '@/pages/marketplace/index';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const SAMPLE_PRODUCTS = [
  {
    id: 'dp-1',
    name: 'Customer 360',
    description: 'Unified view of customer interactions across channels',
    domain: 'marketing',
    owner: { name: 'Alice', email: 'alice@contoso.com', team: 'Data Science' },
    classification: 'internal',
    quality_score: 0.95,
    freshness_hours: 12,
    completeness: 0.98,
    availability: 0.999,
    tags: {},
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
  },
  {
    id: 'dp-2',
    name: 'Revenue Metrics',
    description: 'Daily revenue aggregation by product line',
    domain: 'finance',
    owner: { name: 'Bob', email: 'bob@contoso.com', team: 'Finance BI' },
    classification: 'confidential',
    quality_score: 0.72,
    freshness_hours: 48,
    completeness: 0.85,
    availability: 0.95,
    tags: {},
    created_at: '2025-02-01T00:00:00Z',
    updated_at: '2025-05-01T00:00:00Z',
  },
];

const SAMPLE_DOMAINS = [
  { name: 'marketing', product_count: 3 },
  { name: 'finance', product_count: 5 },
];

describe('MarketplacePage', () => {
  beforeEach(() => {
    mockUseDataProducts.mockReset();
    mockUseDomains.mockReset();
    mockPush.mockReset();
    mockUseDomains.mockReturnValue({ data: SAMPLE_DOMAINS });
  });

  it('renders the page heading', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('Data Marketplace')).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText(/Discover and request access/)).toBeInTheDocument();
  });

  // Loading state
  it('shows a loading spinner while data is loading', () => {
    mockUseDataProducts.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  // Error state
  it('shows an error banner when the API fails', () => {
    mockUseDataProducts.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Server error'),
      refetch: jest.fn(),
    });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('Failed to load data products')).toBeInTheDocument();
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });

  it('calls refetch when Retry is clicked on error', () => {
    const refetchFn = jest.fn();
    mockUseDataProducts.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('fail'),
      refetch: refetchFn,
    });
    renderWithProviders(<MarketplacePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchFn).toHaveBeenCalledTimes(1);
  });

  // Empty state
  it('shows empty-state text when no products are returned', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('No data products found.')).toBeInTheDocument();
    expect(screen.getByText(/Try adjusting your search criteria/)).toBeInTheDocument();
  });

  // Data rendering
  it('renders product cards when data is available', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('Customer 360')).toBeInTheDocument();
    expect(screen.getByText('Revenue Metrics')).toBeInTheDocument();
  });

  it('renders product descriptions', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText(/Unified view of customer interactions/)).toBeInTheDocument();
  });

  it('renders quality badges with percentage', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('renders domain labels on product cards', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('marketing')).toBeInTheDocument();
    expect(screen.getByText('finance')).toBeInTheDocument();
  });

  it('renders owner team info', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('by Data Science')).toBeInTheDocument();
    expect(screen.getByText('by Finance BI')).toBeInTheDocument();
  });

  it('renders Request Access buttons', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    const buttons = screen.getAllByText('Request Access');
    expect(buttons).toHaveLength(2);
  });

  it('navigates to access page when Request Access is clicked', () => {
    mockUseDataProducts.mockReturnValue({ data: SAMPLE_PRODUCTS, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    const buttons = screen.getAllByText('Request Access');
    fireEvent.click(buttons[0]);
    expect(mockPush).toHaveBeenCalledWith('/access?product_id=dp-1');
  });

  // Search and filter controls
  it('renders the search input', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByLabelText('Search data products')).toBeInTheDocument();
  });

  it('renders the domain filter dropdown with options from API', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    const select = screen.getByLabelText('Filter by domain');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('marketing (3)')).toBeInTheDocument();
    expect(screen.getByText('finance (5)')).toBeInTheDocument();
  });

  it('renders the quality filter dropdown', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByLabelText('Filter by minimum quality score')).toBeInTheDocument();
  });

  it('passes search text to useDataProducts', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    fireEvent.change(screen.getByLabelText('Search data products'), {
      target: { value: 'revenue' },
    });
    expect(mockUseDataProducts).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'revenue' }),
    );
  });

  it('passes domain filter to useDataProducts', () => {
    mockUseDataProducts.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    fireEvent.change(screen.getByLabelText('Filter by domain'), {
      target: { value: 'finance' },
    });
    expect(mockUseDataProducts).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'finance' }),
    );
  });

  it('formats freshness as hours when under 24h', () => {
    mockUseDataProducts.mockReturnValue({ data: [SAMPLE_PRODUCTS[0]], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('12h')).toBeInTheDocument();
  });

  it('formats freshness as days when 24h or more', () => {
    mockUseDataProducts.mockReturnValue({ data: [SAMPLE_PRODUCTS[1]], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<MarketplacePage />);
    expect(screen.getByText('2d')).toBeInTheDocument();
  });
});
