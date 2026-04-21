/**
 * Tests for the EmptyState component (CSA-0124(2)).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

import { EmptyState } from '@/components/EmptyState';

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders the description when provided', () => {
    render(
      <EmptyState title="Empty" description="No data yet, come back later." />,
    );
    expect(
      screen.getByText('No data yet, come back later.'),
    ).toBeInTheDocument();
  });

  it('exposes a status role for assistive tech', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a Link CTA when action.href is provided', () => {
    render(
      <EmptyState
        title="Empty"
        action={{ label: 'Create one', href: '/new' }}
      />,
    );
    const link = screen.getByRole('link', { name: 'Create one' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/new');
  });

  it('renders a button CTA when action.onClick is provided', () => {
    const onClick = jest.fn();
    render(
      <EmptyState
        title="Empty"
        action={{ label: 'Reload', onClick }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not render a CTA when action is omitted', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('marks the decorative icon as hidden from assistive tech', () => {
    const { container } = render(<EmptyState title="Empty" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
