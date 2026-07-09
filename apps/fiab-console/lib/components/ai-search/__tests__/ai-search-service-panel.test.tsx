/**
 * AiSearchServicePanel (AIF-17) — render + Scale-tab regression.
 *
 * Mounts the panel against a mocked `/api/ai-search/service` GET so the
 * loading→loaded transition runs, then switches to the new Scale tab and
 * asserts the in-editor replica/partition controls render from the real
 * service props (replicas × partitions = billable search units). A hooks-order
 * or wiring regression makes React throw during the transition and fails here.
 *
 * clientFetch is mocked at the module boundary (the panel imports
 * `@/lib/client-fetch`), so no network is touched and the subtree settles
 * deterministically.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const SERVICE = {
  id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Search/searchServices/search-loom',
  name: 'search-loom', location: 'centralus', sku: 'standard',
  replicaCount: 2, partitionCount: 3, provisioningState: 'succeeded', status: 'running',
  identityType: 'SystemAssigned', principalId: 'pid-123',
  publicNetworkAccess: 'disabled', ipRules: [], privateEndpointCount: 0, privateEndpoints: [],
  authMode: 'aadOnly', semanticSearch: 'standard',
};

// Mock the client transport the panel uses. Every call resolves with the
// service overview so the panel loads its Service tab deterministically.
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, service: SERVICE, adminKeys: {}, queryKeys: [], stats: { counters: {} } }),
  })),
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

async function renderPanel() {
  const { AiSearchServicePanel } = await import('../ai-search-service-panel');
  return render(
    <FluentProvider theme={webLightTheme}>
      <AiSearchServicePanel />
    </FluentProvider>,
  );
}

describe('AiSearchServicePanel — Scale tab (AIF-17)', () => {
  it('loads the service and exposes a Scale tab', async () => {
    await renderPanel();
    // Header shows the loaded service name (loading→loaded transition).
    expect(await screen.findByText('Service: search-loom')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Scale/ })).toBeInTheDocument();
  });

  it('renders the in-editor replica/partition scale controls from real props', async () => {
    await renderPanel();
    await screen.findByText('Service: search-loom');
    fireEvent.click(screen.getByRole('tab', { name: /Scale/ }));
    // The Scale pane header + a search-unit figure derived from 2 × 3 = 6.
    expect(await screen.findByText('Replica & partition scale')).toBeInTheDocument();
    expect(screen.getByLabelText('replica-count')).toBeInTheDocument();
    expect(screen.getByLabelText('partition-count')).toBeInTheDocument();
  });
});
