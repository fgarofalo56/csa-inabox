/**
 * /workload-hub — silent-failure regression (loom-apex A3, page-errors.md #6).
 *
 * Before the fix, `.catch(() => setCatalog([]))` rendered a failed
 * GET /api/workloads-catalog as a hub with no tenant enablements and no hint
 * anything went wrong. This spec pins the honest partial-data branch: the
 * registry-derived workloads still render (partial data is kept), AND an
 * intent="error" MessageBar with Retry names the failed catalog overlay.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import WorkloadHubPage from '../page';

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <WorkloadHubPage />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('/workload-hub transport-failure honesty (A3)', () => {
  it('keeps rendering registry workloads but surfaces an error MessageBar with Retry when the catalog overlay rejects', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/workloads-catalog')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load the tenant workload catalog')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // Partial data survives: the registry-derived hub still renders.
    expect(screen.getByText('My workloads')).toBeInTheDocument();
  });

  it('clears the error after Retry succeeds', async () => {
    let first = true;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/workloads-catalog')) {
        if (first) {
          first = false;
          throw new TypeError('Failed to fetch');
        }
        return new Response(JSON.stringify({ workloads: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as any;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load the tenant workload catalog')).toBeInTheDocument(),
    );
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() =>
      expect(screen.queryByText('Could not load the tenant workload catalog')).toBeNull(),
    );
    expect(screen.getByText('My workloads')).toBeInTheDocument();
  });
});
