/**
 * Shared helpers for editor Vitest specs.
 *
 * Each spec mounts an editor, mocks `global.fetch`, and exercises at
 * least one primary action. These helpers keep the per-spec boilerplate
 * minimal.
 */
import React from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { expect, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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

/**
 * Pick `value` in a native `<select>` (Fluent `Select`) whose `<option>`s are
 * populated by an in-flight fetch. Waits for the OPTION, then fires the change,
 * then asserts the selection actually took.
 *
 * WHY THIS EXISTS — the #2834 flake.
 *
 * Every workspace/resource picker in the console renders its `<Select>`
 * IMMEDIATELY, disabled, carrying only a "Loading…" placeholder `<option>`, and
 * fills in the real options when the fetch resolves:
 *
 *     <Select disabled={(workspaces?.length ?? 0) === 0}>
 *       {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : …}</option>}
 *       {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
 *     </Select>
 *
 * So `findByRole('combobox')` resolves as soon as the PLACEHOLDER exists —
 * which can be well before the option you actually want to pick is in the DOM.
 * Waiting on the fetch *call* (`calls.some(c => c.url.includes(…))`) does not
 * help either: that only proves the request was issued, not that its response
 * was applied to state and re-rendered.
 *
 * Assigning a value with no matching `<option>` is a SILENT no-op in jsdom
 * (`selectedIndex` → -1, `value` → ''), so the synthetic change event carries
 * '' and the component's state never advances. The spec then fails much later
 * and very confusingly — in #2834 as `expected null to be truthy` on the
 * lakehouse-shortcut guided empty state, three panels downstream of the real
 * problem. It failed 3/3 under full-suite load and passed 3/3 in isolation,
 * because contention is what lets the render lose the race.
 *
 * Waiting for the option removes the race outright: there is no timing constant
 * to tune, only "the data has arrived". The post-assert turns any future
 * regression into a precise failure HERE rather than a mystery downstream.
 */
export async function selectOptionValue(select: HTMLSelectElement, value: string): Promise<void> {
  await waitFor(() => {
    expect(
      Array.from(select.options).some((o) => o.value === value),
      `<option value="${value}"> never rendered — the list backing this <select> did not load`,
    ).toBe(true);
  });
  fireEvent.change(select, { target: { value } });
  expect(select.value, `selecting "${value}" did not take`).toBe(value);
}
