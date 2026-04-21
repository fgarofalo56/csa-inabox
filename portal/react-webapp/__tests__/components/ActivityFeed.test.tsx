/**
 * Tests for the ActivityFeed component (CSA-0124(14)).
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/dashboard',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockUsePipelines = jest.fn();
const mockUseAccessRequests = jest.fn();

jest.mock('@/hooks/useApi', () => ({
  usePipelines: (...args: unknown[]) => mockUsePipelines(...args),
  useAccessRequests: (...args: unknown[]) => mockUseAccessRequests(...args),
}));

import { ActivityFeed, formatRelativeTime } from '@/components/ActivityFeed';

const NOW = new Date('2026-04-20T12:00:00Z');

function hoursAgoISO(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('formatRelativeTime', () => {
  it('returns "just now" for < 45 seconds', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 10_000), NOW)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime(new Date(hoursAgoISO(2)), NOW)).toBe('2h ago');
  });

  it('formats days', () => {
    expect(formatRelativeTime(new Date(hoursAgoISO(48)), NOW)).toBe('2d ago');
  });

  it('formats months', () => {
    expect(formatRelativeTime(new Date(hoursAgoISO(24 * 60)), NOW)).toBe('2mo ago');
  });

  it('handles future timestamps safely', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 5000), NOW)).toBe('just now');
  });
});

describe('ActivityFeed', () => {
  beforeEach(() => {
    mockUsePipelines.mockReset();
    mockUseAccessRequests.mockReset();
  });

  it('renders the heading as a landmark region', () => {
    mockUsePipelines.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<ActivityFeed now={NOW} />);
    expect(screen.getByRole('region', { name: 'Recent activity' })).toBeInTheDocument();
  });

  it('renders a loading state while data is in flight', () => {
    mockUsePipelines.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockUseAccessRequests.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<ActivityFeed now={NOW} />);
    expect(
      screen.getByRole('status', { name: 'Loading activity feed' }),
    ).toBeInTheDocument();
  });

  it('renders an empty message when both feeds have no usable entries', () => {
    mockUsePipelines.mockReturnValue({ data: [], isLoading: false, error: null });
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<ActivityFeed now={NOW} />);
    expect(
      screen.getByText(/No recent pipeline runs or pending access requests/i),
    ).toBeInTheDocument();
  });

  it('renders a merged, desc-sorted feed of pipeline runs and pending requests', () => {
    mockUsePipelines.mockReturnValue({
      data: [
        { id: 'p1', name: 'Finance ETL', status: 'succeeded', last_run_at: hoursAgoISO(1), source_id: 's1', pipeline_type: 'batch' },
        { id: 'p2', name: 'HR ETL', status: 'failed', last_run_at: hoursAgoISO(5), source_id: 's2', pipeline_type: 'batch' },
        { id: 'p3', name: 'No Runs', status: 'created', last_run_at: undefined, source_id: 's3', pipeline_type: 'batch' },
      ],
      isLoading: false,
      error: null,
    });
    mockUseAccessRequests.mockReturnValue({
      data: [
        {
          id: 'a1',
          requester_email: 'jane@contoso.com',
          data_product_id: 'dp-1',
          justification: '...',
          access_level: 'read',
          duration_days: 30,
          status: 'pending',
          requested_at: hoursAgoISO(3),
        },
      ],
      isLoading: false,
      error: null,
    });
    render(<ActivityFeed now={NOW} />);
    const items = screen.getAllByRole('listitem');
    // p3 has no last_run_at so it's excluded. Remaining order by recency:
    // p1 (1h), a1 (3h), p2 (5h).
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Finance ETL')).toBeInTheDocument();
    expect(within(items[1]).getByText(/jane@contoso\.com/)).toBeInTheDocument();
    expect(within(items[2]).getByText('HR ETL')).toBeInTheDocument();
  });

  it('renders relative-time strings alongside ISO timestamps', () => {
    mockUsePipelines.mockReturnValue({
      data: [{ id: 'p1', name: 'Sales', status: 'succeeded', last_run_at: hoursAgoISO(2), source_id: 's', pipeline_type: 'batch' }],
      isLoading: false,
      error: null,
    });
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
    const { container } = render(<ActivityFeed now={NOW} />);
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    const time = container.querySelector('time');
    expect(time).toHaveAttribute('dateTime', hoursAgoISO(2));
  });

  it('caps the list at the configured limit', () => {
    const pipelines = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `Pipeline ${i}`,
      status: 'succeeded' as const,
      last_run_at: hoursAgoISO(i + 1),
      source_id: 's',
      pipeline_type: 'batch' as const,
    }));
    mockUsePipelines.mockReturnValue({ data: pipelines, isLoading: false, error: null });
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<ActivityFeed limit={5} now={NOW} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('renders an error alert when either feed errors out', () => {
    mockUsePipelines.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    mockUseAccessRequests.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<ActivityFeed now={NOW} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load recent activity/i);
  });

  it('links pipeline entries to the pipelines page and access entries to /access', () => {
    mockUsePipelines.mockReturnValue({
      data: [{ id: 'p1', name: 'Sales ETL', status: 'succeeded', last_run_at: hoursAgoISO(1), source_id: 's', pipeline_type: 'batch' }],
      isLoading: false,
      error: null,
    });
    mockUseAccessRequests.mockReturnValue({
      data: [
        {
          id: 'a1',
          requester_email: 'bob@contoso.com',
          data_product_id: 'dp-42',
          justification: '...',
          access_level: 'read',
          duration_days: 30,
          status: 'pending',
          requested_at: hoursAgoISO(2),
        },
      ],
      isLoading: false,
      error: null,
    });
    render(<ActivityFeed now={NOW} />);
    const pipelineLink = screen.getByRole('link', { name: 'Sales ETL' });
    expect(pipelineLink).toHaveAttribute('href', '/pipelines?search=Sales%20ETL');
    const accessLink = screen.getByRole('link', { name: /Access request — bob@contoso\.com/ });
    expect(accessLink).toHaveAttribute('href', '/access?status=pending');
  });
});
