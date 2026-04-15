/**
 * Tests for the Button component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Button } from '@/components/Button';

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('applies primary variant styles by default', () => {
    render(<Button>Primary</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-brand-600');
  });

  it('applies secondary variant styles', () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-gray-100');
  });

  it('applies danger variant styles', () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-red-600');
  });

  it('applies ghost variant styles', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('text-gray-600');
  });

  it('handles click events', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when loading prop is true', () => {
    render(<Button loading>Loading</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows spinner when loading', () => {
    const { container } = render(<Button loading>Loading</Button>);
    const spinner = container.querySelector('svg.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('applies size variants', () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('h-8');
  });

  it('merges custom className', () => {
    render(<Button className="custom-class">Styled</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('custom-class');
  });
});
