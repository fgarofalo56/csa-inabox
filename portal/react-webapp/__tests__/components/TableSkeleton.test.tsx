/**
 * Tests for the shared TableSkeleton component (CSA-0124(10)).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TableSkeleton } from '@/components/TableSkeleton';
import { SourcesTableSkeleton } from '@/components/SourcesTableSkeleton';

describe('TableSkeleton', () => {
  it('renders the configured columns as headers', () => {
    render(<TableSkeleton columns={['Name', 'Type', 'Status']} rows={3} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('renders the requested number of body rows', () => {
    const { container } = render(
      <TableSkeleton columns={['A', 'B']} rows={4} />,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(4);
  });

  it('defaults to 5 rows when rows prop is omitted', () => {
    const { container } = render(<TableSkeleton columns={['A']} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(5);
  });

  it('exposes the configured aria-label on the status region', () => {
    render(
      <TableSkeleton
        columns={['A']}
        rows={2}
        ariaLabel="Loading widgets"
      />,
    );
    expect(
      screen.getByRole('status', { name: 'Loading widgets' }),
    ).toBeInTheDocument();
  });

  it('falls back to a generic aria-label when not provided', () => {
    render(<TableSkeleton columns={['A']} rows={1} />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });

  it('uses scope="col" on headers for screen-reader column association', () => {
    const { container } = render(
      <TableSkeleton columns={['A', 'B']} rows={1} />,
    );
    const ths = container.querySelectorAll('th');
    ths.forEach((th) => expect(th).toHaveAttribute('scope', 'col'));
  });
});

describe('SourcesTableSkeleton (wrapper)', () => {
  it('keeps the "Loading sources" accessible name for backward compat', () => {
    render(<SourcesTableSkeleton rows={2} />);
    expect(
      screen.getByRole('status', { name: 'Loading sources' }),
    ).toBeInTheDocument();
  });

  it('renders the canonical source columns', () => {
    render(<SourcesTableSkeleton rows={1} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Classification')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });
});
