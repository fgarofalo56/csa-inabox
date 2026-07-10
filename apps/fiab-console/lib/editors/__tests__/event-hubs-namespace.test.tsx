/**
 * EventHubsNamespaceEditor — UX-baseline render test (UX-Wave 2, UX-204).
 *
 * Verifies the shared UX-baseline components adopted in the UX lift render:
 *   - the namespace fetch fires on mount,
 *   - the empty hubs list shows the SC-4 GuidedEmptyState (not a bare banner),
 *   - the Overview tab renders the SC-2 DetailsPanel with the copyable
 *     namespace endpoint URI.
 * Backend wiring is unchanged (mocked /api/items/event-hubs-namespace).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { EventHubsNamespaceEditor } from '../event-hubs-namespace-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

describe('EventHubsNamespaceEditor — UX baseline', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/event-hubs-namespace': () => ({
        ok: true,
        namespace: {
          name: 'ehns-loom',
          location: 'eastus2',
          sku: 'Standard',
          provisioningState: 'Succeeded',
          minimumTlsVersion: '1.2',
          disableLocalAuth: true,
          serviceBusEndpoint: 'https://ehns-loom.servicebus.windows.net:443/',
        },
        hubs: [],
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches the namespace on mount and shows the guided empty state for hubs', async () => {
    renderWithProviders(<EventHubsNamespaceEditor item={makeItem('event-hubs-namespace', 'Event Hubs')} id="ehns" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/event-hubs-namespace'))).toBe(true);
    });
    // SC-4 GuidedEmptyState — a guided launcher, not a bare MessageBar.
    expect(await screen.findByText(/Create your first event hub/i)).toBeInTheDocument();
    expect(screen.getByText(/partitioned append-only log/i)).toBeInTheDocument();
  });

  it('renders the details panel with the copyable endpoint on the Overview tab', async () => {
    renderWithProviders(<EventHubsNamespaceEditor item={makeItem('event-hubs-namespace', 'Event Hubs')} id="ehns" />);
    const overviewTab = await screen.findByRole('tab', { name: /Overview/i });
    fireEvent.click(overviewTab);
    // SC-2 DetailsPanel — title + copyable namespace endpoint URI.
    expect(await screen.findByText(/Namespace details/i)).toBeInTheDocument();
    // Assert the full endpoint URI exactly (anchored) rather than a loose
    // host substring — a partial host regex on a URL is an incomplete
    // URL-substring check (CodeQL js/incomplete-url-substring-sanitization).
    expect(screen.getByText('https://ehns-loom.servicebus.windows.net:443/')).toBeInTheDocument();
  });
});
