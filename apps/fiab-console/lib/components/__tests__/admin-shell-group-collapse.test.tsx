/**
 * #5467 — per-group expand/collapse in the Admin portal sidebar.
 *
 * Each assertion names the input that breaks it:
 *   - toggle: a header whose onClick does nothing leaves `aria-expanded="true"`
 *     and the FinOps link in the accessibility tree.
 *   - persistence: a hook that ignores its storage key (writes the main left
 *     nav's NAV_COLLAPSE_LS_KEY) or never reads back on mount reopens the group.
 *   - active group: dropping the force-open effect leaves the persisted
 *     "collapsed" in force, so the current page's link is hidden.
 *   - icon rail: rendering group headers (or honouring per-group collapse) in
 *     the rail adds aria-expanded buttons / hides icons.
 *
 * `queryAllByRole('link')` excludes elements under a `hidden` ancestor, so a
 * collapsed group's links drop out of it — that is the "hidden" being pinned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactNode } from 'react';

let mockPathname = '/admin/health';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/components/page-shell', () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/ui/learn-popover', () => ({ LearnPopover: () => null }));

import { AdminShell, ADMIN_GROUP_COLLAPSE_LS_KEY } from '../admin-shell';
import { NAV_COLLAPSE_LS_KEY } from '../nav-collapse';
import { ADMIN_SECTIONS } from '@/lib/nav/admin-sections';

const CAPACITY = 'Capacity & cost';
const RELIABILITY = 'Reliability & performance';

function ui() {
  return (
    <FluentProvider theme={webLightTheme}>
      <AdminShell><div>body</div></AdminShell>
    </FluentProvider>
  );
}
const mount = () => render(ui());
const visibleHrefs = () => screen.queryAllByRole('link').map((a) => a.getAttribute('href'));
const header = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => {
  localStorage.clear();
  mockPathname = '/admin/health';
});

describe('AdminShell — per-group collapse (#5467)', () => {
  it('fixture: the groups the tests use exist and hold the hrefs they assume', () => {
    // If the registry regroups these, every test below would be aimed at
    // nothing — fail here with the reason instead.
    const cap = ADMIN_SECTIONS.find((g) => g.label === CAPACITY);
    const rel = ADMIN_SECTIONS.find((g) => g.label === RELIABILITY);
    expect(cap?.items.map((i) => i.href)).toContain('/admin/finops');
    expect(rel?.items.map((i) => i.href)).toContain('/admin/health');
  });

  it('toggling a group header hides its items and flips aria-expanded; other groups stay open', async () => {
    mount();
    const btn = header(CAPACITY);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const regionId = btn.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(document.getElementById(regionId!)).not.toBeNull();
    expect(visibleHrefs()).toContain('/admin/finops');

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(visibleHrefs()).not.toContain('/admin/finops');
    expect(document.getElementById(regionId!)).toHaveAttribute('hidden');
    // Positive pair: only the toggled group folded.
    expect(visibleHrefs()).toContain('/admin/health');

    // Keyboard: Enter re-opens it (native <button> activation).
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(visibleHrefs()).toContain('/admin/finops');
  });

  it('persists across a remount under its OWN key, never the main left nav key', () => {
    const first = mount();
    fireEvent.click(header(CAPACITY));
    first.unmount();

    expect(JSON.parse(localStorage.getItem(ADMIN_GROUP_COLLAPSE_LS_KEY) ?? '{}')).toEqual({ [CAPACITY]: true });
    expect(localStorage.getItem(NAV_COLLAPSE_LS_KEY)).toBeNull();
    expect(ADMIN_GROUP_COLLAPSE_LS_KEY).not.toBe(NAV_COLLAPSE_LS_KEY);

    mount();
    expect(header(CAPACITY)).toHaveAttribute('aria-expanded', 'false');
    expect(visibleHrefs()).not.toContain('/admin/finops');
    expect(header(RELIABILITY)).toHaveAttribute('aria-expanded', 'true');
  });

  it('defaults to every group expanded', () => {
    mount();
    for (const g of ADMIN_SECTIONS) {
      expect(header(g.label)).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('forces the active page group open on load even when persisted collapsed', () => {
    localStorage.setItem(ADMIN_GROUP_COLLAPSE_LS_KEY, JSON.stringify({ [CAPACITY]: true, [RELIABILITY]: true }));
    mockPathname = '/admin/finops';
    mount();
    expect(header(CAPACITY)).toHaveAttribute('aria-expanded', 'true');
    expect(visibleHrefs()).toContain('/admin/finops');
    // Control: the persisted map WAS applied — a non-active group stays folded.
    // Without this, a hook that never hydrated would pass the line above.
    expect(header(RELIABILITY)).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a collapsed group when navigation lands inside it', () => {
    localStorage.setItem(ADMIN_GROUP_COLLAPSE_LS_KEY, JSON.stringify({ [CAPACITY]: true }));
    const r = mount();
    expect(header(CAPACITY)).toHaveAttribute('aria-expanded', 'false');

    mockPathname = '/admin/finops';
    r.rerender(ui());
    expect(header(CAPACITY)).toHaveAttribute('aria-expanded', 'true');
    expect(visibleHrefs()).toContain('/admin/finops');
  });

  it('Collapse all folds every group; Expand all opens every group', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all groups' }));
    for (const g of ADMIN_SECTIONS) {
      expect(header(g.label)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(visibleHrefs()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all groups' }));
    for (const g of ADMIN_SECTIONS) {
      expect(header(g.label)).toHaveAttribute('aria-expanded', 'true');
    }
    const total = ADMIN_SECTIONS.reduce((n, g) => n + g.items.length, 0);
    expect(visibleHrefs()).toHaveLength(total);
  });

  it('icon-rail mode is unchanged: no group headers, every icon shown, dividers kept', () => {
    localStorage.setItem(ADMIN_GROUP_COLLAPSE_LS_KEY, JSON.stringify({ [CAPACITY]: true }));
    mount();
    expect(screen.getAllByRole('button', { expanded: true }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(screen.queryByRole('button', { name: CAPACITY })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse all groups' })).toBeNull();
    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(0);
    // A persisted per-group collapse must not hide rail icons.
    expect(visibleHrefs()).toContain('/admin/finops');
    // Hairline dividers: every group after the first carries a class, the first none.
    const groups = screen.getAllByRole('group').filter((g) => ADMIN_SECTIONS.some((s) => s.label === g.getAttribute('aria-label')));
    expect(groups).toHaveLength(ADMIN_SECTIONS.length);
    expect(groups[0].className).toBe('');
    expect(groups[1].className).not.toBe('');
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });
});
