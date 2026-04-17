/**
 * Tests for the Sources list page.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock Next.js router
jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/sources',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Default mock — overridden per test via mockReturnValue
const mockUseSources = jest.fn();

jest.mock('@/hooks/useApi', () => ({
  useSources: (...args: unknown[]) => mockUseSources(...args),
}));

jest.mock('@/hooks/useDebounce', () => ({
  useDebounce: (val: unknown) => val,
}));

import SourcesPage from '@/pages/sources/index';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const SAMPLE_SOURCES = [
  {
    id: 'src-1',
    name: 'Finance SQL DB',
    description: 'Primary financial data source for reporting',
    source_type: 'azure_sql',
    domain: 'finance',
    status: 'active' as const,
    classification: 'internal',
    updated_at: '2025-06-01T12:00:00Z',
    created_at: '2025-01-01T12:00:00Z',
    connection: {},
    ingestion: { mode: 'full' as const },
    target: { format: 'delta' as const, container: 'bronze', path_pattern: '', landing_zone: '' },
    owner: { name: 'Alice', email: 'alice@contoso.com', team: 'Data' },
    tags: {},
  },
  {
    id: 'src-2',
    name: 'HR Cosmos DB',
    description: 'Employee records from HR system',
    source_type: 'cosmos_db',
    domain: 'hr',
    status: 'pending_approval' as const,
    classification: 'confidential',
    updated_at: '2025-05-15T08:30:00Z',
    created_at: '2025-02-01T08:30:00Z',
    connection: {},
    ingestion: { mode: 'incremental' as const },
    target: { format: 'delta' as const, container: 'bronze', path_pattern: '', landing_zone: '' },
    owner: { name: 'Bob', email: 'bob@contoso.com', team: 'HR' },
    tags: {},
  },
];

describe('SourcesPage', () => {
  beforeEach(() => {
    mockUseSources.mockReset();
  });

  it('renders the page heading', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('Data Sources')).toBeInTheDocument();
  });

  it('shows the Register Source link', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('+ Register Source')).toBeInTheDocument();
  });

  // Loading state
  it('shows a loading indicator while data is loading', () => {
    mockUseSources.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  // Error state
  it('shows an error banner when the API returns an error', () => {
    mockUseSources.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network failure'),
      refetch: jest.fn(),
    });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('Failed to load sources')).toBeInTheDocument();
    expect(screen.getByText('Network failure')).toBeInTheDocument();
  });

  it('calls refetch when the Retry button is clicked on error', () => {
    const refetchFn = jest.fn();
    mockUseSources.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('fail'),
      refetch: refetchFn,
    });
    renderWithProviders(<SourcesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchFn).toHaveBeenCalledTimes(1);
  });

  // Empty state
  it('shows an empty-state message when no sources exist', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(
      screen.getByText(/No data sources found/),
    ).toBeInTheDocument();
  });

  // Data rendering
  it('renders source rows when data is returned', () => {
    mockUseSources.mockReturnValue({ data: SAMPLE_SOURCES, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('Finance SQL DB')).toBeInTheDocument();
    expect(screen.getByText('HR Cosmos DB')).toBeInTheDocument();
  });

  it('renders the correct status badges', () => {
    mockUseSources.mockReturnValue({ data: SAMPLE_SOURCES, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    // "Active" appears both in the status filter <option> and the badge <span>
    const activeElements = screen.getAllByText('Active');
    expect(activeElements.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('displays domains for each source', () => {
    mockUseSources.mockReturnValue({ data: SAMPLE_SOURCES, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('finance')).toBeInTheDocument();
    expect(screen.getByText('hr')).toBeInTheDocument();
  });

  it('displays source type with underscores replaced by spaces', () => {
    mockUseSources.mockReturnValue({ data: SAMPLE_SOURCES, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('azure sql')).toBeInTheDocument();
    expect(screen.getByText('cosmos db')).toBeInTheDocument();
  });

  // Filter controls
  it('renders the domain filter input', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByLabelText('Filter sources by domain')).toBeInTheDocument();
  });

  it('renders the status filter select', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByLabelText('Filter sources by status')).toBeInTheDocument();
  });

  it('passes filter values to useSources', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);

    // Type into the domain filter
    fireEvent.change(screen.getByLabelText('Filter sources by domain'), {
      target: { value: 'finance' },
    });

    // The hook should be called with the updated domain (debounced mock returns value immediately)
    expect(mockUseSources).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'finance' }),
    );
  });

  it('passes status filter to useSources', () => {
    mockUseSources.mockReturnValue({ data: [], isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);

    fireEvent.change(screen.getByLabelText('Filter sources by status'), {
      target: { value: 'active' },
    });

    expect(mockUseSources).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('renders table headers', () => {
    mockUseSources.mockReturnValue({ data: SAMPLE_SOURCES, isLoading: false, error: null, refetch: jest.fn() });
    renderWithProviders(<SourcesPage />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Classification')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });
});
