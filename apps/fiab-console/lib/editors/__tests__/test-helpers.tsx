/**
 * Shared helpers for editor Vitest specs.
 *
 * Each spec mounts an editor, mocks `global.fetch`, and exercises at
 * least one primary action. These helpers keep the per-spec boilerplate
 * minimal.
 */
import React from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import type { RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function makeItem(slug: string, displayName: string): FabricItemType {
  return {
    slug,
    displayName,
    restType: displayName.replace(/\s+/g, ''),
    category: 'Data Engineering',
    description: `${displayName} test fixture`,
  };
}

/**
 * Render `ui` wrapped in a fresh TanStack QueryClientProvider so components
 * that call useQuery / useMutation don't throw "No QueryClient set".
 *
 * The QueryClient is configured for tests:
 *   - queries: retry=false, gcTime=0  (no background cache noise)
 *   - mutations: retry=false
 *
 * All other render options (wrapper, queries, etc.) pass through to
 * @testing-library/react `render`.
 */
export function renderWithProviders(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    options,
  );
}

/** Install a fetch mock keyed by URL substring. Returns the spy + call log. */
export function installFetchMock(handlers: Record<string, (url: string, init?: RequestInit) => unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url?.toString?.() ?? String(url));
    calls.push({ url: u, init });
    // Pick the longest matching key so /api/foo/bar wins over /api/foo
    const keys = Object.keys(handlers).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (u.includes(key)) {
        const body = handlers[key](u, init);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fetchMock as any);
  return { fetchMock, calls };
}
