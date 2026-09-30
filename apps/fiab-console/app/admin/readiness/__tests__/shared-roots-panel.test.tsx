/**
 * /admin/readiness — the "Lakehouses sharing a storage root" check renders its
 * groups with the "Keep root for <lakehouse>" action, and a completed keep
 * re-runs the readiness evaluation.
 *
 * The panel itself is tested in
 * `lib/components/admin/__tests__/lakehouse-shared-roots-panel.test.tsx`. This
 * file pins the WIRE between the page and the panel: the page is the only place
 * an admin reaches the action, so a page that stops rendering the panel leaves
 * the check with no way to act on it, and every panel test still passes.
 *
 * A DOM assertion is a regression pin for one wire, not a browser receipt.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/readiness',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminReadinessPage from '../page';

const CHECK_ID = 'lakehouse-shared-roots';

const GROUP = {
  ids: ['lh-a', 'lh-b'],
  roots: ['bronze/lakehouses/Sales'],
  members: [
    { id: 'lh-a', name: 'Sales', workspaceId: 'ws-1', href: '/items/lakehouse/lh-a', recorded: true, recycled: false },
    { id: 'lh-b', name: 'Sales copy', workspaceId: 'ws-2', href: '/items/lakehouse/lh-b', recorded: false, recycled: false },
  ],
};

function readiness(groups?: unknown[]) {
  return {
    ok: true,
    generatedAt: '2026-09-29T08:00:00Z',
    cloud: 'Commercial',
    capabilities: [],
    workloads: [],
    summary: {
      capabilities: { ready: 0, partial: 0, blocked: 0, unknown: 0, total: 0 },
      workloads: { ready: 0, partial: 0, blocked: 0, total: 0 },
      score: 0,
      configOnly: 0,
    },
    storageChecks: [{
      id: CHECK_ID,
      title: 'Lakehouses sharing a storage root',
      status: 'warn',
      detail: '1 shared storage root(s) across 2 lakehouse(s) (of 2 checked).',
      ...(groups ? { groups } : {}),
    }],
  };
}

/** The deploy banner is not under test: it shows its own 'unavailable' state. */
const DEPLOY = { '/api/admin/deploy-status': () => ({ ok: false, error: 'not under test' }) };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('/admin/readiness shared storage roots', () => {
  // FAILS IF the page does not render the panel for a check that carries
  // groups: the "Keep root for Sales" button would be absent from the check's
  // MessageBar.
  it('renders each group with its keep action inside the check', async () => {
    installFetchMock({ ...DEPLOY, '/api/admin/readiness': () => readiness([GROUP]) });
    renderWithProviders(<AdminReadinessPage />);
    const bar = await screen.findByTestId(`readiness-storage-check-${CHECK_ID}`);
    await waitFor(() => expect(within(bar).getByTestId('lakehouse-shared-roots-panel')).toBeInTheDocument());
    expect(within(bar).getByRole('button', { name: 'Keep root for Sales' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Keep root for Sales copy' })).toBeInTheDocument();
  });

  // Paired control: a check with no groups renders its text and no panel.
  // FAILS IF the panel is rendered unconditionally.
  it('renders no panel for a check without groups', async () => {
    installFetchMock({ ...DEPLOY, '/api/admin/readiness': () => readiness() });
    renderWithProviders(<AdminReadinessPage />);
    const bar = await screen.findByTestId(`readiness-storage-check-${CHECK_ID}`);
    expect(bar.textContent).toContain('1 shared storage root(s)');
    expect(within(bar).queryByTestId('lakehouse-shared-roots-panel')).toBeNull();
  });

  // FAILS IF a completed keep does not re-run the evaluation with a fresh
  // probe: no `/api/admin/readiness?refresh=1` request after the POST, so the
  // resolved group would stay on screen until a manual refresh.
  it('re-runs the readiness evaluation after a keep', async () => {
    const { calls } = installFetchMock({
      ...DEPLOY,
      '/api/admin/readiness': () => readiness([GROUP]),
      '/api/admin/lakehouse-roots/keep': () => ({
        ok: true,
        kept: { name: 'Sales', container: 'bronze', root: 'lakehouses/Sales' },
        reassigned: [{ id: 'lh-b', name: 'Sales copy', container: 'landing', root: 'lakehouses/Sales copy--lh-b' }],
        failed: [],
      }),
    });
    renderWithProviders(<AdminReadinessPage />);
    const bar = await screen.findByTestId(`readiness-storage-check-${CHECK_ID}`);
    fireEvent.click(await within(bar).findByRole('button', { name: 'Keep root for Sales' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep root' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/admin/readiness?refresh=1'))).toBe(true));
    const keepIdx = calls.findIndex((c) => c.url.includes('/api/admin/lakehouse-roots/keep'));
    const reloadIdx = calls.findIndex((c) => c.url.includes('/api/admin/readiness?refresh=1'));
    expect(keepIdx).toBeGreaterThanOrEqual(0);
    expect(reloadIdx).toBeGreaterThan(keepIdx);
    expect(JSON.parse(String(calls[keepIdx].init?.body))).toEqual({ itemId: 'lh-a' });
  });
});
