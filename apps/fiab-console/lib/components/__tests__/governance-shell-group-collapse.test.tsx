/**
 * #5467 — the Governance sidebar gets the same per-group collapse as Admin.
 *
 * Breaking inputs: a no-op header onClick (aria-expanded stays "true", the
 * Lineage link stays in the tree); a hook writing the wrong storage key (the
 * remount reopens the group / the admin key is written); a dropped force-open
 * effect (the active Lineage link stays hidden under a persisted collapse).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactNode } from 'react';

let mockPathname = '/governance';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/components/page-shell', () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/session-context', () => ({ useIsTenantAdmin: () => true }));
vi.mock('@/lib/components/ui/learn-popover', () => ({
  SectionExplainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { GovernanceShell, GOVERNANCE_GROUP_COLLAPSE_LS_KEY } from '../governance-shell';
import { NAV_COLLAPSE_LS_KEY } from '../nav-collapse';
import { ADMIN_GROUP_COLLAPSE_LS_KEY } from '../admin-shell';
import { GOVERNANCE_SECTIONS } from '@/lib/nav/governance-sections';

const LINEAGE_HREF = '/governance/lineage';
const LINEAGE_GROUP = GOVERNANCE_SECTIONS.find((g) => g.items.some((i) => i.href === LINEAGE_HREF))!.label;
const OVERVIEW_GROUP = GOVERNANCE_SECTIONS.find((g) => g.items.some((i) => i.href === '/governance'))!.label;

const ui = () => (
  <FluentProvider theme={webLightTheme}>
    <GovernanceShell><div>body</div></GovernanceShell>
  </FluentProvider>
);
const visibleHrefs = () => screen.queryAllByRole('link').map((a) => a.getAttribute('href'));
const header = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => {
  localStorage.clear();
  mockPathname = '/governance';
});

describe('GovernanceShell — per-group collapse (#5467)', () => {
  it('fixture: the lineage link and the overview link live in different groups', () => {
    expect(LINEAGE_GROUP).toBeTruthy();
    expect(LINEAGE_GROUP).not.toBe(OVERVIEW_GROUP);
  });

  it('toggling a group header hides its items and flips aria-expanded', () => {
    render(ui());
    const btn = header(LINEAGE_GROUP);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(visibleHrefs()).toContain(LINEAGE_HREF);

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(visibleHrefs()).not.toContain(LINEAGE_HREF);
    expect(visibleHrefs()).toContain('/governance');
  });

  it('persists across a remount under its own key', () => {
    const first = render(ui());
    fireEvent.click(header(LINEAGE_GROUP));
    first.unmount();

    expect(JSON.parse(localStorage.getItem(GOVERNANCE_GROUP_COLLAPSE_LS_KEY) ?? '{}')).toEqual({ [LINEAGE_GROUP]: true });
    expect(localStorage.getItem(NAV_COLLAPSE_LS_KEY)).toBeNull();
    expect(localStorage.getItem(ADMIN_GROUP_COLLAPSE_LS_KEY)).toBeNull();

    render(ui());
    expect(header(LINEAGE_GROUP)).toHaveAttribute('aria-expanded', 'false');
    expect(visibleHrefs()).not.toContain(LINEAGE_HREF);
  });

  it('forces the active page group open even when persisted collapsed', () => {
    localStorage.setItem(GOVERNANCE_GROUP_COLLAPSE_LS_KEY, JSON.stringify({ [LINEAGE_GROUP]: true, [OVERVIEW_GROUP]: true }));
    mockPathname = LINEAGE_HREF;
    render(ui());
    expect(header(LINEAGE_GROUP)).toHaveAttribute('aria-expanded', 'true');
    expect(visibleHrefs()).toContain(LINEAGE_HREF);
    // Control: the persisted map was applied to the non-active group.
    expect(header(OVERVIEW_GROUP)).toHaveAttribute('aria-expanded', 'false');
  });

  it('Collapse all / Expand all act on every group', () => {
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all groups' }));
    expect(visibleHrefs()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all groups' }));
    expect(visibleHrefs()).toContain(LINEAGE_HREF);
    expect(header(LINEAGE_GROUP)).toHaveAttribute('aria-expanded', 'true');
  });
});
