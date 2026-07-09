/**
 * ItemTabStrip + ToolbarCrossLinks (SC-8) — vitest jsdom render + contract
 * tests. next/navigation.useRouter is stubbed globally in vitest.setup.ts.
 *
 * Verifies the Fabric item-tab-strip contract (Eventhouse | Database switch)
 * and the RTI toolbar cross-links group (routing-only sibling links + overflow
 * collapse).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  ItemTabStrip, ToolbarCrossLinks,
  type ItemTab, type CrossLink,
} from '../item-tab-strip';

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

const tabs: ItemTab[] = [
  { key: 'eventhouse', label: 'Eventhouse' },
  { key: 'database', label: 'Database', badge: 3 },
];

describe('ItemTabStrip', () => {
  it('renders item-level tabs with a badge and marks the selected tab', () => {
    wrap(<ItemTabStrip tabs={tabs} selectedKey="eventhouse" />);
    const selected = screen.getByRole('tab', { name: /Eventhouse/ });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    // Fluent's Tab renders a hidden reserved-space duplicate of its content, so
    // the badge text appears more than once in the DOM — assert at least one.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('calls onSelect with the tab key when a tab is clicked', () => {
    const onSelect = vi.fn();
    wrap(<ItemTabStrip tabs={tabs} selectedKey="eventhouse" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: /Database/ }));
    expect(onSelect).toHaveBeenCalledWith('database');
  });
});

const rtiLinks: CrossLink[] = [
  { key: 'live', label: 'Live view', href: '/items/kql-database/abc' },
  { key: 'query', label: 'Query with code', href: '/items/kql-database/abc?tab=query' },
  { key: 'queryset', label: 'KQL Queryset', href: '/items/kql-queryset/new' },
  { key: 'notebook', label: 'Notebook', href: '/items/notebook/new' },
  { key: 'dashboard', label: 'Real-Time Dashboard', href: '/items/kql-dashboard/new' },
  { key: 'agent', label: 'Data Agent', href: '/items/data-agent/new' },
  { key: 'ops', label: 'Operations Agent', href: '/items/operations-agent/new' },
  { key: 'onelake', label: 'OneLake', href: '/onelake' },
];

describe('ToolbarCrossLinks', () => {
  it('renders inline links up to maxInline and collapses the rest into More', () => {
    wrap(<ToolbarCrossLinks links={rtiLinks} maxInline={6} ariaLabel="Real-Time Intelligence surfaces" />);
    expect(screen.getByRole('toolbar', { name: 'Real-Time Intelligence surfaces' })).toBeInTheDocument();
    // First six are inline; the overflow "More" button holds the remainder.
    expect(screen.getByRole('button', { name: 'Live view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More related surfaces' })).toBeInTheDocument();
    // A link past the cut is not inline until the overflow menu opens.
    expect(screen.queryByRole('button', { name: 'OneLake' })).not.toBeInTheDocument();
  });

  it('fires the caller onClick for a cross-link', () => {
    const onClick = vi.fn();
    wrap(<ToolbarCrossLinks links={[{ key: 'go', label: 'Analyze data with', onClick, primary: true }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze data with' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a disabled honest-gate link with a tooltip', () => {
    wrap(<ToolbarCrossLinks links={[{ key: 'g', label: 'Real-Time Dashboard', disabled: true, tooltip: 'Create a KQL database first' }]} />);
    const btn = screen.getByRole('button', { name: 'Real-Time Dashboard' });
    expect(btn).toBeDisabled();
  });
});
