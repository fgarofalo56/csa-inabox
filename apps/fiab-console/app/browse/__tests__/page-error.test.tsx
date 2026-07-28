/**
 * /browse — silent-failure regression (loom-apex A3, page-errors.md #5).
 *
 * Before the fix, `.catch(() => setWorkspaces([]))` rendered a failed
 * GET /api/workspaces as "0 workspaces" + the guided "No workspaces yet"
 * empty state — the exact dead-data-path class of the 2026-07-15 live
 * incident (ux-standards §9 G1). This spec pins the honest error branch:
 * an intent="error" MessageBar with Retry, no guided empty state, and
 * recovery to real rows after Retry succeeds (partial data — pins/recent —
 * keeps rendering throughout).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import BrowsePage from '../page';

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <BrowsePage />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('/browse transport-failure honesty (A3)', () => {
  it('renders an error MessageBar with Retry — not the "No workspaces yet" empty state — when /api/workspaces rejects', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/workspaces')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Could not load workspaces')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No workspaces yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers to the real workspace list when Retry succeeds', async () => {
    // Phase-controlled mock (several /browse children ALSO fetch
    // /api/workspaces, so a consume-one-rejection flag would be racy):
    // every workspace fetch rejects until the test flips `failing` off,
    // then every fetch returns the real list.
    let failing = true;
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url === '/api/workspaces' || url.endsWith('/api/workspaces')) {
        if (failing) throw new TypeError('Failed to fetch');
        return new Response(
          JSON.stringify({ workspaces: [{ id: 'ws-1', name: 'Recovered workspace' }] }),
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
      expect(screen.getByText('Could not load workspaces')).toBeInTheDocument(),
    );
    failing = false;
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() =>
      expect(screen.getByText('Recovered workspace')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Could not load workspaces')).toBeNull();
  });
});
