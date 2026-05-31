/**
 * PowerAppEditor — Vitest contract test.
 *
 * Renders the editor with minimal props and asserts the editor chrome
 * mounts and surfaces at least one real ribbon action button. Network
 * calls are caught by a no-op fetch mock so the editor's mount-time
 * fetches resolve with ok:true.
 *
 * Two harness facts this spec depends on (see vitest.setup.ts):
 *   1. ItemEditorChrome is mocked into a thin shell exposing
 *      data-testid="chrome" / "ribbon" and flattening every ribbon action
 *      into a <button aria-label={action.label}>. So we assert against
 *      those testids + a real action label, not the live Fluent chrome.
 *   2. The editor uses `useQuery` (@tanstack/react-query) and therefore —
 *      exactly like the real app (app/providers.tsx) — must mount inside a
 *      QueryClientProvider. The previous version of this spec rendered the
 *      editor bare, so it threw "No QueryClient set" and only "passed" via
 *      its error-swallowing catch. This version mounts it for real.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this keeps power-app at
 * A-grade (functional + Vitest) with a meaningful, non-no-op assertion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerAppEditor } from '../powerplatform-editors';
import { makeItem, installFetchMock } from './test-helpers';

function renderWithQuery(ui: React.ReactElement) {
  // Mirror app/providers.tsx; disable retries so a failed mock query does
  // not keep refetching in the background after the test asserts.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('PowerAppEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Unmount explicitly so a prior render's DOM does not
  // leak into the next test.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon action button', async () => {
    renderWithQuery(<PowerAppEditor item={makeItem('power-app', 'Power App')} id="new" />);

    // The editor chrome mounts.
    await waitFor(
      () => expect(screen.getByTestId('chrome')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    // The ribbon region is present and carries at least one button.
    const ribbon = screen.getByTestId('ribbon');
    const ribbonButtons = ribbon.querySelectorAll('button');
    expect(ribbonButtons.length).toBeGreaterThan(0);

    // baseRibbon (powerplatform-editors.tsx) always wires a real "Reload"
    // action, so the editor surfaces a concrete, current ribbon control.
    // Scope to the ribbon — the editor's main pane renders its own Reload
    // button too, so a global byRole query is ambiguous.
    const reload = Array.from(ribbonButtons).find(
      (b) => /reload/i.test(b.getAttribute('aria-label') || b.textContent || ''),
    );
    expect(reload).toBeDefined();
  });
});
