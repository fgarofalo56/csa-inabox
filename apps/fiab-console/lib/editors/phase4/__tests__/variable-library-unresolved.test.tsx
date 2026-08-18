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
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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

/**
 * The WHOLE warning banner's text (title + every cause paragraph). The deepest
 * `div` carrying the title is the MessageBarBody — the paragraphs are its
 * children and none of them repeats the title — so this is the full copy the
 * user reads, which is what the "must NOT claim X" assertions need.
 */
function bannerText(root: HTMLElement): string | null {
  const hits = Array.from(root.querySelectorAll('div')).filter(
    (d) => (d.textContent || '').includes('left unresolved'),
  );
  return hits.length ? (hits[hits.length - 1].textContent ?? null) : null;
}

/** The Resolve panel's input, addressed by its placeholder. */
function expandInput(root: HTMLElement): HTMLTextAreaElement {
  return within(root).getByPlaceholderText('@{variables.ENV}/path') as HTMLTextAreaElement;
}

const VL_ITEM = makeItem('variable-library', 'Variable library');

describe('VariableLibraryEditor — unresolved reference warning', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows no unresolved-reference banner on first open of a saved item', async () => {
    // REGRESSION GUARD, not evidence for the production change: the banner is
    // only ever populated by a Resolve click, so this spec passes with the
    // #3575 change reverted. It exists to fail if someone later computes the
    // unresolved set on mount (from `expandText`'s seed value, say), which
    // would put a red banner on a freshly opened item — the exact thing
    // ux-baseline.md's clean-first-open rule forbids. The specs BELOW are the
    // ones that move the verdict.
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

/**
 * The banner may not state a cause the code did not establish
 * (deploy-integrity.md R7).
 *
 * `useItemState` seeds `state` from a CLIENT-SIDE fallback — for this editor
 * the sample rows ENV / BatchSize / EnableCopilot — and a freshly created
 * library's Cosmos document holds `state: {}`. The CRUD GET returns
 * `state: item.state || {}`, so the load takes the `{...fallback, ...{}}`
 * branch: `loadStatus` is 'loaded' and the table renders three variables that
 * have NEVER been persisted. `/resolve` reads Cosmos (loadOwnedItem), not this
 * editor, so it returns an EMPTY resolved set.
 *
 * The banner's evidence is therefore only "X was not in the resolved[] array",
 * which is a strictly weaker fact than "no variable named X exists" — and on
 * every new library the two diverge, putting "No variable named ENV exists"
 * directly underneath a table row named ENV, plus "add them to the table" for
 * rows already in it. Splitting the unresolved names against the LOCAL table is
 * what makes each sentence true. Systemic instance of #3687; fixed here only.
 */
describe('VariableLibraryEditor — unresolved banner states only what it established', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** A freshly created library: Cosmos has the doc but no state yet. */
  const freshLibrary = () => ({ id: 'lib1', displayName: 'Fresh Library', state: {} });

  it('does not claim a variable is absent when the table in front of the user has it', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        // Cosmos state is {} → no variables → nothing resolves and the text
        // comes back byte-identical to what was sent.
        resolved: [],
        expanded: '@{variables.ENV}/batch?size=@{variables.BatchSize}',
      }),
      '/api/items/variable-library/lib1': freshLibrary,
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));

    // Precondition — the unsaved fallback rows really are on screen.
    await waitFor(() => expect(within(main).getByDisplayValue('ENV')).toBeInTheDocument());
    expect(within(main).getByDisplayValue('BatchSize')).toBeInTheDocument();

    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));
    await waitFor(() => expect(bannerText(main)).not.toBeNull());

    // THE REGRESSION: a claim of non-existence about rows the user can see.
    expect(bannerText(main)).not.toContain('No variable named');
    expect(bannerText(main)).not.toMatch(/Add them to the table/i);
    // What the code actually established, and the honest remediation.
    expect(bannerText(main)).toContain('in the table above but not in the saved library');
    expect(within(main).getByText('ENV', { selector: 'code' })).toBeInTheDocument();
    expect(within(main).getByText('BatchSize', { selector: 'code' })).toBeInTheDocument();
    expect(within(main).getByText(/2 variables left unresolved/i)).toBeInTheDocument();
  });

  it('offers Save and resolve as an inline Fix-it, and it actually saves then re-resolves', async () => {
    // ux-baseline.md G2 — a remediation the platform can perform itself must be
    // a button, not a paragraph telling the user to go do it.
    let resolveCalls = 0;
    const { calls } = installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => {
        resolveCalls += 1;
        // First call: nothing saved yet. After the PATCH: the library resolves.
        return resolveCalls === 1
          ? { ok: true, valueSet: 'default', resolved: [], expanded: '@{variables.ENV}/batch?size=@{variables.BatchSize}' }
          : {
            ok: true,
            valueSet: 'default',
            resolved: [
              { name: 'ENV', type: 'string', value: 'dev', secret: false },
              { name: 'BatchSize', type: 'number', value: '5000', secret: false },
              { name: 'EnableCopilot', type: 'bool', value: 'true', secret: false },
            ],
            expanded: 'dev/batch?size=5000',
          };
      },
      '/api/items/variable-library/lib1': freshLibrary,
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));

    const fixIt = await waitFor(() => within(main).getByRole('button', { name: /Save and resolve/i }));
    await user.click(fixIt);

    // It persisted the table…
    await waitFor(() => expect(
      calls.some((c) => c.init?.method === 'PATCH' && c.url.includes('/api/items/variable-library/lib1')),
    ).toBe(true));
    // …then re-ran Resolve, and the warning is gone because the cause is gone.
    await waitFor(() => expect(resolveCalls).toBe(2));
    await waitFor(() => expect(bannerText(main)).toBeNull());
    expect(within(main).getByText('dev/batch?size=5000')).toBeInTheDocument();
  });

  it('keeps the absent-variable wording for a name that is NOT in the table, and re-classifies it once added', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: 'dev/batch?size=@{variables.BatchSize}',
      }),
      // Saved state REPLACES the fallback array wholesale (`{...fallback,
      // ...doc.state}` is a top-level spread), so the local table is [ENV]
      // only — BatchSize is genuinely absent from both table and library.
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Saved Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));
    await waitFor(() => expect(unresolvedBannerText(main)).not.toBeNull());

    // Unchanged copy for the case it was always correct for.
    expect(unresolvedBannerText(main)).toContain('exists in the default value set');
    expect(bannerText(main)).not.toContain('in the table above but not in the saved library');

    // G2 Fix-it: add the row PRE-NAMED. `addRow()`'s generic `varN` would not
    // match the reference and so would not clear the warning.
    await user.click(within(main).getByRole('button', { name: /Add it to the table/i }));
    await waitFor(() => expect(within(main).getByDisplayValue('BatchSize')).toBeInTheDocument());

    // The split is computed at RENDER time, so the banner re-classifies itself:
    // BatchSize is now in the table, so claiming it does not exist would be the
    // very falsehood this fix removes.
    await waitFor(() => expect(bannerText(main)).toContain('in the table above but not in the saved library'));
    expect(bannerText(main)).not.toContain('No variable named');
    expect(within(main).getByRole('button', { name: /Save and resolve/i })).toBeInTheDocument();
  });

  it('reports each cause separately when one Resolve produces a mixed set', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        resolved: [],
        expanded: '@{variables.ENV}-@{variables.Nope}',
      }),
      '/api/items/variable-library/lib1': freshLibrary,
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    await waitFor(() => expect(within(main).getByDisplayValue('ENV')).toBeInTheDocument());

    // ENV is in the (unsaved) table; Nope is in neither table nor library.
    fireEvent.change(expandInput(main), { target: { value: '@{variables.ENV}-@{variables.Nope}' } });
    await user.click(within(main).getByRole('button', { name: /^Resolve$/ }));
    await waitFor(() => expect(bannerText(main)).not.toBeNull());

    const text = bannerText(main) as string;
    expect(text).toContain('2 variables left unresolved');
    // Neither cause may be asserted about the other's name.
    expect(text).toMatch(/ENV\s*is in the table above but not in the saved library/);
    expect(text).toMatch(/No variable named\s*Nope\s*exists in the default value set/);
    // Both Fix-its offered, each for its own group.
    expect(within(main).getByRole('button', { name: /Save and resolve/i })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: /Add it to the table/i })).toBeInTheDocument();
  });

  it('explains a malformed reference instead of echoing the input silently (#3575)', async () => {
    // The Name column is a plain Input, so `Order-Count` is creatable — and
    // `VAR_REF` can never match it. Before this change the strict scanner saw
    // NO reference at all, so `referencedNames` was [], no banner rendered, and
    // input == output with zero signal: the reported symptom verbatim.
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: '@{variables.Order-Count}/x',
      }),
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Saved Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    fireEvent.change(expandInput(main), { target: { value: '@{variables.Order-Count}/x' } });
    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));

    await waitFor(() => expect(bannerText(main)).not.toBeNull());
    const text = bannerText(main) as string;
    expect(within(main).getByText('@{variables.Order-Count}', { selector: 'code' })).toBeInTheDocument();
    expect(text).toContain('is not a valid reference');
    // The remediation must be the TRUE one. Saving or adding a row cannot make
    // this reference expand, so neither may be suggested — that would be the
    // same false-cause defect in a new outfit.
    expect(text).not.toContain('No variable named');
    expect(text).not.toContain('in the table above but not in the saved library');
    expect(within(main).queryByRole('button', { name: /Save and resolve/i })).not.toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: /Add it to the table/i })).not.toBeInTheDocument();
  });

  it('echoes the sigil the user actually wrote', async () => {
    // `VAR_REF` accepts `${…}` as well as `@{…}`. Telling a user who wrote
    // `${variables.Nope}` that their `@{variables.NAME}` reference was left
    // verbatim names a form they never used.
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        valueSet: 'default',
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: '${variables.Nope}',
      }),
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Saved Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={VL_ITEM} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));
    fireEvent.change(expandInput(main), { target: { value: '${variables.Nope}' } });
    await user.click(await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ })));

    await waitFor(() => expect(bannerText(main)).not.toBeNull());
    expect(bannerText(main)).toContain('${variables.NAME}');
    expect(bannerText(main)).not.toContain('@{variables.NAME}');
  });
});
