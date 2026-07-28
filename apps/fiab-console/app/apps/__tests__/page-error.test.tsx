/**
 * /apps — silent-failure regression (loom-apex A3, page-errors.md #7).
 *
 * Before the fix, `.catch(() => setApps([]))` rendered a failed
 * GET /api/apps-catalog as "No apps in this tenant yet" (+ seed-script hint)
 * — an outage dressed up as an empty catalog. This spec pins the honest
 * error branch: intent="error" MessageBar with Retry, no misleading empty
 * state, and recovery after Retry succeeds.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import AppsPage from '../page';

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <AppsPage />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('/apps transport-failure honesty (A3)', () => {
  it('renders an error MessageBar with Retry — not "No apps in this tenant yet" — when /api/apps-catalog rejects', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/apps-catalog')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load the apps catalog')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No apps in this tenant yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers to the real catalog when Retry succeeds', async () => {
    let first = true;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/apps-catalog')) {
        if (first) {
          first = false;
          throw new TypeError('Failed to fetch');
        }
        return new Response(
          JSON.stringify({
            apps: [{ id: 'app-1', name: 'Recovered app', category: 'Analytics', items: [] }],
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
      expect(screen.getByText('Could not load the apps catalog')).toBeInTheDocument(),
    );
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() =>
      expect(screen.getByText('Recovered app')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Could not load the apps catalog')).toBeNull();
  });
});
