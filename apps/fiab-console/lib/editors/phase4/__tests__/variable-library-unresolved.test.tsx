/**
 * VariableLibraryEditor — unresolved-reference warning (#3575).
 *
 * `expandVariables()` (lib/variables/resolve.ts) deliberately leaves an
 * unknown `@{variables.NAME}` reference verbatim rather than blanking it —
 * that is correct, documented behavior. The bug #3575 reported was that the
 * UI gave the user ZERO signal this had happened: input equals output with
 * no explanation reads as a broken/no-op Resolve button.
 *
 * These specs prove:
 *   1. A fresh, untouched item shows no unresolved-reference banner on mount
 *      (ux-baseline.md — no error banners on first open).
 *   2. After clicking Resolve against a server-side variable set that is
 *      missing one of the referenced names, the editor surfaces a
 *      MessageBar (intent="warning") naming exactly that missing variable —
 *      computed by diffing `referencedVariableNames()` against the names the
 *      resolve API actually returned, not a new regex.
 *   3. The banner keeps naming the value set the resolve ACTUALLY ran against
 *      even after the user switches tabs. Rendering the live `tab` instead made
 *      it claim a variable is absent from a value set that was never diffed
 *      (deploy-integrity.md R7 — a message states only what the code
 *      established).
 *   4. The banner does not survive a soft-navigation to a different item id.
 *      The editor is NOT remounted on that navigation (no `key={id}` at the
 *      call site), so without an `id`-keyed reset the next library's first open
 *      inherits the previous one's warning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VariableLibraryEditor } from '../variable-library-editor';
import { makeItem, installFetchMock, renderWithProviders } from '../../__tests__/test-helpers';

/**
 * The banner's copy is split across several elements (`<code>` per name, a
 * `<strong>` around the value-set label), so Testing Library's text matchers —
 * which join only an element's DIRECT text-node children — can never see the
 * value-set name. Read the deepest element that carries the sentence instead:
 * `querySelectorAll` is document (pre-)order, so ancestors come first and the
 * LAST hit is the banner body itself.
 */
function unresolvedBannerText(root: HTMLElement): string | null {
  const hits = Array.from(root.querySelectorAll('div')).filter(
    (d) => (d.textContent || '').includes('No variable named'),
  );
  return hits.length ? (hits[hits.length - 1].textContent ?? null) : null;
}

const VL_ITEM = makeItem('variable-library', 'Variable library');

describe('VariableLibraryEditor — unresolved reference warning', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows no unresolved-reference banner on first open of a saved item', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Test Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    renderWithProviders(<VariableLibraryEditor item={makeItem('variable-library', 'Variable library')} id="lib1" />);
    await waitFor(() => expect(screen.getByTestId('main-panel')).toBeInTheDocument());
    expect(screen.queryByText(/left unresolved/i)).not.toBeInTheDocument();
  });

  it('names the specific unresolved variable after Resolve returns a partial set', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        // Server-side set only has ENV — BatchSize (referenced in the default
        // expandText) is absent, so expandVariables() left it verbatim.
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: 'dev/batch?size=@{variables.BatchSize}',
      }),
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Test Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={makeItem('variable-library', 'Variable library')} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));

    // No banner before the user has clicked Resolve.
    expect(within(main).queryByText(/left unresolved/i)).not.toBeInTheDocument();

    const resolveBtn = await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ }));
    await user.click(resolveBtn);

    // "variable", not "reference": the count is de-duplicated NAMES, so
    // `@{variables.X}@{variables.X}` is one, not two.
    await waitFor(() => expect(within(main).getByText(/1 variable left unresolved/i)).toBeInTheDocument());
    expect(within(main).getByText('BatchSize')).toBeInTheDocument();
    // ENV resolved cleanly — it must NOT be reported as unresolved.
    expect(within(main).queryByText(/^ENV$/, { selector: 'code' })).not.toBeInTheDocument();
  });

  it('keeps naming the value set that was actually resolved after the user switches tabs', async () => {
    // The route echoes the value set it validated and resolved against
    // (app/api/items/variable-library/[id]/resolve/route.ts — `{ ok, valueSet,
    // resolved, expanded }`), so the mock echoes the posted one the same way.
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': (_url, init) => {
        const posted = JSON.parse(String((init as any)?.body ?? '{}'));
        return {
          ok: true,
          valueSet: posted.valueSet,
          resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
          expanded: 'dev/batch?size=@{variables.BatchSize}',
        };
      },
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Test Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));

    // Resolve against `dev` — that is the ONLY value set this run diffed.
    await user.click(within(main).getByRole('tab', { name: 'dev' }));
    const resolveBtn = await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ }));
    await user.click(resolveBtn);
    await waitFor(() => expect(unresolvedBannerText(main)).not.toBeNull());
    expect(unresolvedBannerText(main)).toContain('exists in the dev value set');

    // Switching tabs does NOT re-resolve, so the banner must keep naming `dev`.
    // Re-labelling it `prod` would assert a fact about a value set that was
    // never checked (deploy-integrity.md R7 — a message states only what the
    // code established).
    await user.click(within(main).getByRole('tab', { name: 'prod' }));
    await waitFor(() => expect(within(main).getByRole('tab', { name: 'prod' })).toHaveAttribute('aria-selected', 'true'));
    expect(unresolvedBannerText(main)).toContain('exists in the dev value set');
    expect(unresolvedBannerText(main)).not.toContain('exists in the prod value set');
  });

  it('clears the unresolved banner when the editor is reused for a different item id', async () => {
    // app/items/[type]/[id]/page.tsx renders `<Editor item={item} id={id} />`
    // with NO `key={id}`, so a soft-navigation between two items of the same
    // type changes the `id` prop WITHOUT remounting the editor — exactly what
    // this rerender models (same element type, same position). useItemState's
    // own load effect is keyed on `[slug, id]` for that same reason.
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: 'dev/batch?size=@{variables.BatchSize}',
      }),
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'First Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
      '/api/items/variable-library/lib2': () => ({
        id: 'lib2',
        displayName: 'Second Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}><VariableLibraryEditor item={VL_ITEM} id="lib1" /></QueryClientProvider>,
    );
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));
    await waitFor(() => expect(unresolvedBannerText(main)).not.toBeNull());

    // Soft-navigate to a DIFFERENT variable library. Its first open must be
    // clean (ux-baseline.md — no error banners on a freshly opened item):
    // nothing has been resolved for lib2.
    view.rerender(
      <QueryClientProvider client={queryClient}><VariableLibraryEditor item={VL_ITEM} id="lib2" /></QueryClientProvider>,
    );
    await waitFor(() => expect(unresolvedBannerText(screen.getByTestId('main-panel'))).toBeNull());
  });
});
