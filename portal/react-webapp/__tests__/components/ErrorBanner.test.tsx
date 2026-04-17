/**
 * Tests for the ErrorBanner component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ErrorBanner from '@/components/ErrorBanner';

describe('ErrorBanner', () => {
  it('renders the default title when none is provided', () => {
    render(<ErrorBanner message="Something broke" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders a custom title', () => {
    render(<ErrorBanner title="Load failed" message="Network error" />);
    expect(screen.getByText('Load failed')).toBeInTheDocument();
  });

  it('renders the error message', () => {
    render(<ErrorBanner message="Connection timed out" />);
    expect(screen.getByText('Connection timed out')).toBeInTheDocument();
  });

  it('renders a Retry button when onRetry is provided', () => {
    const handleRetry = jest.fn();
    render(<ErrorBanner message="Error" onRetry={handleRetry} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not render a Retry button when onRetry is omitted', () => {
    render(<ErrorBanner message="Error" />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('calls onRetry when the Retry button is clicked', () => {
    const handleRetry = jest.fn();
    render(<ErrorBanner message="Error" onRetry={handleRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an SVG error icon', () => {
    const { container } = render(<ErrorBanner message="Error" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });
});
