/**
 * RumPanel — silent-failure regression (loom-apex A3, page-errors.md #3).
 *
 * Before the fix, `fetchRum` THREW on a transport failure (clientFetch reject:
 * network / 20 s timeout) and the panel destructured only {data, isLoading} —
 * so the toolbar rendered and the body went silently blank. This spec pins
 * the honest branch: the transport failure is caught into the structured
 * FetchState.error shape and rendered as the "Could not load RUM telemetry"
 * intent="error" MessageBar with a Retry action.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { RumPanel } from '../rum-panel';

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <RumPanel />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RumPanel transport-failure honesty (A3)', () => {
  it('renders the error MessageBar with Retry — not a blank body — when the RUM fetch rejects', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/admin/rum')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load RUM telemetry')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The failure state must not be dressed as "no telemetry yet".
    expect(screen.queryByText(/No real-user telemetry yet/i)).toBeNull();
  });

  it('recovers to real telemetry when Retry succeeds', async () => {
    let first = true;
    const rum = {
      capture: { envEnabled: true, flagEnabled: true, sampleRate: 100 },
      loads: { views: 12, p50Ms: 900, p95Ms: 2200 },
      routeChanges: 4,
      errorCount: 0,
      vitals: { samples: 3, lcpP75Ms: 2000, fcpP75Ms: 1500, ttfbP75Ms: 600, clsP75: 0.05, inpP75Ms: 150 },
      trend: [],
      surfaces: [],
      errors: [],
    };
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/admin/rum')) {
        if (first) {
          first = false;
          throw new TypeError('Failed to fetch');
        }
        return new Response(JSON.stringify({ ok: true, rum }), {
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
      expect(screen.getByText('Could not load RUM telemetry')).toBeInTheDocument(),
    );
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByText('Page loads')).toBeInTheDocument());
    expect(screen.queryByText('Could not load RUM telemetry')).toBeNull();
  });
});
