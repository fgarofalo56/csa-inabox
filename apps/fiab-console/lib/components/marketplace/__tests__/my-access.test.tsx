/**
 * MyAccess (UX-707) — render smoke after the UX-baseline lift.
 *
 * Mounts the pane against a mocked clientFetch that returns one API
 * subscription and one data-product access request, then asserts the elevated
 * section cards + TeachingBanner render and the real backend rows show. A
 * hooks-order / wiring regression from the card refactor fails here.
 *
 * clientFetch is mocked at the module boundary so no network is touched.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async (url: string) => {
    if (url.includes('/api/marketplace/subscriptions')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, subscriptions: [{ id: 'sub-1', displayName: 'Orders API', productName: 'Gold', state: 'active' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, requests: [{ id: 'r-1', productId: 'p-1', summary: 'Customer 360', requestedAt: '2026-07-01T00:00:00Z', permission: 'read', status: 'pending' }] }) };
  }),
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

async function renderPane() {
  const { MyAccess } = await import('../my-access');
  return render(
    <FluentProvider theme={webLightTheme}>
      <MyAccess />
    </FluentProvider>,
  );
}

describe('MyAccess — UX-baseline lift (UX-707)', () => {
  it('renders both section cards with real backend rows and the teaching banner', async () => {
    await renderPane();
    expect(await screen.findByText('Orders API')).toBeInTheDocument();
    expect(await screen.findByText('Customer 360')).toBeInTheDocument();
    expect(screen.getByText('API subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Data-product access requests')).toBeInTheDocument();
    // Teaching banner lead line from the lift.
    expect(screen.getByText('Everything you can use')).toBeInTheDocument();
  });
});
