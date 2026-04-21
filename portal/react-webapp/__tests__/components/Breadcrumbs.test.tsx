/**
 * Tests for the Breadcrumbs component (CSA-0124(9)).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/router', () => ({
  useRouter: () => ({
    asPath: '/sources/src-42',
    pathname: '/sources/[id]',
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

import { Breadcrumbs, buildTrailFromPath } from '@/components/Breadcrumbs';

describe('buildTrailFromPath', () => {
  it('returns just the Home leaf for root', () => {
    expect(buildTrailFromPath('/')).toEqual([{ label: 'Home' }]);
  });

  it('builds a chain for a known route', () => {
    const trail = buildTrailFromPath('/sources/register');
    expect(trail).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Sources', href: '/sources' },
      { label: 'Register' },
    ]);
  });

  it('title-cases unknown id segments', () => {
    const trail = buildTrailFromPath('/sources/src-42');
    expect(trail[2]).toEqual({ label: 'Src 42' });
  });

  it('strips query strings and fragments', () => {
    const trail = buildTrailFromPath('/access?product_id=dp-1#top');
    expect(trail).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Access requests' },
    ]);
  });
});

describe('Breadcrumbs', () => {
  it('renders with a navigation landmark labeled Breadcrumb', () => {
    render(<Breadcrumbs path="/sources" />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('renders Home as a link and the current segment with aria-current', () => {
    render(<Breadcrumbs path="/sources" />);
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', '/');
    const current = screen.getByText('Sources');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('derives the trail from the router when path/items are not supplied', () => {
    render(<Breadcrumbs />);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    // router asPath mocks to '/sources/src-42' → leaf "Src 42"
    expect(screen.getByText('Src 42')).toHaveAttribute('aria-current', 'page');
  });

  it('renders an explicit items prop when provided', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Sources', href: '/sources' },
          { label: 'Finance DB' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/sources');
    expect(screen.getByText('Finance DB')).toHaveAttribute('aria-current', 'page');
  });

  it('marks separators as aria-hidden', () => {
    const { container } = render(<Breadcrumbs path="/sources/register" />);
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    // One separator between each of the 3 items → 2 separators.
    expect(separators.length).toBe(2);
  });
});
