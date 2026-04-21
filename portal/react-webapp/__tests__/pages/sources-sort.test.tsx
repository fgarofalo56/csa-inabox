/**
 * Tests for CSA-0124(5)/(7) on the Sources list page:
 *   - Column-sortable table via `useColumnSort`.
 *   - URL-synced domain/status filters (deep-linkable).
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockReplace = jest.fn();
let routerState: {
  isReady: boolean;
  query: Record<string, string | undefined>;
} = {
  isReady: true,
  query: {},
};

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/sources',
    isReady: routerState.isReady,
    query: routerState.query,
    push: jest.fn(),
    replace: mockReplace,
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

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

const SAMPLE = [
  {
    id: 'src-a',
    name: 'Bravo DB',
    description: '',
    source_type: 'azure_sql',
    domain: 'hr',
    status: 'active' as const,
    classification: 'internal',
    updated_at: '2025-01-10T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    connection: {},
    ingestion: { mode: 'full' as const },
    target: { format: 'delta' as const, container: 'b', path_pattern: '', landing_zone: '' },
    owner: { name: 'A', email: 'a@x.com', team: 'Y' },
    tags: {},
  },
  {
    id: 'src-b',
    name: 'alpha Warehouse',
    description: '',
    source_type: 'synapse',
    domain: 'finance',
    status: 'active' as const,
    classification: 'internal',
    updated_at: '2025-09-01T00:00:00Z',
    created_at: '2025-02-01T00:00:00Z',
    connection: {},
    ingestion: { mode: 'full' as const },
    target: { format: 'delta' as const, container: 'b', path_pattern: '', landing_zone: '' },
    owner: { name: 'B', email: 'b@x.com', team: 'Y' },
    tags: {},
  },
  {
    id: 'src-c',
    name: 'Charlie Stream',
    description: '',
    source_type: 'cosmos_db',
    domain: 'marketing',
    status: 'pending_approval' as const,
    classification: 'confidential',
    updated_at: '2025-05-01T00:00:00Z',
    created_at: '2025-03-01T00:00:00Z',
    connection: {},
    ingestion: { mode: 'incremental' as const },
    target: { format: 'delta' as const, container: 'b', path_pattern: '', landing_zone: '' },
    owner: { name: 'C', email: 'c@x.com', team: 'Y' },
    tags: {},
  },
];

describe('SourcesPage — column sort (CSA-0124(5))', () => {
  beforeEach(() => {
    mockUseSources.mockReset();
    mockReplace.mockReset();
    routerState = { isReady: true, query: {} };
    mockUseSources.mockReturnValue({
      data: SAMPLE,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('renders each column header as a sort button with aria-sort="none" initially', () => {
    renderWithProviders(<SourcesPage />);
    const sortButton = screen.getByRole('button', { name: 'Sort by Name' });
    expect(sortButton).toBeInTheDocument();
    const nameHeader = sortButton.closest('th');
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts ascending when a header is clicked and flips descending on second click', () => {
    const { container } = renderWithProviders(<SourcesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name' }));
    // After click 1: ascending — alpha < Bravo < Charlie (locale-aware)
    let firstCell = container.querySelector('tbody tr:first-child td a');
    expect(firstCell?.textContent).toBe('alpha Warehouse');
    let nameTh = screen.getByRole('button', { name: 'Sort by Name' }).closest('th');
    expect(nameTh).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name' }));
    firstCell = container.querySelector('tbody tr:first-child td a');
    expect(firstCell?.textContent).toBe('Charlie Stream');
    nameTh = screen.getByRole('button', { name: 'Sort by Name' }).closest('th');
    expect(nameTh).toHaveAttribute('aria-sort', 'descending');
  });

  it('clears the sort after a third click', () => {
    const { container } = renderWithProviders(<SourcesPage />);
    const button = screen.getByRole('button', { name: 'Sort by Name' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    // Natural order restored — Bravo DB came first in the source array.
    const firstCell = container.querySelector('tbody tr:first-child td a');
    expect(firstCell?.textContent).toBe('Bravo DB');
    const nameTh = button.closest('th');
    expect(nameTh).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts by updated_at using chronological order', () => {
    const { container } = renderWithProviders(<SourcesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Updated' }));
    // ascending: Jan → May → Sep
    const rows = container.querySelectorAll('tbody tr td:first-child a');
    expect(rows[0].textContent).toBe('Bravo DB');
    expect(rows[1].textContent).toBe('Charlie Stream');
    expect(rows[2].textContent).toBe('alpha Warehouse');
  });
});

describe('SourcesPage — URL-synced filter state (CSA-0124(7))', () => {
  beforeEach(() => {
    mockUseSources.mockReset();
    mockReplace.mockReset();
    mockUseSources.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('hydrates the domain filter from the URL on mount', () => {
    routerState = { isReady: true, query: { domain: 'finance' } };
    renderWithProviders(<SourcesPage />);
    const input = screen.getByLabelText('Filter sources by domain') as HTMLInputElement;
    expect(input.value).toBe('finance');
  });

  it('calls router.replace with the new filter values when user types', () => {
    routerState = { isReady: true, query: {} };
    renderWithProviders(<SourcesPage />);
    fireEvent.change(screen.getByLabelText('Filter sources by domain'), {
      target: { value: 'marketing' },
    });
    // router.replace should be called with query.domain = 'marketing'
    const lastCall = mockReplace.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall?.[0]).toMatchObject({
      pathname: '/sources',
      query: { domain: 'marketing' },
    });
    // shallow-routing option preserved
    expect(lastCall?.[2]).toMatchObject({ shallow: true });
  });

  it('hydrates the status filter from the URL on mount', () => {
    routerState = { isReady: true, query: { status: 'active' } };
    renderWithProviders(<SourcesPage />);
    const select = screen.getByLabelText('Filter sources by status') as HTMLSelectElement;
    expect(select.value).toBe('active');
  });

  it('omits empty values from the replaced query', () => {
    routerState = { isReady: true, query: { domain: 'finance' } };
    renderWithProviders(<SourcesPage />);
    // Clear the domain filter by typing an empty string
    fireEvent.change(screen.getByLabelText('Filter sources by domain'), {
      target: { value: '' },
    });
    const lastCall = mockReplace.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ pathname: '/sources', query: {} });
  });
});

describe('SourcesPage — sort button accessibility', () => {
  beforeEach(() => {
    mockUseSources.mockReset();
    mockReplace.mockReset();
    routerState = { isReady: true, query: {} };
    mockUseSources.mockReturnValue({
      data: SAMPLE,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('each table header carries a sort-by-<column> button', () => {
    renderWithProviders(<SourcesPage />);
    for (const label of ['Name', 'Type', 'Domain', 'Status', 'Classification', 'Updated']) {
      expect(
        screen.getByRole('button', { name: `Sort by ${label}` }),
      ).toBeInTheDocument();
    }
  });

  it('only the active column has aria-sort≠none', () => {
    const { container } = renderWithProviders(<SourcesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Domain' }));
    const headers = container.querySelectorAll('thead th');
    const nonNone = Array.from(headers).filter(
      (h) => h.getAttribute('aria-sort') !== 'none',
    );
    expect(nonNone.length).toBe(1);
    expect(within(nonNone[0] as HTMLElement).getByRole('button')).toHaveTextContent('Domain');
  });
});
