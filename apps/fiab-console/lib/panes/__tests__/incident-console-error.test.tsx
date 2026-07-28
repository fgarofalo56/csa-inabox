/**
 * IncidentConsole — silent-failure regression (loom-apex A3, page-errors.md #4).
 *
 * Before the fix, a TRANSPORT failure on GET /api/observability/incidents
 * (clientFetch reject: network / 20 s timeout) fell through
 * `listQ.data?.incidents || []` into the "No incidents — all monitored tables
 * are healthy" EmptyState — an outage rendered as green (the 2026-07-15 G1
 * 0-count class). These specs pin the honest error branch: an intent="error"
 * MessageBar with a Retry action, and NO healthy EmptyState.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { IncidentConsole } from '../incident-console';

/** Route fetch by URL: reject the incidents list, answer everything else ok. */
function installRejectingFetch(rejectSubstring: string) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    if (url.includes(rejectSubstring)) {
      throw new TypeError('Failed to fetch');
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  });
}

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <IncidentConsole />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IncidentConsole transport-failure honesty (A3)', () => {
  it('renders an error MessageBar with Retry — NOT the all-healthy EmptyState — when the list fetch rejects', async () => {
    installRejectingFetch('/api/observability/incidents');
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load incidents')).toBeInTheDocument(),
    );
    // The failure must never be dressed up as health.
    expect(
      screen.queryByText(/No incidents — all monitored tables are healthy/i),
    ).toBeNull();
    // And it must offer a retry affordance.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers to real data when Retry succeeds', async () => {
    // First call rejects; subsequent calls return one real incident.
    let first = true;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/observability/incidents')) {
        if (first) {
          first = false;
          throw new TypeError('Failed to fetch');
        }
        return new Response(
          JSON.stringify({
            ok: true,
            incidents: [{
              id: 'inc-1', status: 'open', severity: 'error', source: 'monitor',
              itemId: 'i1', itemType: 'lakehouse', table: 'sales.orders',
              monitorKind: 'freshness', title: 'Freshness SLA tripped',
              detail: 'Data is stale', occurrences: 1,
              openedAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z',
              timeline: [{ at: '2026-07-27T00:00:00Z', type: 'opened', by: 'monitor' }],
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as any;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load incidents')).toBeInTheDocument(),
    );
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() =>
      expect(screen.getByText('Freshness SLA tripped')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Could not load incidents')).toBeNull();
  });
});
