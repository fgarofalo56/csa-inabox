/**
 * ServiceBusNamespaceEditor — vitest render + UX-baseline (SC-2/SC-4/SC-6/SC-9).
 *
 * Verifies the editor mounts, exposes ribbon actions, renders the SC-6 teaching
 * banner, shows the SC-4 guided empty state on the empty Queues tab, and renders
 * the SC-2 DetailsPanel (copyable endpoint URI) on the Overview tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ServiceBusNamespaceEditor } from '../service-bus-namespace-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('ServiceBusNamespaceEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/service-bus-namespace': () => ({
        ok: true,
        namespace: {
          name: 'sb-fixture', location: 'eastus2', sku: 'Standard', tier: 'Standard',
          status: 'Active', provisioningState: 'Succeeded',
          endpoint: 'sb://sb-fixture.servicebus.windows.net/', disableLocalAuth: false,
          minimumTlsVersion: '1.2',
        },
        queues: [],
        topics: [],
      }),
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome and the teaching banner', async () => {
    render(<ServiceBusNamespaceEditor item={makeItem('service-bus-namespace', 'Service Bus namespace')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
    expect(document.querySelector('[data-teaching-banner="service-bus-messaging"]')).toBeTruthy();
  });

  it('shows the SC-4 guided empty state on the empty Queues tab', async () => {
    render(<ServiceBusNamespaceEditor item={makeItem('service-bus-namespace', 'Service Bus namespace')} id="new" />);
    await waitFor(() => {
      expect(document.querySelector('[data-guided-empty-state]')).toBeTruthy();
    });
    expect(document.querySelector('[data-launch-card="queue"]')).toBeTruthy();
  });

  it('renders the SC-2 DetailsPanel with the copyable endpoint on Overview', async () => {
    render(<ServiceBusNamespaceEditor item={makeItem('service-bus-namespace', 'Service Bus namespace')} id="new" />);
    await waitFor(() => { expect(screen.getAllByText('Service Bus namespace').length).toBeGreaterThan(0); });
    // Switch to the Overview tab.
    fireEvent.click(screen.getByRole('tab', { name: /Overview/i }));
    await waitFor(() => {
      expect(screen.getByText('sb://sb-fixture.servicebus.windows.net/')).toBeInTheDocument();
    });
    // Copyable URI row exposes a Copy affordance (DetailsPanel contract).
    expect(screen.getByRole('button', { name: /Copy Namespace endpoint/i })).toBeInTheDocument();
  });
});
